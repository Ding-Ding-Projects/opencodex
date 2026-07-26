package lib

import (
	"bytes"
	"fmt"
	"testing"
)

func BenchmarkDecodeEventStreamMessages(b *testing.B) {
	// Apple M5 Pro: payload-copy baseline 124,880 B/op and 2,306
	// allocs/op; stream-owned payload 120,784 B/op and 2,050 allocs/op.
	const messages = 256
	var stream bytes.Buffer
	for index := 0; index < messages; index++ {
		frame, err := EncodeEventStreamMessage(map[string]string{":message-type": "event", ":event-type": "chunk"}, []byte(fmt.Sprintf(`{"index":%d}`, index)))
		if err != nil {
			b.Fatal(err)
		}
		stream.Write(frame)
	}
	payload := stream.Bytes()
	b.SetBytes(int64(len(payload)))
	b.ReportAllocs()
	b.ResetTimer()
	for index := 0; index < b.N; index++ {
		count := 0
		if err := DecodeEventStream(bytes.NewReader(payload), func(EventStreamMessage) error {
			count++
			return nil
		}); err != nil {
			b.Fatal(err)
		}
		if count != messages {
			b.Fatalf("messages = %d", count)
		}
	}
}
