package cursor

import (
	"bytes"
	"context"
	"io"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

func TestAdapterHandlesHourEquivalentProgressFramesWithoutLeak(t *testing.T) {
	const frames = 12_000
	adapter, err := NewAdapter(AdapterConfig{
		BaseURL: "https://cursor.example", Token: "token", HeartbeatInterval: time.Hour,
		Interaction: func(_ context.Context, query []byte) ([]byte, error) { return nil, nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	request, err := adapter.BuildRequest(context.Background(), cursorNormalizedRequest("soak"))
	if err != nil {
		t.Fatal(err)
	}
	drained := make(chan struct{})
	go func() {
		_, _ = io.Copy(io.Discard, request.Body)
		close(drained)
	}()

	query := appendMessage(nil, 7, appendVarintField(nil, 1, 9))
	terminal := appendMessage(nil, 1, appendMessage(nil, 14, nil))
	var body bytes.Buffer
	for index := 0; index < frames; index++ {
		encoded, encodeErr := EncodeFrame(ConnectFrame{Payload: query})
		if encodeErr != nil {
			t.Fatal(encodeErr)
		}
		body.Write(encoded)
	}
	for _, frame := range []ConnectFrame{{Payload: terminal}, {Flags: ConnectFlagEndStream, Payload: []byte(`{}`)}} {
		encoded, encodeErr := EncodeFrame(frame)
		if encodeErr != nil {
			t.Fatal(encodeErr)
		}
		body.Write(encoded)
	}

	heartbeats := 0
	done := false
	for event := range adapter.ParseStream(context.Background(), io.NopCloser(bytes.NewReader(body.Bytes()))) {
		if event.Type == types.EventHeartbeat {
			heartbeats++
		}
		if event.Type == types.EventDone {
			done = true
		}
	}
	select {
	case <-drained:
	case <-time.After(2 * time.Second):
		t.Fatal("Cursor request writer goroutine did not stop")
	}
	if heartbeats != frames || !done {
		t.Fatalf("heartbeats = %d/%d, done=%v", heartbeats, frames, done)
	}
}
