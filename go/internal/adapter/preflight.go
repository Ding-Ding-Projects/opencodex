package adapter

import (
	"context"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

// EventPreflight holds a stream whose first meaningful event has been read and
// replayed. Error is non-nil when the upstream failed before producing output.
type EventPreflight struct {
	Stream <-chan types.AdapterEvent
	Error  *types.AdapterEvent
	Empty  bool
}

// PreflightEvents waits through heartbeats until the first meaningful adapter
// event. Callers can still return an HTTP error before committing stream headers
// when that event is an upstream failure.
func PreflightEvents(ctx context.Context, source <-chan types.AdapterEvent) EventPreflight {
	buffered := make([]types.AdapterEvent, 0, 1)
	for {
		select {
		case event, ok := <-source:
			if !ok {
				return EventPreflight{Stream: replayEvents(ctx, buffered, nil), Empty: true}
			}
			buffered = append(buffered, event)
			if event.Type == types.EventHeartbeat {
				continue
			}
			if event.Type == types.EventError {
				return EventPreflight{Stream: replayEvents(ctx, buffered, nil), Error: &event}
			}
			return EventPreflight{Stream: replayEvents(ctx, buffered, source)}
		case <-ctx.Done():
			return EventPreflight{Stream: replayEvents(ctx, buffered, nil), Empty: true}
		}
	}
}

func replayEvents(ctx context.Context, buffered []types.AdapterEvent, source <-chan types.AdapterEvent) <-chan types.AdapterEvent {
	replay := make(chan types.AdapterEvent, len(buffered))
	go func() {
		defer close(replay)
		for _, event := range buffered {
			select {
			case replay <- event:
			case <-ctx.Done():
				return
			}
		}
		if source == nil {
			return
		}
		for event := range source {
			select {
			case replay <- event:
			case <-ctx.Done():
				return
			}
		}
	}()
	return replay
}
