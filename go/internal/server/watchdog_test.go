package server

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestMemoryWatchdogSamplesImmediatelyAndStopsConcurrently(t *testing.T) {
	var sequence atomic.Uint64
	watchdog := NewMemoryWatchdog(time.Hour, 2, func() MemorySample {
		return MemorySample{At: time.Now(), RSS: sequence.Add(1)}
	})
	latest, ok := watchdog.Latest()
	if !ok || latest.RSS != 1 || len(watchdog.Snapshot()) != 1 {
		t.Fatalf("initial latest=%+v ok=%v snapshot=%+v", latest, ok, watchdog.Snapshot())
	}
	var group sync.WaitGroup
	group.Add(2)
	for range 2 {
		go func() { defer group.Done(); watchdog.Stop() }()
	}
	group.Wait()
}
