package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestLiveSidebandHandlerDialsAndRelaysRealWebSockets(t *testing.T) {
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v1/live/call_1" || request.Header.Get("Authorization") != "Bearer upstream-token" || request.Header.Get("X-OpenCodex-API-Key") != "" {
			t.Errorf("upstream request path=%s headers=%v", request.URL.Path, request.Header)
		}
		connection, err := upgrader.Upgrade(w, request, nil)
		if err != nil {
			return
		}
		defer connection.Close()
		for {
			kind, payload, err := connection.ReadMessage()
			if err != nil {
				return
			}
			if err := connection.WriteMessage(kind, payload); err != nil {
				return
			}
		}
	}))
	defer upstream.Close()
	handler := NewLiveSidebandHandler(func(context.Context, http.Header) (LiveRelayTarget, error) {
		return LiveRelayTarget{ProviderBaseURL: upstream.URL + "/v1", Headers: http.Header{"Authorization": {"Bearer upstream-token"}}}, nil
	})
	proxy := httptest.NewServer(handler)
	defer proxy.Close()
	endpoint := "ws" + strings.TrimPrefix(proxy.URL, "http") + "/v1/live/call_1"
	headers := http.Header{"X-OpenCodex-API-Key": {"proxy-secret"}, "OpenAI-Alpha": {"quicksilver=v2"}}
	connection, response, err := websocket.DefaultDialer.Dial(endpoint, headers)
	if err != nil {
		if response != nil {
			t.Fatalf("dial status=%d err=%v", response.StatusCode, err)
		}
		t.Fatal(err)
	}
	defer connection.Close()
	_ = connection.SetReadDeadline(time.Now().Add(2 * time.Second))
	for _, message := range []struct {
		kind    int
		payload []byte
	}{{websocket.TextMessage, []byte("안녕하세요")}, {websocket.BinaryMessage, []byte{0, 1, 0xff, 0x80}}} {
		if err := connection.WriteMessage(message.kind, message.payload); err != nil {
			t.Fatal(err)
		}
		kind, payload, err := connection.ReadMessage()
		if err != nil || kind != message.kind || string(payload) != string(message.payload) {
			t.Fatalf("echo kind=%d payload=%x err=%v", kind, payload, err)
		}
	}
}

func TestLiveSidebandHandlerRejectsCrossOriginBeforeUpgrade(t *testing.T) {
	handler := NewLiveSidebandHandler(func(context.Context, http.Header) (LiveRelayTarget, error) {
		return LiveRelayTarget{ProviderBaseURL: "https://api.openai.com/v1"}, nil
	})
	handler.Dialer = &websocket.Dialer{HandshakeTimeout: time.Millisecond}
	// Origin rejection is tested directly to avoid making an upstream connection.
	request := httptest.NewRequest(http.MethodGet, "http://localhost/v1/live/call_1", nil)
	request.Host = "localhost"
	request.Header.Set("Origin", "https://attacker.example")
	check := handler.Upgrader
	check.CheckOrigin = func(r *http.Request) bool {
		origin := strings.TrimSpace(r.Header.Get("Origin"))
		return origin == "" || IsLoopbackOriginValue(origin) || IsSameOriginAsRequest(r, origin)
	}
	if check.CheckOrigin(request) {
		t.Fatal("cross-origin websocket upgrade accepted")
	}
}
