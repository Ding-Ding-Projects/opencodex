package server

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

const liveSidebandMessageLimit int64 = 16 << 20

type gorillaLiveSocket struct{ connection *websocket.Conn }

func (socket *gorillaLiveSocket) Receive(context.Context) (LiveFrame, error) {
	messageType, payload, err := socket.connection.ReadMessage()
	if err != nil {
		var closeError *websocket.CloseError
		if errors.As(err, &closeError) && (closeError.Code == websocket.CloseNormalClosure || closeError.Code == websocket.CloseGoingAway || closeError.Code == websocket.CloseNoStatusReceived) {
			return LiveFrame{}, io.EOF
		}
		return LiveFrame{}, err
	}
	switch messageType {
	case websocket.TextMessage:
		return LiveFrame{Kind: LiveFrameText, Payload: payload}, nil
	case websocket.BinaryMessage:
		return LiveFrame{Kind: LiveFrameBinary, Payload: payload}, nil
	default:
		return LiveFrame{}, fmt.Errorf("unsupported websocket message type %d", messageType)
	}
}

func (socket *gorillaLiveSocket) Send(ctx context.Context, frame LiveFrame) error {
	messageType := websocket.BinaryMessage
	if frame.Kind == LiveFrameText {
		messageType = websocket.TextMessage
	}
	deadline := time.Now().Add(30 * time.Second)
	if value, ok := ctx.Deadline(); ok && value.Before(deadline) {
		deadline = value
	}
	if err := socket.connection.SetWriteDeadline(deadline); err != nil {
		return err
	}
	return socket.connection.WriteMessage(messageType, frame.Payload)
}

func (socket *gorillaLiveSocket) Close(cause error) error {
	code, text := websocket.CloseNormalClosure, ""
	if cause != nil && !errors.Is(cause, io.EOF) && !errors.Is(cause, context.Canceled) {
		code, text = websocket.CloseInternalServerErr, "relay closed"
	}
	_ = socket.connection.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(code, text), time.Now().Add(time.Second))
	return socket.connection.Close()
}

type LiveSidebandHandler struct {
	Resolve     LiveRelayResolver
	Dialer      *websocket.Dialer
	Upgrader    websocket.Upgrader
	Observer    LiveFrameObserver
	CheckOrigin func(*http.Request) bool
}

func NewLiveSidebandHandler(resolve LiveRelayResolver) *LiveSidebandHandler {
	return &LiveSidebandHandler{
		Resolve:  resolve,
		Dialer:   &websocket.Dialer{HandshakeTimeout: 30 * time.Second, EnableCompression: false},
		Upgrader: websocket.Upgrader{ReadBufferSize: 32 << 10, WriteBufferSize: 32 << 10, EnableCompression: false},
	}
}

func (handler *LiveSidebandHandler) ServeHTTP(w http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.Resolve == nil {
		writeJSONError(w, http.StatusServiceUnavailable, "server_not_configured", "live sideband relay is not configured")
		return
	}
	target, ok := ParseLiveSidebandTarget(request.URL.Path, request.URL.Query())
	if !ok {
		writeJSONError(w, http.StatusBadRequest, "invalid_request_error", "invalid live sideband target")
		return
	}
	relay, err := handler.Resolve(request.Context(), request.Header.Clone())
	if err != nil {
		writeJSONError(w, http.StatusUnauthorized, "authentication_error", err.Error())
		return
	}
	plan, err := ResolveLiveSidebandPlan(relay, target, request.Header)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid_request_error", err.Error())
		return
	}
	dialer := handler.Dialer
	if dialer == nil {
		dialer = websocket.DefaultDialer
	}
	upstreamConnection, response, err := dialer.DialContext(request.Context(), plan.URL, plan.Headers)
	if err != nil {
		status := http.StatusBadGateway
		if response != nil && response.StatusCode >= 400 && response.StatusCode <= 599 {
			status = response.StatusCode
			if response.Body != nil {
				_ = response.Body.Close()
			}
		}
		writeJSONError(w, status, "upstream_error", "live sideband upstream handshake failed")
		return
	}
	upstreamConnection.SetReadLimit(liveSidebandMessageLimit)
	upgrader := handler.Upgrader
	upgrader.CheckOrigin = func(r *http.Request) bool {
		if handler.CheckOrigin != nil {
			return handler.CheckOrigin(r)
		}
		origin := strings.TrimSpace(r.Header.Get("Origin"))
		return origin == "" || IsLoopbackOriginValue(origin) || IsSameOriginAsRequest(r, origin)
	}
	clientConnection, err := upgrader.Upgrade(w, request, nil)
	if err != nil {
		_ = upstreamConnection.Close()
		return
	}
	clientConnection.SetReadLimit(liveSidebandMessageLimit)
	clientSocket := &gorillaLiveSocket{connection: clientConnection}
	upstreamSocket := &gorillaLiveSocket{connection: upstreamConnection}
	_ = RelayLiveSideband(request.Context(), clientSocket, upstreamSocket, handler.Observer)
}

var _ LiveSocket = (*gorillaLiveSocket)(nil)
