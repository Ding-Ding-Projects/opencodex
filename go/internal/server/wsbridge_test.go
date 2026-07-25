package server

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestWebSocketBridgeValidatesHandshakeBeforeHijack(t *testing.T) {
	handler := WebSocketBridge(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	request := httptest.NewRequest(http.MethodGet, "/v1/responses/ws", nil)
	request.Header.Set("Upgrade", "websocket")
	request.Header.Set("Connection", "Upgrade")
	request.Header.Set("Sec-WebSocket-Key", base64.StdEncoding.EncodeToString(make([]byte, 16)))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUpgradeRequired || response.Header().Get("Sec-WebSocket-Version") != "13" {
		t.Fatalf("response=%d headers=%v", response.Code, response.Header())
	}
}

func TestReadWSFrameRejectsFragmentedFrames(t *testing.T) {
	_, _, err := readWSFrame(bufio.NewReader(bytes.NewBuffer([]byte{0x01, 0x80, 0, 0, 0, 0})))
	if err == nil {
		t.Fatal("fragmented frame was accepted")
	}
}
