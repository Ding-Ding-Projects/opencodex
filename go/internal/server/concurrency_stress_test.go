package server

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestLiveSidebandConcurrentClients(t *testing.T) {
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
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
		return LiveRelayTarget{ProviderBaseURL: upstream.URL + "/v1"}, nil
	})
	proxy := httptest.NewServer(handler)
	defer proxy.Close()

	runConcurrentWebSockets(t, 24, func(client int) error {
		endpoint := "ws" + strings.TrimPrefix(proxy.URL, "http") + fmt.Sprintf("/v1/live/call_%d", client)
		connection, _, err := websocket.DefaultDialer.Dial(endpoint, nil)
		if err != nil {
			return err
		}
		defer connection.Close()
		_ = connection.SetReadDeadline(time.Now().Add(3 * time.Second))
		_ = connection.SetWriteDeadline(time.Now().Add(3 * time.Second))
		payload := []byte(fmt.Sprintf("client-%d-안녕", client))
		if err := connection.WriteMessage(websocket.TextMessage, payload); err != nil {
			return err
		}
		kind, echoed, err := connection.ReadMessage()
		if err != nil {
			return err
		}
		if kind != websocket.TextMessage || string(echoed) != string(payload) {
			return fmt.Errorf("echo kind=%d payload=%q", kind, echoed)
		}
		return nil
	})
}

func TestResponsesWebSocketBridgeConcurrentWarmups(t *testing.T) {
	var requests atomic.Int32
	proxy := httptest.NewServer(WebSocketBridge(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		http.Error(w, "unexpected warmup dispatch", http.StatusInternalServerError)
	})))
	defer proxy.Close()
	endpoint := "ws" + strings.TrimPrefix(proxy.URL, "http")
	runConcurrentWebSockets(t, 32, func(client int) error {
		connection, _, err := websocket.DefaultDialer.Dial(endpoint, nil)
		if err != nil {
			return err
		}
		defer connection.Close()
		_ = connection.SetReadDeadline(time.Now().Add(3 * time.Second))
		_ = connection.SetWriteDeadline(time.Now().Add(3 * time.Second))
		if err := connection.WriteJSON(map[string]any{"type": "response.create", "model": fmt.Sprintf("model-%d", client), "generate": false}); err != nil {
			return err
		}
		for _, expected := range []string{"response.created", "response.completed"} {
			var frame struct {
				Type string `json:"type"`
			}
			if err := connection.ReadJSON(&frame); err != nil {
				return err
			}
			if frame.Type != expected {
				return fmt.Errorf("frame type = %q, want %q", frame.Type, expected)
			}
		}
		return nil
	})
	if requests.Load() != 0 {
		t.Fatalf("warmup dispatched %d requests", requests.Load())
	}
}

func runConcurrentWebSockets(t *testing.T, clients int, run func(int) error) {
	t.Helper()
	start := make(chan struct{})
	errors := make(chan error, clients)
	var wait sync.WaitGroup
	for client := 0; client < clients; client++ {
		wait.Add(1)
		go func(client int) {
			defer wait.Done()
			<-start
			if err := run(client); err != nil {
				errors <- fmt.Errorf("client %d: %w", client, err)
			}
		}(client)
	}
	close(start)
	wait.Wait()
	close(errors)
	for err := range errors {
		t.Error(err)
	}
}
