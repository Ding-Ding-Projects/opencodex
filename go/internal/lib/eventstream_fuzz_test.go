package lib

import (
	"bytes"
	"reflect"
	"testing"
)

func FuzzEventStreamDecoder(f *testing.F) {
	valid, _ := EncodeEventStreamMessage(map[string]string{"event": "도구", "kind": "delta"}, []byte("payload 🌍"))
	f.Add([]byte{})
	f.Add(valid)
	f.Fuzz(func(t *testing.T, data []byte) {
		if len(data) > 1<<20 {
			t.Skip()
		}
		message, err := DecodeEventStreamMessage(data)
		if err != nil {
			return
		}
		encoded, err := EncodeEventStreamMessage(message.Headers, message.Payload)
		if err != nil {
			t.Fatalf("accepted message cannot be encoded: %v", err)
		}
		roundTrip, err := DecodeEventStreamMessage(encoded)
		if err != nil || !reflect.DeepEqual(message, roundTrip) {
			t.Fatalf("round trip changed message: message=%#v roundTrip=%#v err=%v", message, roundTrip, err)
		}
		var streamed []EventStreamMessage
		if err := DecodeEventStream(bytes.NewReader(data), func(item EventStreamMessage) error {
			streamed = append(streamed, item)
			return nil
		}); err != nil || len(streamed) != 1 || !reflect.DeepEqual(message, streamed[0]) {
			t.Fatalf("stream decoder differs: streamed=%#v err=%v", streamed, err)
		}
	})
}
