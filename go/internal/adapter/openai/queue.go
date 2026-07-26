package openai

import (
	"context"
	"io"
	"sync"
	"time"

	adapterbase "github.com/lidge-jun/opencodex-go/internal/adapter"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

type TurnQueue struct {
	mu     sync.Mutex
	queued []types.AdapterEvent
	out    chan types.AdapterEvent
	wake   chan struct{}
	space  chan struct{}
	closed bool
	stream sync.Once

	MaxBacklog        int
	OnBacklogExceeded func()
}

func NewTurnQueue(capacity int) *TurnQueue {
	if capacity < 0 {
		capacity = 0
	}
	q := &TurnQueue{
		queued:     make([]types.AdapterEvent, 0, capacity),
		out:        make(chan types.AdapterEvent),
		wake:       make(chan struct{}, 1),
		space:      make(chan struct{}),
		MaxBacklog: 1024,
	}
	return q
}

func NewAdapterEventQueue() *TurnQueue { return NewTurnQueue(16) }

func newStreamEventQueue(body io.Closer) *TurnQueue {
	queue := NewAdapterEventQueue()
	if body != nil {
		queue.OnBacklogExceeded = func() { _ = body.Close() }
	}
	return queue
}

// Push queues an event in call order. It returns false after Close.
func (q *TurnQueue) Push(event types.AdapterEvent) bool {
	q.mu.Lock()
	if q.closed {
		q.mu.Unlock()
		return false
	}
	if len(q.queued) == 0 {
		select {
		case q.out <- event:
			q.mu.Unlock()
			return true
		default:
		}
	}
	if len(q.queued) >= q.MaxBacklog {
		callback := q.OnBacklogExceeded
		q.queued = append(q.queued, types.AdapterEvent{
			Type:  types.EventError,
			Error: "consumer backlog exceeded — turn aborted",
		})
		q.closed = true
		q.mu.Unlock()
		if callback != nil {
			callback()
		}
		q.notify()
		return true
	}
	q.queued = append(q.queued, event)
	q.mu.Unlock()
	q.notify()
	return true
}

func (q *TurnQueue) Send(ctx context.Context, event types.AdapterEvent) bool {
	if ctx.Err() != nil {
		return false
	}
	// A live consumer can briefly trail a bursty parser even though it is draining
	// continuously. Give it one scheduler-sized grace window at the hard limit;
	// a truly stalled consumer still receives the same bounded abort outcome.
	q.mu.Lock()
	full := q.MaxBacklog > 0 && len(q.queued) >= q.MaxBacklog && !q.closed
	q.mu.Unlock()
	if full {
		timer := time.NewTimer(10 * time.Millisecond)
		defer timer.Stop()
		select {
		case <-q.space:
		case <-timer.C:
		case <-ctx.Done():
			return false
		}
	}
	return q.Push(event)
}

func (q *TurnQueue) Close() {
	q.mu.Lock()
	if q.closed {
		q.mu.Unlock()
		return
	}
	q.closed = true
	q.mu.Unlock()
	q.notify()
}

func (q *TurnQueue) Stream() <-chan types.AdapterEvent {
	q.stream.Do(func() { go q.pump() })
	return q.out
}

func (q *TurnQueue) notify() {
	select {
	case q.wake <- struct{}{}:
	default:
	}
}

func (q *TurnQueue) pump() {
	defer close(q.out)
	for {
		q.mu.Lock()
		if len(q.queued) == 0 {
			closed := q.closed
			q.mu.Unlock()
			if closed {
				return
			}
			<-q.wake
			continue
		}
		event := q.queued[0]
		q.mu.Unlock()

		select {
		case q.out <- event:
			q.mu.Lock()
			q.queued = q.queued[1:]
			q.mu.Unlock()
			select {
			case q.space <- struct{}{}:
			default:
			}
		case <-q.wake:
		}
	}
}

func (q *TurnQueue) Collect(ctx context.Context) ([]types.AdapterEvent, error) {
	events := make([]types.AdapterEvent, 0)
	for {
		select {
		case event, ok := <-q.Stream():
			if !ok {
				return events, nil
			}
			events = append(events, event)
		case <-ctx.Done():
			return events, ctx.Err()
		}
	}
}

type EventPreflight = adapterbase.EventPreflight

func PreflightAdapterEvents(ctx context.Context, source <-chan types.AdapterEvent) EventPreflight {
	return adapterbase.PreflightEvents(ctx, source)
}
