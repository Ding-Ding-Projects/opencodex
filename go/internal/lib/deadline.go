package lib

import (
	"context"
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
	d.timer = time.AfterFunc(timeout, func() { d.mu.Lock(); d.expired = true; d.timer = nil; d.mu.Unlock(); cancel(d.TimeoutErr) })
	return d
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
