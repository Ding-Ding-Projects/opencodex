package usage

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

func snapshotLine(id string) []byte {
	data, err := json.Marshal(Entry{
		RequestID: id, Timestamp: 1, Provider: "openai", Model: "gpt-5.5",
		Status: 200, DurationMS: 1, UsageStatus: StatusReported,
	})
	if err != nil {
		panic(err)
	}
	return append(data, '\n')
}

func writeSnapshotLog(t *testing.T, path string, ids ...string) {
	t.Helper()
	data := make([]byte, 0)
	for _, id := range ids {
		data = append(data, snapshotLine(id)...)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func setBeforeSnapshotRead(t *testing.T, log *Log, hook func(Revision)) {
	t.Helper()
	log.snapshot.mu.Lock()
	log.snapshot.beforeReadForTests = hook
	log.snapshot.mu.Unlock()
	t.Cleanup(func() {
		log.snapshot.mu.Lock()
		log.snapshot.beforeReadForTests = nil
		log.snapshot.mu.Unlock()
	})
}

func setAfterSnapshotAcquire(t *testing.T, log *Log, hook func()) {
	t.Helper()
	log.snapshot.mu.Lock()
	log.snapshot.afterAcquireForTests = hook
	log.snapshot.mu.Unlock()
	t.Cleanup(func() {
		log.snapshot.mu.Lock()
		log.snapshot.afterAcquireForTests = nil
		log.snapshot.mu.Unlock()
	})
}

func TestCurrentRevisionMissingDirectoryAndRegularFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "usage.jsonl")
	log := NewLog(path)
	missing, err := log.CurrentRevision()
	if err != nil || !missing.Missing || missing.Path != path {
		t.Fatalf("missing revision = %#v, %v", missing, err)
	}
	if _, err := NewLog(dir).CurrentRevision(); err == nil {
		t.Fatal("directory accepted as a usage snapshot")
	}
	writeSnapshotLog(t, path, "a")
	first, err := log.CurrentRevision()
	if err != nil || first.Missing || first.Size <= 0 || first.Key() == missing.Key() {
		t.Fatalf("regular revision = %#v, %v", first, err)
	}
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	direct, err := revisionFromFile(path, file)
	_ = file.Close()
	if err != nil || direct.Key() != first.Key() {
		t.Fatalf("descriptor revision = %#v, %v; want %q", direct, err, first.Key())
	}
	if err := os.WriteFile(path, append(snapshotLine("a"), snapshotLine("b")...), 0o600); err != nil {
		t.Fatal(err)
	}
	appended, err := log.CurrentRevision()
	if err != nil || appended.Key() == first.Key() || appended.Size <= first.Size {
		t.Fatalf("append revision = %#v, %v", appended, err)
	}
	if err := os.Truncate(path, 0); err != nil {
		t.Fatal(err)
	}
	truncated, err := log.CurrentRevision()
	if err != nil || truncated.Key() == appended.Key() || truncated.Size != 0 {
		t.Fatalf("truncate revision = %#v, %v", truncated, err)
	}
}

func TestReadSnapshotReadsExactlyObservedLength(t *testing.T) {
	path := filepath.Join(t.TempDir(), "usage.jsonl")
	writeSnapshotLog(t, path, "old")
	log := NewLog(path)
	var once sync.Once
	setBeforeSnapshotRead(t, log, func(Revision) {
		once.Do(func() {
			file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := file.Write(snapshotLine("late")); err != nil {
				t.Fatal(err)
			}
			_ = file.Close()
		})
	})
	snapshot, err := log.ReadSnapshotForManagement(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Entries) != 1 || snapshot.Entries[0].RequestID != "old" {
		t.Fatalf("snapshot entries = %#v", snapshot.Entries)
	}
	current, err := log.CurrentRevision()
	if err != nil || current.Size <= snapshot.Revision.Size {
		t.Fatalf("current revision = %#v, %v; snapshot = %#v", current, err, snapshot.Revision)
	}
}

func TestReadSnapshotFailsOnShortReadAfterTruncate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "usage.jsonl")
	writeSnapshotLog(t, path, "old", "tail")
	log := NewLog(path)
	var once sync.Once
	setBeforeSnapshotRead(t, log, func(Revision) {
		once.Do(func() {
			if err := os.Truncate(path, 1); err != nil {
				t.Fatal(err)
			}
		})
	})
	_, err := log.ReadSnapshotForManagement(context.Background())
	if err == nil || !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("short read error = %v", err)
	}
	if stats := log.SnapshotStatsForTests(); stats.FullReads != 0 || stats.RetainedCall != 0 {
		t.Fatalf("stats after short read = %#v", stats)
	}
}

func TestReadSnapshotSameRevisionSharesOneReadAndClonesSlices(t *testing.T) {
	path := filepath.Join(t.TempDir(), "usage.jsonl")
	writeSnapshotLog(t, path, "one", "two")
	log := NewLog(path)
	started := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	setBeforeSnapshotRead(t, log, func(Revision) {
		once.Do(func() { close(started) })
		<-release
	})
	const readers = 12
	acquired := make(chan struct{}, readers)
	setAfterSnapshotAcquire(t, log, func() { acquired <- struct{}{} })
	results := make(chan Snapshot, readers)
	errorsOut := make(chan error, readers)
	for range readers {
		go func() {
			snapshot, err := log.ReadSnapshotForManagement(context.Background())
			results <- snapshot
			errorsOut <- err
		}()
	}
	<-started
	for range readers {
		<-acquired
	}
	close(release)
	snapshots := make([]Snapshot, 0, readers)
	for range readers {
		if err := <-errorsOut; err != nil {
			t.Fatal(err)
		}
		snapshots = append(snapshots, <-results)
	}
	if stats := log.SnapshotStatsForTests(); stats.FullReads != 1 || stats.ParsedLines != 2 || stats.RetainedCall != 0 {
		t.Fatalf("shared-read stats = %#v", stats)
	}
	snapshots[0].Entries[0].RequestID = "mutated"
	if snapshots[1].Entries[0].RequestID != "one" {
		t.Fatalf("caller slices alias: %#v", snapshots[1].Entries)
	}
}

func TestReadSnapshotReplacementDoesNotJoinOldRevision(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("rename of an open file is filesystem-policy dependent on Windows")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "usage.jsonl")
	writeSnapshotLog(t, path, "old")
	log := NewLog(path)
	oldRevision, err := log.CurrentRevision()
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	setBeforeSnapshotRead(t, log, func(revision Revision) {
		if revision.Key() != oldRevision.Key() {
			return
		}
		once.Do(func() { close(started) })
		<-release
	})
	oldResult := make(chan Snapshot, 1)
	oldError := make(chan error, 1)
	go func() {
		snapshot, err := log.ReadSnapshotForManagement(context.Background())
		oldResult <- snapshot
		oldError <- err
	}()
	<-started
	replacement := filepath.Join(dir, "replacement.jsonl")
	writeSnapshotLog(t, replacement, "new")
	if err := os.Rename(replacement, path); err != nil {
		t.Fatal(err)
	}
	newSnapshot, err := log.ReadSnapshotForManagement(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	close(release)
	if err := <-oldError; err != nil {
		t.Fatal(err)
	}
	oldSnapshot := <-oldResult
	if got := oldSnapshot.Entries[0].RequestID; got != "old" {
		t.Fatalf("old snapshot id = %q", got)
	}
	if got := newSnapshot.Entries[0].RequestID; got != "new" {
		t.Fatalf("new snapshot id = %q", got)
	}
	if oldSnapshot.Revision.Key() == newSnapshot.Revision.Key() {
		t.Fatal("replacement reused the old revision")
	}
	if stats := log.SnapshotStatsForTests(); stats.FullReads != 2 || stats.RetainedCall != 0 {
		t.Fatalf("replacement stats = %#v", stats)
	}
}

func TestReadSnapshotToleratesMalformedRowsWithoutRetainingRows(t *testing.T) {
	path := filepath.Join(t.TempDir(), "usage.jsonl")
	data := append(snapshotLine("valid"), []byte("{partial\n")...)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	log := NewLog(path)
	snapshot, err := log.ReadSnapshotForManagement(context.Background())
	if err != nil || len(snapshot.Entries) != 1 || snapshot.Entries[0].RequestID != "valid" {
		t.Fatalf("snapshot = %#v, %v", snapshot, err)
	}
	if stats := log.SnapshotStatsForTests(); stats.ParsedLines != 2 || stats.RetainedCall != 0 {
		t.Fatalf("malformed-row stats = %#v", stats)
	}
}

func TestReadSnapshotConcurrentWithAppendIsRaceFree(t *testing.T) {
	path := filepath.Join(t.TempDir(), "usage.jsonl")
	log := NewLog(path)
	if err := log.Append(Entry{RequestID: "seed", Timestamp: 1, Provider: "p", Model: "m", Status: 200, UsageStatus: StatusReported}); err != nil {
		t.Fatal(err)
	}
	const rounds = 40
	var wg sync.WaitGroup
	for i := range rounds {
		wg.Add(2)
		go func(index int) {
			defer wg.Done()
			entry := Entry{RequestID: fmt.Sprintf("append-%d", index), Timestamp: int64(index + 2), Provider: "p", Model: "m", Status: 200, UsageStatus: StatusReported}
			if err := log.Append(entry); err != nil {
				t.Errorf("Append(%d): %v", index, err)
			}
		}(i)
		go func() {
			defer wg.Done()
			if _, err := log.ReadSnapshotForManagement(context.Background()); err != nil {
				t.Errorf("ReadSnapshotForManagement: %v", err)
			}
		}()
	}
	wg.Wait()
	if stats := log.SnapshotStatsForTests(); stats.RetainedCall != 0 {
		t.Fatalf("race test retained calls = %#v", stats)
	}
}

func TestReadSnapshotDeepClonesNestedEntryState(t *testing.T) {
	path := filepath.Join(t.TempDir(), "usage.jsonl")
	firstOutput, total, attemptFirstOutput, attemptTotal := int64(7), 11, int64(3), 5
	modelTier := true
	entry := Entry{
		RequestID: "nested", Timestamp: 1, Provider: "openai", Model: "gpt-5.5",
		Status: 200, DurationMS: 10, FirstOutputMS: &firstOutput,
		UsageStatus: StatusReported, Usage: &types.Usage{InputTokens: 6, OutputTokens: 5}, TotalTokens: &total,
		Attempts: []Attempt{{Ordinal: 1, Provider: "openai", Model: "gpt-5.5", HTTPStatus: 200,
			FirstOutput: &attemptFirstOutput, Recovery: []string{"retry"}, UsageStatus: StatusReported,
			Usage: &types.Usage{InputTokens: 3, OutputTokens: 2}, TotalTokens: &attemptTotal}},
		ModelSupportsServiceTier: &modelTier,
	}
	data, err := json.Marshal(entry)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, append(data, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	log := NewLog(path)
	started := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	setBeforeSnapshotRead(t, log, func(Revision) {
		once.Do(func() { close(started) })
		<-release
	})
	acquired := make(chan struct{}, 2)
	setAfterSnapshotAcquire(t, log, func() { acquired <- struct{}{} })
	results := make(chan Snapshot, 2)
	errorsOut := make(chan error, 2)
	for range 2 {
		go func() {
			snapshot, err := log.ReadSnapshotForManagement(context.Background())
			results <- snapshot
			errorsOut <- err
		}()
	}
	<-started
	for range 2 {
		<-acquired
	}
	close(release)
	first, second := <-results, <-results
	for range 2 {
		if err := <-errorsOut; err != nil {
			t.Fatal(err)
		}
	}
	if stats := log.SnapshotStatsForTests(); stats.FullReads != 1 || stats.RetainedCall != 0 {
		t.Fatalf("nested callers did not share one flight: %#v", stats)
	}
	first.Entries[0].Usage.InputTokens = 99
	*first.Entries[0].FirstOutputMS = 99
	*first.Entries[0].TotalTokens = 99
	first.Entries[0].Attempts[0].Recovery[0] = "mutated"
	first.Entries[0].Attempts[0].Usage.InputTokens = 99
	*first.Entries[0].Attempts[0].FirstOutput = 99
	*first.Entries[0].Attempts[0].TotalTokens = 99
	*first.Entries[0].ModelSupportsServiceTier = false
	got := second.Entries[0]
	if got.Usage.InputTokens != 6 || *got.FirstOutputMS != 7 || *got.TotalTokens != 11 ||
		got.Attempts[0].Recovery[0] != "retry" || got.Attempts[0].Usage.InputTokens != 3 ||
		*got.Attempts[0].FirstOutput != 3 || *got.Attempts[0].TotalTokens != 5 || !*got.ModelSupportsServiceTier {
		t.Fatalf("nested snapshot state aliases another caller: %#v", got)
	}
}

func TestReadSnapshotCancellationDoesNotCancelSharedReadOrBlockAppend(t *testing.T) {
	path := filepath.Join(t.TempDir(), "usage.jsonl")
	writeSnapshotLog(t, path, "seed")
	log := NewLog(path)
	started := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	setBeforeSnapshotRead(t, log, func(Revision) {
		once.Do(func() { close(started) })
		<-release
	})
	acquired := make(chan struct{}, 2)
	setAfterSnapshotAcquire(t, log, func() { acquired <- struct{}{} })
	ctx, cancel := context.WithCancel(context.Background())
	cancelled := make(chan error, 1)
	go func() {
		_, err := log.ReadSnapshotForManagement(ctx)
		cancelled <- err
	}()
	<-started
	<-acquired
	follower := make(chan error, 1)
	go func() {
		_, err := log.ReadSnapshotForManagement(context.Background())
		follower <- err
	}()
	<-acquired
	cancel()
	if err := <-cancelled; !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled caller error = %v", err)
	}
	appendDone := make(chan error, 1)
	go func() {
		appendDone <- log.Append(Entry{RequestID: "append", Timestamp: 2, Provider: "p", Model: "m", Status: 200, UsageStatus: StatusReported})
	}()
	select {
	case err := <-appendDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("Append blocked behind a management snapshot read")
	}
	close(release)
	if err := <-follower; err != nil {
		t.Fatalf("shared follower failed after leader cancellation: %v", err)
	}
}

func TestCurrentRevisionDetectsSameSizeRewriteAndNativeIdentity(t *testing.T) {
	path := filepath.Join(t.TempDir(), "usage.jsonl")
	writeSnapshotLog(t, path, "aaa")
	log := NewLog(path)
	before, err := log.CurrentRevision()
	if err != nil {
		t.Fatal(err)
	}
	data := snapshotLine("bbb")
	if got, want := int64(len(data)), before.Size; got != want {
		t.Fatalf("test rows differ in size: got %d want %d", got, want)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	forced := time.Unix(1_700_000_000, 123_456_789)
	if err := os.Chtimes(path, forced, forced); err != nil {
		t.Fatal(err)
	}
	after, err := log.CurrentRevision()
	if err != nil {
		t.Fatal(err)
	}
	if before.Key() == after.Key() {
		t.Fatalf("same-size rewrite retained revision key: %#v", after)
	}
	if runtime.GOOS == "darwin" || runtime.GOOS == "linux" || runtime.GOOS == "windows" {
		if after.Device == 0 || after.Inode == 0 || after.weakIdentity {
			t.Fatalf("native identity missing on %s: %#v", runtime.GOOS, after)
		}
	}
}

func TestReadSnapshotBoundsRevisionChurnAndReleasesCalls(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "usage.jsonl")
	writeSnapshotLog(t, path, "seed")
	log := NewLog(path)
	var sequence int
	setAfterSnapshotAcquire(t, log, func() {
		sequence++
		replacement := filepath.Join(dir, fmt.Sprintf("replacement-%d.jsonl", sequence))
		writeSnapshotLog(t, replacement, fmt.Sprintf("next-%03d", sequence))
		if err := os.Rename(replacement, path); err != nil {
			t.Fatal(err)
		}
	})
	_, err := log.ReadSnapshotForManagement(context.Background())
	if !errors.Is(err, errSnapshotRevisionChanged) {
		t.Fatalf("revision churn error = %v", err)
	}
	if sequence != snapshotRevisionRetryLimit {
		t.Fatalf("revision attempts = %d, want %d", sequence, snapshotRevisionRetryLimit)
	}
	if stats := log.SnapshotStatsForTests(); stats.RetainedCall != 0 {
		t.Fatalf("revision churn retained calls: %#v", stats)
	}
}
