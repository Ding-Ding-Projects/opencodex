package lib

import "testing"

func TestSSEDecoderPortableBoundary(t *testing.T) {
	events := make(chan SSEEvent, 2)
	decoder := NewSSEDecoderWithComments(events)
	if _, err := decoder.Write([]byte(": ping\ndata: first\ndata: second")); err != nil {
		t.Fatal(err)
	}
	if err := decoder.Close(); err != nil {
		t.Fatal(err)
	}
	comment := <-events
	event := <-events
	if comment.Comment == nil || *comment.Comment != "ping" || event.Data != "first\nsecond" {
		t.Fatalf("comment=%#v event=%#v", comment, event)
	}
}
