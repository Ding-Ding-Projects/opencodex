package usage

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"
	"sync/atomic"
)

var errSnapshotRevisionChanged = errors.New("usage log revision changed before snapshot read")

const snapshotRevisionRetryLimit = 64

// Snapshot is a management read result. Entries is always owned by the caller.
type Snapshot struct {
	Entries  []Entry
	Revision Revision
}

// SnapshotStats is test-only observability. It contains counters, never rows.
type SnapshotStats struct {
	FullReads    uint64
	ParsedLines  uint64
	RetainedCall int
}

type snapshotCall struct {
	done     chan struct{}
	entries  []Entry
	revision Revision
	err      error
}

type snapshotOwner struct {
	mu                   sync.Mutex
	calls                map[string]*snapshotCall
	weakSequence         atomic.Uint64
	fullReads            atomic.Uint64
	parsedLines          atomic.Uint64
	beforeReadForTests   func(Revision)
	afterAcquireForTests func()
}

// CurrentRevision opens the path first and derives identity from that descriptor.
func (l *Log) CurrentRevision() (Revision, error) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	return l.currentRevision()
}

func (l *Log) currentRevision() (Revision, error) {
	file, err := os.Open(l.path)
	if errors.Is(err, os.ErrNotExist) {
		return Revision{Path: l.path, Missing: true}, nil
	}
	if err != nil {
		return Revision{}, fmt.Errorf("open usage log: %w", err)
	}
	defer file.Close()
	return revisionFromFile(l.path, file)
}

// ReadSnapshotForManagement performs a descriptor-stable full read. Concurrent
// callers share only an exact, strong revision and every caller receives its own
// slice. Completed calls are removed before waiters are released.
func (l *Log) ReadSnapshotForManagement(ctx context.Context) (Snapshot, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	for attempt := 0; attempt < snapshotRevisionRetryLimit; attempt++ {
		if err := ctx.Err(); err != nil {
			return Snapshot{}, err
		}
		observed, err := l.currentRevision()
		if err != nil {
			return Snapshot{}, err
		}
		if observed.Missing {
			return Snapshot{Entries: []Entry{}, Revision: observed}, nil
		}
		key := observed.Key()
		if observed.weakIdentity {
			key = fmt.Sprintf("%s\x00weak-%d", key, l.snapshot.weakSequence.Add(1))
		}
		call, leader := l.snapshot.acquire(key)
		l.snapshot.notifyAcquireForTests()
		if leader {
			go l.snapshot.run(l.path, key, observed, call)
		}
		select {
		case <-ctx.Done():
			return Snapshot{}, ctx.Err()
		case <-call.done:
		}
		if errors.Is(call.err, errSnapshotRevisionChanged) {
			continue
		}
		if call.err != nil {
			return Snapshot{}, call.err
		}
		return Snapshot{Entries: cloneEntries(call.entries), Revision: call.revision}, nil
	}
	return Snapshot{}, fmt.Errorf("%w after %d attempts", errSnapshotRevisionChanged, snapshotRevisionRetryLimit)
}

func (o *snapshotOwner) notifyAcquireForTests() {
	o.mu.Lock()
	hook := o.afterAcquireForTests
	o.mu.Unlock()
	if hook != nil {
		hook()
	}
}

func (o *snapshotOwner) acquire(key string) (*snapshotCall, bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if call := o.calls[key]; call != nil {
		return call, false
	}
	if o.calls == nil {
		o.calls = make(map[string]*snapshotCall)
	}
	call := &snapshotCall{done: make(chan struct{})}
	o.calls[key] = call
	return call, true
}

func (o *snapshotOwner) run(path, key string, expected Revision, call *snapshotCall) {
	call.entries, call.revision, call.err = o.read(path, expected)
	o.mu.Lock()
	if o.calls[key] == call {
		delete(o.calls, key)
	}
	close(call.done)
	o.mu.Unlock()
}

func (o *snapshotOwner) read(path string, expected Revision) ([]Entry, Revision, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, Revision{}, fmt.Errorf("open usage log snapshot: %w", err)
	}
	defer file.Close()
	revision, err := revisionFromFile(path, file)
	if err != nil {
		return nil, Revision{}, err
	}
	if revision.Key() != expected.Key() {
		return nil, Revision{}, errSnapshotRevisionChanged
	}
	o.mu.Lock()
	hook := o.beforeReadForTests
	o.mu.Unlock()
	if hook != nil {
		hook(revision)
	}
	if revision.Size < 0 || uint64(revision.Size) > uint64(^uint(0)>>1) {
		return nil, Revision{}, fmt.Errorf("usage log snapshot is too large: %d", revision.Size)
	}
	data := make([]byte, int(revision.Size))
	if _, err := io.ReadFull(file, data); err != nil {
		return nil, Revision{}, fmt.Errorf("usage log changed while snapshot was read: %w", err)
	}
	entries, err := readEntries(bytes.NewReader(data))
	if err != nil {
		return nil, Revision{}, err
	}
	o.fullReads.Add(1)
	for _, line := range bytes.Split(data, []byte{'\n'}) {
		if len(bytes.TrimSpace(line)) != 0 {
			o.parsedLines.Add(1)
		}
	}
	return entries, revision, nil
}

// SnapshotStatsForTests returns counters and the number of calls still retained
// by the owner. RetainedCall must return to zero after every completed read.
func (l *Log) SnapshotStatsForTests() SnapshotStats {
	l.snapshot.mu.Lock()
	defer l.snapshot.mu.Unlock()
	return SnapshotStats{
		FullReads:    l.snapshot.fullReads.Load(),
		ParsedLines:  l.snapshot.parsedLines.Load(),
		RetainedCall: len(l.snapshot.calls),
	}
}

func (l *Log) resetSnapshotStatsForTests() {
	l.snapshot.fullReads.Store(0)
	l.snapshot.parsedLines.Store(0)
}
