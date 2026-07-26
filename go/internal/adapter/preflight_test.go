package adapter

import (
	"context"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

func TestPreflightEventsStopsBeforeFirstOutputError(t *testing.T) {
	source := make(chan types.AdapterEvent, 2)
	source <- types.AdapterEvent{Type: types.EventHeartbeat}
	source <- types.AdapterEvent{Type: types.EventError, Error: "bad chunk", StatusCode: 502}
	close(source)

	result := PreflightEvents(context.Background(), source)
	if result.Error == nil || result.Error.StatusCode != 502 || result.Empty {
		t.Fatalf("preflight = %#v", result)
	}
}
