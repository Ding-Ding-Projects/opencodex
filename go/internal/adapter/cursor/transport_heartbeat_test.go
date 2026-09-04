package cursor

import (
	"context"
	"io"
	"testing"
	"time"
)

func TestLiveTransportHeartbeatWritesConnectClientHeartbeat(t *testing.T) {
	reader, writer := io.Pipe()
	transport := &LiveTransport{config: TransportConfig{HeartbeatInterval: time.Millisecond}, requestBody: writer}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	errors := transport.startHeartbeat(ctx)

	frame, err := ReadFrame(reader, 64)
	if err != nil {
		t.Fatal(err)
	}
	fields, err := parseFields(frame.Payload)
	if err != nil {
		t.Fatal(err)
	}
	if len(fields) != 1 || fields[0].Number != 7 || len(fields[0].Bytes) != 0 {
		t.Fatalf("heartbeat payload fields = %#v", fields)
	}

	cancel()
	select {
	case err := <-errors:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("heartbeat did not stop after cancellation")
	}
}

func TestLiveTransportMarksStreamingRequestCommittedWhenHeadersAreWritten(t *testing.T) {
	transport := &LiveTransport{}
	trace := transport.commitTrace()
	if transport.RequestCommitted() {
		t.Fatal("transport starts committed")
	}
	trace.WroteHeaders()
	if !transport.RequestCommitted() {
		t.Fatal("transport remained replayable after request headers reached the wire")
	}
}
