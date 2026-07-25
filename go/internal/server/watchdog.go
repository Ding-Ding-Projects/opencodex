package server

import (
	"runtime"
	"sync"
	"time"
)

type MemorySample struct {
	At        time.Time `json:"at"`
	RSS       uint64    `json:"rss"`
	HeapUsed  uint64    `json:"heapUsed"`
	HeapTotal uint64    `json:"heapTotal"`
}

type MemoryWatchdog struct {
	mu       sync.RWMutex
	samples  []MemorySample
	next     int
	full     bool
	stop     chan struct{}
	done     chan struct{}
	stopOnce sync.Once
}

// NewMemoryWatchdog samples memory into a fixed-size ring. sample may be injected for platform RSS accuracy.
func NewMemoryWatchdog(interval time.Duration, capacity int, sample func() MemorySample) *MemoryWatchdog {
	if interval <= 0 {
		interval = time.Minute
	}
	if capacity <= 0 {
		capacity = 360
	}
	if sample == nil {
		sample = runtimeMemorySample
	}
	w := &MemoryWatchdog{samples: make([]MemorySample, capacity), stop: make(chan struct{}), done: make(chan struct{})}
	w.add(sample())
	go func() {
		defer close(w.done)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				w.add(sample())
			case <-w.stop:
				return
			}
		}
	}()
	return w
}

func runtimeMemorySample() MemorySample {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	return MemorySample{At: time.Now(), RSS: m.Sys, HeapUsed: m.HeapAlloc, HeapTotal: m.HeapSys}
}
func (w *MemoryWatchdog) add(sample MemorySample) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.samples[w.next] = sample
	w.next = (w.next + 1) % len(w.samples)
	if w.next == 0 {
		w.full = true
	}
}
func (w *MemoryWatchdog) Snapshot() []MemorySample {
	w.mu.RLock()
	defer w.mu.RUnlock()
	if !w.full {
		return append([]MemorySample(nil), w.samples[:w.next]...)
	}
	out := append([]MemorySample(nil), w.samples[w.next:]...)
	return append(out, w.samples[:w.next]...)
}
func (w *MemoryWatchdog) Latest() (MemorySample, bool) {
	w.mu.RLock()
	defer w.mu.RUnlock()
	if !w.full && w.next == 0 {
		return MemorySample{}, false
	}
	index := w.next - 1
	if index < 0 {
		index = len(w.samples) - 1
	}
	return w.samples[index], true
}
func (w *MemoryWatchdog) Stop() {
	w.stopOnce.Do(func() { close(w.stop) })
	<-w.done
}
