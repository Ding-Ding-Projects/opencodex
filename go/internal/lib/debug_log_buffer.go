package lib

import (
	"sync"
	"time"
)

const DebugLogMaxLines = 2000

type DebugLogEntry struct {
	Seq  uint64 `json:"seq"`
	At   int64  `json:"at"`
	Line string `json:"line"`
}
type DebugLogBuffer struct {
	mu           sync.RWMutex
	entries      []DebugLogEntry
	next         uint64
	listeners    map[uint64]func(DebugLogEntry)
	nextListener uint64
}

func NewDebugLogBuffer() *DebugLogBuffer {
	return &DebugLogBuffer{next: 1, listeners: map[uint64]func(DebugLogEntry){}}
}
func (b *DebugLogBuffer) Append(line string) DebugLogEntry {
	b.mu.Lock()
	e := DebugLogEntry{Seq: b.next, At: time.Now().UnixMilli(), Line: line}
	b.next++
	b.entries = append(b.entries, e)
	if len(b.entries) > DebugLogMaxLines {
		b.entries = append([]DebugLogEntry(nil), b.entries[len(b.entries)-DebugLogMaxLines:]...)
	}
	listeners := make([]func(DebugLogEntry), 0, len(b.listeners))
	for _, fn := range b.listeners {
		listeners = append(listeners, fn)
	}
	b.mu.Unlock()
	for _, fn := range listeners {
		func() { defer func() { _ = recover() }(); fn(e) }()
	}
	return e
}
func (b *DebugLogBuffer) Entries(after uint64, limit int) []DebugLogEntry {
	if limit <= 0 {
		limit = 500
	}
	b.mu.RLock()
	defer b.mu.RUnlock()
	start := 0
	for start < len(b.entries) && b.entries[start].Seq <= after {
		start++
	}
	if len(b.entries)-start > limit {
		start = len(b.entries) - limit
	}
	return append([]DebugLogEntry(nil), b.entries[start:]...)
}
func (b *DebugLogBuffer) Subscribe(fn func(DebugLogEntry)) func() {
	b.mu.Lock()
	id := b.nextListener
	b.nextListener++
	b.listeners[id] = fn
	b.mu.Unlock()
	var once sync.Once
	return func() { once.Do(func() { b.mu.Lock(); delete(b.listeners, id); b.mu.Unlock() }) }
}

var DefaultDebugLogBuffer = NewDebugLogBuffer()
