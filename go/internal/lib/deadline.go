package lib

import (
	"context"
	"io"
	"sync"
	"time"
)

// IdleDeadline is disarmed initially and fires at most once. Pause disarms the
// current window; Cancel permanently retires it.
type IdleDeadline struct {
	mu       sync.Mutex
	timer    *time.Timer
	duration time.Duration
	onIdle   func()
	done     bool
}

func NewIdleDeadline(duration time.Duration, onIdle func()) *IdleDeadline {
	return &IdleDeadline{duration: duration, onIdle: onIdle}
}
func (d *IdleDeadline) Reset() {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.done || d.duration <= 0 {
		return
	}
	d.stop()
	d.timer = time.AfterFunc(d.duration, d.fire)
}
func (d *IdleDeadline) Pause() {
	d.mu.Lock()
	defer d.mu.Unlock()
	if !d.done {
		d.stop()
	}
}
func (d *IdleDeadline) Cancel() {
	d.mu.Lock()
	defer d.mu.Unlock()
	if !d.done {
		d.done = true
		d.stop()
	}
}
func (d *IdleDeadline) stop() {
	if d.timer != nil {
		d.timer.Stop()
		d.timer = nil
	}
}
func (d *IdleDeadline) fire() {
	d.mu.Lock()
	if d.done {
		d.mu.Unlock()
		return
	}
	d.done = true
	d.timer = nil
	fn := d.onIdle
	d.mu.Unlock()
	if fn != nil {
		fn()
	}
}

type ClearableDeadline struct {
	Context    context.Context
	TimeoutErr error
	cancel     context.CancelCauseFunc
	mu         sync.Mutex
	timer      *time.Timer
	expired    bool
}

func NewClearableDeadline(parent context.Context, timeout time.Duration) *ClearableDeadline {
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithCancelCause(parent)
	d := &ClearableDeadline{Context: ctx, TimeoutErr: context.DeadlineExceeded, cancel: cancel}
	d.timer = time.AfterFunc(timeout, d.expire)
	return d
}
func (d *ClearableDeadline) expire() {
	d.mu.Lock()
	select {
	case <-d.Context.Done():
		d.timer = nil
		d.mu.Unlock()
		return
	default:
	}
	d.expired = true
	d.timer = nil
	d.mu.Unlock()
	d.cancel(d.TimeoutErr)
}
func (d *ClearableDeadline) DidExpire() bool { d.mu.Lock(); defer d.mu.Unlock(); return d.expired }
func (d *ClearableDeadline) Clear() {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.timer != nil {
		d.timer.Stop()
		d.timer = nil
	}
}

// LinkedTimeout owns a timeout context and an idempotent cleanup. Parent
// cancellation is preserved by context propagation.
type LinkedTimeout struct {
	Context context.Context
	once    sync.Once
	cancel  context.CancelFunc
}

func NewLinkedTimeout(parent context.Context, timeout time.Duration) *LinkedTimeout {
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithTimeout(parent, timeout)
	return &LinkedTimeout{Context: ctx, cancel: cancel}
}

func (t *LinkedTimeout) Cleanup() { t.once.Do(t.cancel) }

// CancelBodyOnDone binds a response body's lifetime to ctx. Calling the
// returned cleanup prevents a later context cancellation from closing a body
// that has already completed normally.
func CancelBodyOnDone(ctx context.Context, body io.Closer) func() {
	if ctx == nil || body == nil {
		return func() {}
	}
	stop := make(chan struct{})
	var once sync.Once
	var mu sync.Mutex
	active := true
	cleanup := func() {
		once.Do(func() {
			mu.Lock()
			active = false
			mu.Unlock()
			close(stop)
		})
	}
	select {
	case <-ctx.Done():
		_ = body.Close()
		return func() {}
	default:
	}
	go func() {
		select {
		case <-ctx.Done():
			mu.Lock()
			if active {
				active = false
				_ = body.Close()
			}
			mu.Unlock()
		case <-stop:
		}
	}()
	return cleanup
}
