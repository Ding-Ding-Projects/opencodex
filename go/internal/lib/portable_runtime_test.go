package lib

import (
	"context"
	"io"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestReadBoundedBodyCompleteAndOversized(t *testing.T) {
	got, err := ReadBoundedBody(context.Background(), io.NopCloser(strings.NewReader("hello")), BoundedBodyOptions{})
	if err != nil || got.Text != "hello" || !got.DisplaySafe {
		t.Fatalf("complete = %#v, %v", got, err)
	}
	oversized := strings.Repeat("x", BoundedBodyMaxBytes+1)
	got, err = ReadBoundedBody(context.Background(), io.NopCloser(strings.NewReader(oversized)), BoundedBodyOptions{})
	if err != nil || !got.Oversized || got.Text != "" || got.DisplaySafe {
		t.Fatalf("oversized = %#v, %v", got, err)
	}
}
func TestReadBoundedBodyTimeoutAndCancel(t *testing.T) {
	reader, writer := io.Pipe()
	defer writer.Close()
	got, err := ReadBoundedBody(context.Background(), reader, BoundedBodyOptions{TotalTimeout: time.Second, InactivityTimeout: 10 * time.Millisecond})
	if err != nil || !got.InactivityTimedOut || !got.TimedOut {
		t.Fatalf("timeout = %#v, %v", got, err)
	}
}
func TestIdleDeadlineFiresOnce(t *testing.T) {
	var calls atomic.Int32
	d := NewIdleDeadline(5*time.Millisecond, func() { calls.Add(1) })
	d.Reset()
	time.Sleep(15 * time.Millisecond)
	d.Reset()
	time.Sleep(10 * time.Millisecond)
	if calls.Load() != 1 {
		t.Fatalf("calls=%d", calls.Load())
	}
}
func TestDebugSettingsOverrideEnvironment(t *testing.T) {
	ClearDebugSettings()
	t.Setenv("OCX_DEBUG", "1")
	if !IsDebugEnabled() {
		t.Fatal("env ignored")
	}
	SetDebugSettings(map[DebugFlag]bool{DebugProvider: false})
	if IsDebugEnabled() {
		t.Fatal("override ignored")
	}
	ClearDebugSettings()
}
func TestDebugLogBufferPaginationAndListenerIsolation(t *testing.T) {
	b := NewDebugLogBuffer()
	seen := make(chan DebugLogEntry, 1)
	unsub := b.Subscribe(func(e DebugLogEntry) { seen <- e })
	b.Subscribe(func(DebugLogEntry) { panic("ignored") })
	b.Append("one")
	e := <-seen
	unsub()
	b.Append("two")
	got := b.Entries(e.Seq, 10)
	if len(got) != 1 || got[0].Line != "two" {
		t.Fatalf("entries=%#v", got)
	}
}
func TestSidecarTrackerIdempotentExit(t *testing.T) {
	tracker := NewSidecarTracker()
	exit := tracker.Enter("search")
	exit()
	exit()
	if got := tracker.Breadcrumb(); got.InFlight != 0 || got.LastLabel != "search" {
		t.Fatalf("breadcrumb=%#v", got)
	}
}
