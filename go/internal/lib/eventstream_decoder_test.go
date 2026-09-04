package lib

import (
	"bytes"
	"testing"
)

func TestEventStreamRoundTripAndCRC(t *testing.T) {
	frame, err := EncodeEventStreamMessage(map[string]string{":event-type": "chunk"}, []byte("payload"))
	if err != nil {
		t.Fatal(err)
	}
	message, err := DecodeEventStreamMessage(frame)
	if err != nil || message.Headers[":event-type"] != "chunk" || string(message.Payload) != "payload" {
		t.Fatalf("message=%#v err=%v", message, err)
	}
	var decoded int
	if err := DecodeEventStream(bytes.NewReader(append(frame, frame...)), func(EventStreamMessage) error { decoded++; return nil }); err != nil || decoded != 2 {
		t.Fatalf("decoded=%d err=%v", decoded, err)
	}
	frame[len(frame)-1] ^= 1
	if _, err := DecodeEventStreamMessage(frame); err == nil {
		t.Fatal("corrupt CRC accepted")
	}
}
