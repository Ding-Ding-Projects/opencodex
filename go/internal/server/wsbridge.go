package server

import (
	"bufio"
	"bytes"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"unicode/utf8"
)

const websocketGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

// WebSocketBridge accepts text frames, executes them as /v1/responses JSON requests, and returns response text frames.
func WebSocketBridge(target http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if target == nil {
			writeJSONError(w, http.StatusServiceUnavailable, "server_not_configured", "responses handler is not configured")
			return
		}
		if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") || !strings.Contains(strings.ToLower(r.Header.Get("Connection")), "upgrade") {
			http.Error(w, "websocket upgrade required", http.StatusUpgradeRequired)
			return
		}
		key := strings.TrimSpace(r.Header.Get("Sec-WebSocket-Key"))
		decodedKey, keyErr := base64.StdEncoding.DecodeString(key)
		if keyErr != nil || len(decodedKey) != 16 {
			http.Error(w, "missing websocket key", http.StatusBadRequest)
			return
		}
		if r.Header.Get("Sec-WebSocket-Version") != "13" {
			w.Header().Set("Sec-WebSocket-Version", "13")
			http.Error(w, "unsupported websocket version", http.StatusUpgradeRequired)
			return
		}
		hijacker, ok := w.(http.Hijacker)
		if !ok {
			http.Error(w, "websocket unsupported", http.StatusNotImplemented)
			return
		}
		conn, rw, err := hijacker.Hijack()
		if err != nil {
			return
		}
		defer conn.Close()
		digest := sha1.Sum([]byte(key + websocketGUID))
		_, _ = fmt.Fprintf(rw, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n", base64.StdEncoding.EncodeToString(digest[:]))
		_ = rw.Flush()
		for {
			opcode, payload, err := readWSMessage(rw.Reader)
			if err != nil {
				return
			}
			switch opcode {
			case 0x8:
				_ = writeWSFrame(rw.Writer, 0x8, nil)
				_ = rw.Flush()
				return
			case 0x9:
				_ = writeWSFrame(rw.Writer, 0xA, payload)
				_ = rw.Flush()
				continue
			case 0x1:
				if !utf8.Valid(payload) {
					_ = writeWSFrame(rw.Writer, 0x8, []byte{0x03, 0xEF})
					_ = rw.Flush()
					return
				}
				var frame map[string]any
				if json.Unmarshal(payload, &frame) != nil {
					continue
				}
				frameType, _ := frame["type"].(string)
				if frameType == "response.processed" || frameType != "response.create" {
					continue
				}
				if generate, ok := frame["generate"].(bool); ok && !generate {
					for _, responseFrame := range BuildWarmupCompletionFrames(frame) {
						if err := writeWSFrame(rw.Writer, 0x1, responseFrame); err != nil {
							return
						}
					}
					if err := rw.Flush(); err != nil {
						return
					}
					continue
				}
				delete(frame, "type")
				frame["stream"] = true
				requestBody, err := json.Marshal(frame)
				if err != nil {
					continue
				}
				request := httptest.NewRequest(http.MethodPost, "/v1/responses", bytes.NewReader(requestBody))
				request.Header.Set("Content-Type", "application/json")
				for _, name := range websocketForwardHeaders {
					request.Header.Set(name, r.Header.Get(name))
				}
				response := httptest.NewRecorder()
				target.ServeHTTP(response, request)
				for _, responseFrame := range ResponseToWebSocketFrames(response.Code, response.Header(), response.Body.Bytes()) {
					if err := writeWSFrame(rw.Writer, 0x1, responseFrame); err != nil {
						return
					}
				}
				if err := rw.Flush(); err != nil {
					return
				}
			default:
				_ = writeWSFrame(rw.Writer, 0x8, []byte{0x03, 0xEB})
				_ = rw.Flush()
				return
			}
		}
	})
}

func readWSFrame(reader *bufio.Reader) (byte, []byte, error) {
	frame, err := readWSRawFrame(reader)
	if err != nil {
		return 0, nil, err
	}
	if !frame.fin {
		return 0, nil, fmt.Errorf("fragmented websocket frame requires message assembly")
	}
	return frame.opcode, frame.payload, nil
}

type wsRawFrame struct {
	fin     bool
	opcode  byte
	payload []byte
}

func readWSRawFrame(reader *bufio.Reader) (wsRawFrame, error) {
	header := make([]byte, 2)
	if _, err := io.ReadFull(reader, header); err != nil {
		return wsRawFrame{}, err
	}
	if header[0]&0x70 != 0 {
		return wsRawFrame{}, fmt.Errorf("websocket extensions are unsupported")
	}
	fin, opcode, masked, lengthCode := header[0]&0x80 != 0, header[0]&0x0f, header[1]&0x80 != 0, header[1]&0x7f
	if opcode != 0x0 && opcode != 0x1 && opcode != 0x2 && opcode != 0x8 && opcode != 0x9 && opcode != 0xA {
		return wsRawFrame{}, fmt.Errorf("unsupported websocket opcode 0x%x", opcode)
	}
	length := uint64(lengthCode)
	if lengthCode == 126 {
		var n uint16
		if err := binary.Read(reader, binary.BigEndian, &n); err != nil {
			return wsRawFrame{}, err
		}
		length = uint64(n)
		if length < 126 {
			return wsRawFrame{}, fmt.Errorf("non-minimal websocket length encoding")
		}
	}
	if lengthCode == 127 {
		if err := binary.Read(reader, binary.BigEndian, &length); err != nil {
			return wsRawFrame{}, err
		}
		if length < 65536 || length&(uint64(1)<<63) != 0 {
			return wsRawFrame{}, fmt.Errorf("invalid websocket 64-bit length")
		}
	}
	if opcode >= 0x8 && (!fin || length > 125) {
		return wsRawFrame{}, fmt.Errorf("invalid fragmented or oversized websocket control frame")
	}
	if length > 16<<20 {
		return wsRawFrame{}, fmt.Errorf("websocket frame exceeds limit")
	}
	if !masked {
		return wsRawFrame{}, fmt.Errorf("client websocket frame is not masked")
	}
	mask := make([]byte, 4)
	if _, err := io.ReadFull(reader, mask); err != nil {
		return wsRawFrame{}, err
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(reader, payload); err != nil {
		return wsRawFrame{}, err
	}
	for i := range payload {
		payload[i] ^= mask[i%4]
	}
	return wsRawFrame{fin: fin, opcode: opcode, payload: payload}, nil
}

func readWSMessage(reader *bufio.Reader) (byte, []byte, error) {
	first, err := readWSRawFrame(reader)
	if err != nil {
		return 0, nil, err
	}
	if first.opcode == 0x0 {
		return 0, nil, fmt.Errorf("unexpected websocket continuation frame")
	}
	if first.fin || first.opcode >= 0x8 {
		return first.opcode, first.payload, nil
	}
	if first.opcode != 0x1 && first.opcode != 0x2 {
		return 0, nil, fmt.Errorf("unsupported fragmented websocket opcode")
	}
	payload := append([]byte(nil), first.payload...)
	for {
		next, err := readWSRawFrame(reader)
		if err != nil {
			return 0, nil, err
		}
		if next.opcode != 0x0 {
			return 0, nil, fmt.Errorf("fragmented websocket message interrupted by opcode 0x%x", next.opcode)
		}
		if len(payload)+len(next.payload) > 16<<20 {
			return 0, nil, fmt.Errorf("websocket message exceeds limit")
		}
		payload = append(payload, next.payload...)
		if next.fin {
			return first.opcode, payload, nil
		}
	}
}

func writeWSFrame(writer io.Writer, opcode byte, payload []byte) error {
	header := []byte{0x80 | opcode}
	switch {
	case len(payload) < 126:
		header = append(header, byte(len(payload)))
	case len(payload) <= 65535:
		header = append(header, 126, byte(len(payload)>>8), byte(len(payload)))
	default:
		header = append(header, 127)
		var b [8]byte
		binary.BigEndian.PutUint64(b[:], uint64(len(payload)))
		header = append(header, b[:]...)
	}
	if _, err := writer.Write(header); err != nil {
		return err
	}
	_, err := writer.Write(payload)
	return err
}
