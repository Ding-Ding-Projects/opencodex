package parity_test

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestTypeScriptAndGoResponsesWebSocketMultiTurnFrames(t *testing.T) {
	upstream := newDifferentialUpstream(t)
	config := differentialConfig(upstream.server.URL, []string{"success"})
	config["websockets"] = true
	tsProxy := startTypeScriptProxy(t, config)
	goProxy := startProxyWithConfig(t, config)
	goSocket := dialParityWebSocket(t, goProxy.baseURL, "/v1/responses", nil)
	tsSocket := dialParityWebSocket(t, tsProxy.baseURL, "/v1/responses", nil)

	for turn := 0; turn < 6; turn++ {
		frame := map[string]any{
			"type": "response.create", "model": "differential/success", "input": []any{map[string]any{"role": "user", "content": "turn"}}, "generate": false,
		}
		if err := goSocket.WriteJSON(frame); err != nil {
			t.Fatal(err)
		}
		if err := tsSocket.WriteJSON(frame); err != nil {
			t.Fatal(err)
		}
		goFrames := readParityWebSocketFrames(t, goSocket, 2)
		tsFrames := readParityWebSocketFrames(t, tsSocket, 2)
		compareRuntimeBytes(t, "websocket/responses-warmup-multiturn",
			runtimeResponse{status: http.StatusOK, body: bytes.Join(goFrames, []byte("\n"))},
			runtimeResponse{status: http.StatusOK, body: bytes.Join(tsFrames, []byte("\n"))}, true)
	}

	generated := map[string]any{"type": "response.create", "model": "differential/success", "input": "generated turn"}
	if err := goSocket.WriteJSON(generated); err != nil {
		t.Fatal(err)
	}
	if err := tsSocket.WriteJSON(generated); err != nil {
		t.Fatal(err)
	}
	goFrames := readUntilWebSocketTerminal(t, goSocket)
	tsFrames := readUntilWebSocketTerminal(t, tsSocket)
	compareRuntimeBytes(t, "websocket/responses-generated-stream",
		runtimeResponse{status: http.StatusOK, body: bytes.Join(goFrames, []byte("\n"))},
		runtimeResponse{status: http.StatusOK, body: bytes.Join(tsFrames, []byte("\n"))}, true)
}

func TestBuiltBinaryLiveSidebandFrameRelay(t *testing.T) {
	var observationsMu sync.Mutex
	observations := []string{}
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		connection, err := upgrader.Upgrade(writer, request, nil)
		if err != nil {
			return
		}
		defer connection.Close()
		observationsMu.Lock()
		observations = append(observations, request.URL.Path+"|"+request.Header.Get("Authorization"))
		observationsMu.Unlock()
		for {
			kind, payload, readErr := connection.ReadMessage()
			if readErr != nil {
				return
			}
			if writeErr := connection.WriteMessage(kind, payload); writeErr != nil {
				return
			}
		}
	}))
	t.Cleanup(upstream.Close)
	config := map[string]any{
		"port": 0, "hostname": "127.0.0.1", "defaultProvider": "live-parity", "websockets": true,
		"providers": map[string]any{"live-parity": map[string]any{
			"adapter": "openai-responses", "baseUrl": upstream.URL + "/v1", "allowPrivateNetwork": true,
			"apiKey": "synthetic-live-key", "authMode": "key", "defaultModel": "gpt-live", "models": []string{"gpt-live"},
		}},
	}
	goProxy := startProxyWithConfig(t, config)
	goSocket := dialParityWebSocket(t, goProxy.baseURL, "/v1/live/parity-call", nil)

	frames := []struct {
		kind    int
		payload []byte
	}{{websocket.TextMessage, []byte("안녕하세요 live 🚀")}, {websocket.BinaryMessage, []byte{0, 1, 0xff, 0x80, 0x41}}}
	for _, frame := range frames {
		if err := goSocket.WriteMessage(frame.kind, frame.payload); err != nil {
			t.Fatal(err)
		}
		kind, echoed, err := goSocket.ReadMessage()
		if err != nil {
			t.Fatal(err)
		}
		if kind != frame.kind || !bytes.Equal(echoed, frame.payload) {
			t.Fatalf("live sideband frame changed: kind=%d bytes=%x", kind, echoed)
		}
	}
	observationsMu.Lock()
	defer observationsMu.Unlock()
	if len(observations) != 1 {
		t.Fatalf("live upstream handshakes=%d", len(observations))
	}
	for _, observation := range observations {
		if observation != "/v1/live/parity-call|Bearer synthetic-live-key" {
			t.Fatalf("live upstream route/auth mismatch: %q", observation)
		}
	}
}

func TestTypeScriptLiveSidebandLocalFixtureBoundary(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("TypeScript must reject a routed local provider before opening a live sideband")
	}))
	t.Cleanup(upstream.Close)
	config := map[string]any{
		"port": 0, "hostname": "127.0.0.1", "defaultProvider": "live-parity", "websockets": true,
		"providers": map[string]any{"live-parity": map[string]any{
			"adapter": "openai-responses", "baseUrl": upstream.URL + "/v1", "allowPrivateNetwork": true,
			"apiKey": "synthetic-live-key", "authMode": "key", "defaultModel": "gpt-live", "models": []string{"gpt-live"},
		}},
	}
	tsProxy := startTypeScriptProxy(t, config)
	endpoint := "ws" + strings.TrimPrefix(tsProxy.baseURL, "http") + "/v1/live/parity-call"
	connection, response, err := websocket.DefaultDialer.Dial(endpoint, nil)
	if connection != nil {
		_ = connection.Close()
	}
	if err == nil || response == nil {
		t.Fatalf("TypeScript unexpectedly accepted routed local live sideband: err=%v", err)
	}
	defer response.Body.Close()
	payload, _ := io.ReadAll(response.Body)
	if response.StatusCode != http.StatusBadRequest || !bytes.Contains(payload, []byte("Routed providers cannot serve voice call-create")) {
		t.Fatalf("TypeScript local live fixture boundary status=%d body=%s", response.StatusCode, payload)
	}
}

func dialParityWebSocket(t *testing.T, baseURL, path string, headers http.Header) *websocket.Conn {
	t.Helper()
	endpoint := "ws" + strings.TrimPrefix(baseURL, "http") + path
	connection, response, err := websocket.DefaultDialer.Dial(endpoint, headers)
	if err != nil {
		detail := ""
		if response != nil && response.Body != nil {
			payload, _ := io.ReadAll(response.Body)
			detail = " status=" + response.Status + " body=" + string(payload)
			_ = response.Body.Close()
		}
		t.Fatalf("dial websocket %s: %v%s", endpoint, err, detail)
	}
	connection.SetReadLimit(16 << 20)
	if err := connection.SetReadDeadline(time.Now().Add(10 * time.Second)); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = connection.Close() })
	return connection
}

func readParityWebSocketFrames(t *testing.T, connection *websocket.Conn, count int) [][]byte {
	t.Helper()
	frames := make([][]byte, 0, count)
	for len(frames) < count {
		kind, payload, err := connection.ReadMessage()
		if err != nil {
			t.Fatal(err)
		}
		if kind != websocket.TextMessage {
			t.Fatalf("responses websocket emitted non-text frame %d", kind)
		}
		frames = append(frames, payload)
	}
	return frames
}

func readUntilWebSocketTerminal(t *testing.T, connection *websocket.Conn) [][]byte {
	t.Helper()
	frames := make([][]byte, 0, 8)
	for len(frames) < 64 {
		frame := readParityWebSocketFrames(t, connection, 1)[0]
		frames = append(frames, frame)
		if bytes.Contains(frame, []byte(`"type":"response.completed"`)) || bytes.Contains(frame, []byte(`"type":"response.failed"`)) || bytes.Contains(frame, []byte(`"type":"response.incomplete"`)) {
			return frames
		}
	}
	t.Fatal("responses websocket did not emit a terminal frame")
	return nil
}
