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

func TestReadWSMessageReassemblesMaskedUTF8Fragments(t *testing.T) {
	var wire bytes.Buffer
	wire.Write(maskedClientFrame(false, 0x1, []byte("안")))
	wire.Write(maskedClientFrame(false, 0x0, []byte("녕")))
	wire.Write(maskedClientFrame(true, 0x0, []byte("하세요")))
	opcode, payload, err := readWSMessage(bufio.NewReader(&wire))
	if err != nil || opcode != 0x1 || string(payload) != "안녕하세요" {
		t.Fatalf("opcode=%x payload=%q err=%v", opcode, payload, err)
	}
}

func TestReadWSRawFrameRejectsProtocolSmuggling(t *testing.T) {
	// A 1-byte payload encoded with the 16-bit length form is non-minimal.
	nonMinimal := []byte{0x81, 0xFE, 0x00, 0x01, 1, 2, 3, 4, 'x' ^ 1}
	if _, err := readWSRawFrame(bufio.NewReader(bytes.NewReader(nonMinimal))); err == nil {
		t.Fatal("non-minimal length encoding accepted")
	}
	// Control frames may never be fragmented.
	if _, err := readWSRawFrame(bufio.NewReader(bytes.NewReader(maskedClientFrame(false, 0x9, nil)))); err == nil {
		t.Fatal("fragmented ping accepted")
	}
}

func maskedClientFrame(fin bool, opcode byte, payload []byte) []byte {
	first := opcode
	if fin {
		first |= 0x80
	}
	mask := [4]byte{1, 2, 3, 4}
	frame := []byte{first, 0x80 | byte(len(payload))}
	frame = append(frame, mask[:]...)
	for index, value := range payload {
		frame = append(frame, value^mask[index%4])
	}
	return frame
}
