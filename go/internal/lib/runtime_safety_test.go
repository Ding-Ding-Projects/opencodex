package lib

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestProviderDiagnosticsAreOptInAndRedacted(t *testing.T) {
	ClearDebugSettings()
	t.Cleanup(func() { ClearDebugSettings(); DebugWriter = os.Stderr })
	DefaultDebugLogBuffer = NewDebugLogBuffer()
	var output bytes.Buffer
	DebugWriter = &output
	DebugDroppedFrame("openai", "Bearer secret")
	if output.Len() != 0 {
		t.Fatalf("disabled debug wrote %q", output.String())
	}
	SetDebugSettings(map[DebugFlag]bool{DebugProvider: true})
	DebugDroppedFrame("openai", "Bearer secret")
	DebugProviderDiagnostic("openai", "request", map[string]any{"authorization": "Bearer abcdefghijklmnop", "model": "gpt-test"})
	got := output.String()
	if strings.Contains(got, "abcdefghijklmnop") || strings.Contains(got, "Bearer secret") {
		t.Fatalf("diagnostic leaked payload: %s", got)
	}
	if !strings.Contains(got, "bytes=13") || !strings.Contains(got, RedactedSecret) {
		t.Fatalf("diagnostic missing safe context: %s", got)
	}
}

func TestCrashEntryRedactsAndIncludesBreadcrumbs(t *testing.T) {
	tracker := NewSidecarTracker()
	leave := tracker.Enter("web-search")
	defer leave()
	tracker.MarkActivity("fetch Bearer abcdefghijklmnop")
	entry := FormatCrashEntry("panic", errors.New("token=abcdefghijklmnop"), []byte("stack api_key=abcdefghijklmnop"), CrashEntryOptions{
		At:      time.Date(2026, 7, 26, 1, 2, 3, 0, time.UTC),
		Promise: "request https://user:secret@example.test/path?token=x",
		Tracker: tracker,
	})
	if strings.Contains(entry, "abcdefghijklmnop") || strings.Contains(entry, "user:secret") {
		t.Fatalf("crash entry leaked secret: %s", entry)
	}
	for _, want := range []string{"[2026-07-26T01:02:03Z] panic", "sidecar: inFlight=1 last=web-search", "activity:", RedactedSecret} {
		if !strings.Contains(entry, want) {
			t.Fatalf("entry missing %q: %s", want, entry)
		}
	}
	path := filepath.Join(t.TempDir(), "nested", "crash.log")
	if err := AppendCrashEntry(path, entry); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("mode=%v err=%v", info.Mode().Perm(), err)
	}
}

func TestRunGuardedActivatesCrashLogWithLiveSidecarBreadcrumb(t *testing.T) {
	tracker := NewSidecarTracker()
	exit := tracker.Enter("vision")
	defer exit()
	path := filepath.Join(t.TempDir(), "crash.log")
	crashed, err := RunGuarded(path, "panic", tracker, func() {
		panic("token=abcdefghijklmnop")
	})
	if err != nil || !crashed {
		t.Fatalf("RunGuarded() = %t, %v", crashed, err)
	}
	data, readErr := os.ReadFile(path)
	if readErr != nil {
		t.Fatal(readErr)
	}
	entry := string(data)
	if !strings.Contains(entry, "sidecar: inFlight=1 last=vision") || strings.Contains(entry, "abcdefghijklmnop") {
		t.Fatalf("crash entry = %q", entry)
	}
}

type countedCloser struct{ calls atomic.Int32 }

func (c *countedCloser) Close() error { c.calls.Add(1); return nil }

func TestLinkedTimeoutAndBodyCancellation(t *testing.T) {
	parent, cancel := context.WithCancel(context.Background())
	linked := NewLinkedTimeout(parent, time.Hour)
	cancel()
	select {
	case <-linked.Context.Done():
	case <-time.After(time.Second):
		t.Fatal("linked context did not follow parent")
	}
	linked.Cleanup()

	ctx, cancelBody := context.WithCancel(context.Background())
	body := &countedCloser{}
	cleanup := CancelBodyOnDone(ctx, body)
	cancelBody()
	deadline := time.Now().Add(time.Second)
	for body.calls.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if body.calls.Load() != 1 {
		t.Fatalf("body close calls=%d", body.calls.Load())
	}
	cleanup()

	ctx2, cancel2 := context.WithCancel(context.Background())
	body2 := &countedCloser{}
	CancelBodyOnDone(ctx2, body2)()
	cancel2()
	time.Sleep(10 * time.Millisecond)
	if body2.calls.Load() != 0 {
		t.Fatalf("cleaned body was closed %d times", body2.calls.Load())
	}
}
