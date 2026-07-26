# 071 — Literal patch: revision-safe native usage snapshots

Apply this unified diff against `ddd968a0169e4c190bf1037e78a824c6780568e9`.
It preserves the existing `Log` append/read/clear API and adds a management-only
snapshot owner. The owner opens before inspecting, rejects non-regular files,
reads only the descriptor's observed length, shares work only by exact revision,
and drops the completed call (and its rows) before waking waiters.

```diff
diff --git a/go/internal/usage/log.go b/go/internal/usage/log.go
index 38522f26..adf88b70 100644
--- a/go/internal/usage/log.go
+++ b/go/internal/usage/log.go
@@ -87,6 +87,7 @@ type Entry struct {
 type Log struct {
-	path string
-	mu   sync.RWMutex
+	path     string
+	mu       sync.RWMutex
+	snapshot snapshotOwner
 }
 
 func NewLog(path string) *Log { return &Log{path: path} }
diff --git a/go/internal/usage/revision.go b/go/internal/usage/revision.go
new file mode 100644
index 00000000..11111111
--- /dev/null
+++ b/go/internal/usage/revision.go
@@ -0,0 +1,61 @@
+package usage
+
+import (
+	"fmt"
+	"os"
+)
+
+// Revision identifies the exact regular-file snapshot observed through an open
+// descriptor. Missing is explicit so an absent log cannot collide with a zeroed
+// identity returned by an unsupported platform.
+type Revision struct {
+	Path         string
+	Device       uint64
+	Inode        uint64
+	BirthTimeNS  int64
+	Size         int64
+	ModifyTimeNS int64
+	ChangeTimeNS int64
+	Missing      bool
+	weakIdentity bool
+}
+
+func (r Revision) Key() string {
+	if r.Missing {
+		return "missing\x00" + r.Path
+	}
+	return fmt.Sprintf("%s\x00%d\x00%d\x00%d\x00%d\x00%d\x00%d", r.Path, r.Device, r.Inode, r.BirthTimeNS, r.Size, r.ModifyTimeNS, r.ChangeTimeNS)
+}
+
+func revisionFromFile(path string, file *os.File) (Revision, error) {
+	info, err := file.Stat()
+	if err != nil {
+		return Revision{}, fmt.Errorf("stat usage log: %w", err)
+	}
+	if !info.Mode().IsRegular() {
+		return Revision{}, fmt.Errorf("usage log is not a regular file: %s", path)
+	}
+	identity, err := nativeRevisionIdentity(file, info)
+	if err != nil {
+		return Revision{}, fmt.Errorf("identify usage log: %w", err)
+	}
+	return Revision{
+		Path:         path,
+		Device:       identity.device,
+		Inode:        identity.inode,
+		BirthTimeNS:  identity.birthTimeNS,
+		Size:         info.Size(),
+		ModifyTimeNS: identity.modifyTimeNS,
+		ChangeTimeNS: identity.changeTimeNS,
+		weakIdentity: identity.weak,
+	}, nil
+}
+
+type nativeIdentity struct {
+	device       uint64
+	inode        uint64
+	birthTimeNS  int64
+	modifyTimeNS int64
+	changeTimeNS int64
+	weak         bool
+}
diff --git a/go/internal/usage/revision_darwin.go b/go/internal/usage/revision_darwin.go
new file mode 100644
index 00000000..22222222
--- /dev/null
+++ b/go/internal/usage/revision_darwin.go
@@ -0,0 +1,23 @@
+//go:build darwin
+
+package usage
+
+import (
+	"fmt"
+	"os"
+	"syscall"
+)
+
+func nativeRevisionIdentity(_ *os.File, info os.FileInfo) (nativeIdentity, error) {
+	stat, ok := info.Sys().(*syscall.Stat_t)
+	if !ok {
+		return nativeIdentity{}, fmt.Errorf("unexpected Darwin stat payload %T", info.Sys())
+	}
+	return nativeIdentity{
+		device:       uint64(stat.Dev),
+		inode:        stat.Ino,
+		birthTimeNS:  stat.Birthtimespec.Sec*1_000_000_000 + int64(stat.Birthtimespec.Nsec),
+		modifyTimeNS: stat.Mtimespec.Sec*1_000_000_000 + int64(stat.Mtimespec.Nsec),
+		changeTimeNS: stat.Ctimespec.Sec*1_000_000_000 + int64(stat.Ctimespec.Nsec),
+	}, nil
+}
diff --git a/go/internal/usage/revision_linux.go b/go/internal/usage/revision_linux.go
new file mode 100644
index 00000000..33333333
--- /dev/null
+++ b/go/internal/usage/revision_linux.go
@@ -0,0 +1,35 @@
+//go:build linux
+
+package usage
+
+import (
+	"fmt"
+	"os"
+	"syscall"
+
+	"golang.org/x/sys/unix"
+)
+
+func nativeRevisionIdentity(file *os.File, info os.FileInfo) (nativeIdentity, error) {
+	var statx unix.Statx_t
+	err := unix.Statx(int(file.Fd()), "", unix.AT_EMPTY_PATH|unix.AT_STATX_SYNC_AS_STAT, unix.STATX_BASIC_STATS|unix.STATX_BTIME, &statx)
+	if err == nil {
+		return nativeIdentity{
+			device:       unix.Mkdev(statx.Dev_major, statx.Dev_minor),
+			inode:        statx.Ino,
+			birthTimeNS:  statx.Btime.Sec*1_000_000_000 + int64(statx.Btime.Nsec),
+			modifyTimeNS: statx.Mtime.Sec*1_000_000_000 + int64(statx.Mtime.Nsec),
+			changeTimeNS: statx.Ctime.Sec*1_000_000_000 + int64(statx.Ctime.Nsec),
+		}, nil
+	}
+	stat, ok := info.Sys().(*syscall.Stat_t)
+	if !ok {
+		return nativeIdentity{}, fmt.Errorf("statx failed (%v) and fallback payload is %T", err, info.Sys())
+	}
+	return nativeIdentity{
+		device:       uint64(stat.Dev),
+		inode:        stat.Ino,
+		modifyTimeNS: stat.Mtim.Sec*1_000_000_000 + stat.Mtim.Nsec,
+		changeTimeNS: stat.Ctim.Sec*1_000_000_000 + stat.Ctim.Nsec,
+	}, nil
+}
diff --git a/go/internal/usage/revision_windows.go b/go/internal/usage/revision_windows.go
new file mode 100644
index 00000000..44444444
--- /dev/null
+++ b/go/internal/usage/revision_windows.go
@@ -0,0 +1,43 @@
+//go:build windows
+
+package usage
+
+import (
+	"os"
+	"unsafe"
+
+	"golang.org/x/sys/windows"
+)
+
+type windowsFileBasicInfo struct {
+	CreationTime   int64
+	LastAccessTime int64
+	LastWriteTime  int64
+	ChangeTime     int64
+	Attributes     uint32
+	_              uint32
+}
+
+func windowsTicksToUnixNano(ticks int64) int64 {
+	const windowsToUnixEpoch100NS = 116_444_736_000_000_000
+	return (ticks - windowsToUnixEpoch100NS) * 100
+}
+
+func nativeRevisionIdentity(file *os.File, _ os.FileInfo) (nativeIdentity, error) {
+	handle := windows.Handle(file.Fd())
+	var byHandle windows.ByHandleFileInformation
+	if err := windows.GetFileInformationByHandle(handle, &byHandle); err != nil {
+		return nativeIdentity{}, err
+	}
+	var basic windowsFileBasicInfo
+	if err := windows.GetFileInformationByHandleEx(handle, windows.FileBasicInfo, (*byte)(unsafe.Pointer(&basic)), uint32(unsafe.Sizeof(basic))); err != nil {
+		return nativeIdentity{}, err
+	}
+	return nativeIdentity{
+		device:       uint64(byHandle.VolumeSerialNumber),
+		inode:        uint64(byHandle.FileIndexHigh)<<32 | uint64(byHandle.FileIndexLow),
+		birthTimeNS:  windowsTicksToUnixNano(basic.CreationTime),
+		modifyTimeNS: windowsTicksToUnixNano(basic.LastWriteTime),
+		changeTimeNS: windowsTicksToUnixNano(basic.ChangeTime),
+	}, nil
+}
diff --git a/go/internal/usage/revision_fallback.go b/go/internal/usage/revision_fallback.go
new file mode 100644
index 00000000..55555555
--- /dev/null
+++ b/go/internal/usage/revision_fallback.go
@@ -0,0 +1,16 @@
+//go:build !darwin && !linux && !windows
+
+package usage
+
+import "os"
+
+// Unsupported platforms retain path/size/mtime observations but deliberately
+// mark the identity weak. snapshotOwner then refuses to coalesce callers under
+// this revision, which is safer than treating a same-size replacement as equal.
+func nativeRevisionIdentity(_ *os.File, info os.FileInfo) (nativeIdentity, error) {
+	return nativeIdentity{
+		modifyTimeNS: info.ModTime().UnixNano(),
+		changeTimeNS: info.ModTime().UnixNano(),
+		weak:         true,
+	}, nil
+}
diff --git a/go/internal/usage/snapshot.go b/go/internal/usage/snapshot.go
new file mode 100644
index 00000000..66666666
--- /dev/null
+++ b/go/internal/usage/snapshot.go
@@ -0,0 +1,174 @@
+package usage
+
+import (
+	"bytes"
+	"errors"
+	"fmt"
+	"io"
+	"os"
+	"sync"
+	"sync/atomic"
+)
+
+var errSnapshotRevisionChanged = errors.New("usage log revision changed before snapshot read")
+
+// Snapshot is a management read result. Entries is always owned by the caller.
+type Snapshot struct {
+	Entries  []Entry
+	Revision Revision
+}
+
+// SnapshotStats is test-only observability. It contains counters, never rows.
+type SnapshotStats struct {
+	FullReads    uint64
+	ParsedLines  uint64
+	RetainedCall int
+}
+
+type snapshotCall struct {
+	done     chan struct{}
+	entries  []Entry
+	revision Revision
+	err      error
+}
+
+type snapshotOwner struct {
+	mu                 sync.Mutex
+	calls              map[string]*snapshotCall
+	weakSequence       atomic.Uint64
+	fullReads          atomic.Uint64
+	parsedLines        atomic.Uint64
+	beforeReadForTests func(Revision)
+}
+
+// CurrentRevision opens the path first and derives identity from that descriptor.
+func (l *Log) CurrentRevision() (Revision, error) {
+	l.mu.RLock()
+	defer l.mu.RUnlock()
+	return l.currentRevision()
+}
+
+func (l *Log) currentRevision() (Revision, error) {
+	file, err := os.Open(l.path)
+	if errors.Is(err, os.ErrNotExist) {
+		return Revision{Path: l.path, Missing: true}, nil
+	}
+	if err != nil {
+		return Revision{}, fmt.Errorf("open usage log: %w", err)
+	}
+	defer file.Close()
+	return revisionFromFile(l.path, file)
+}
+
+// ReadSnapshotForManagement performs a descriptor-stable full read. Concurrent
+// callers share only an exact, strong revision and every caller receives its own
+// slice. Completed calls are removed before waiters are released.
+func (l *Log) ReadSnapshotForManagement() (Snapshot, error) {
+	l.mu.RLock()
+	defer l.mu.RUnlock()
+	for {
+		observed, err := l.currentRevision()
+		if err != nil {
+			return Snapshot{}, err
+		}
+		if observed.Missing {
+			return Snapshot{Entries: []Entry{}, Revision: observed}, nil
+		}
+		key := observed.Key()
+		if observed.weakIdentity {
+			key = fmt.Sprintf("%s\x00weak-%d", key, l.snapshot.weakSequence.Add(1))
+		}
+		call, leader := l.snapshot.acquire(key)
+		if leader {
+			l.snapshot.run(l.path, key, observed, call)
+		}
+		<-call.done
+		if errors.Is(call.err, errSnapshotRevisionChanged) {
+			continue
+		}
+		if call.err != nil {
+			return Snapshot{}, call.err
+		}
+		return Snapshot{Entries: append([]Entry(nil), call.entries...), Revision: call.revision}, nil
+	}
+}
+
+func (o *snapshotOwner) acquire(key string) (*snapshotCall, bool) {
+	o.mu.Lock()
+	defer o.mu.Unlock()
+	if call := o.calls[key]; call != nil {
+		return call, false
+	}
+	if o.calls == nil {
+		o.calls = make(map[string]*snapshotCall)
+	}
+	call := &snapshotCall{done: make(chan struct{})}
+	o.calls[key] = call
+	return call, true
+}
+
+func (o *snapshotOwner) run(path, key string, expected Revision, call *snapshotCall) {
+	call.entries, call.revision, call.err = o.read(path, expected)
+	o.mu.Lock()
+	if o.calls[key] == call {
+		delete(o.calls, key)
+	}
+	close(call.done)
+	o.mu.Unlock()
+}
+
+func (o *snapshotOwner) read(path string, expected Revision) ([]Entry, Revision, error) {
+	file, err := os.Open(path)
+	if err != nil {
+		return nil, Revision{}, fmt.Errorf("open usage log snapshot: %w", err)
+	}
+	defer file.Close()
+	revision, err := revisionFromFile(path, file)
+	if err != nil {
+		return nil, Revision{}, err
+	}
+	if revision.Key() != expected.Key() {
+		return nil, Revision{}, errSnapshotRevisionChanged
+	}
+	o.mu.Lock()
+	hook := o.beforeReadForTests
+	o.mu.Unlock()
+	if hook != nil {
+		hook(revision)
+	}
+	if revision.Size < 0 || uint64(revision.Size) > uint64(^uint(0)>>1) {
+		return nil, Revision{}, fmt.Errorf("usage log snapshot is too large: %d", revision.Size)
+	}
+	data := make([]byte, int(revision.Size))
+	if _, err := io.ReadFull(file, data); err != nil {
+		return nil, Revision{}, fmt.Errorf("usage log changed while snapshot was read: %w", err)
+	}
+	entries, err := readEntries(bytes.NewReader(data))
+	if err != nil {
+		return nil, Revision{}, err
+	}
+	o.fullReads.Add(1)
+	for _, line := range bytes.Split(data, []byte{'\n'}) {
+		if len(bytes.TrimSpace(line)) != 0 {
+			o.parsedLines.Add(1)
+		}
+	}
+	return entries, revision, nil
+}
+
+// SnapshotStatsForTests returns counters and the number of calls still retained
+// by the owner. RetainedCall must return to zero after every completed read.
+func (l *Log) SnapshotStatsForTests() SnapshotStats {
+	l.snapshot.mu.Lock()
+	defer l.snapshot.mu.Unlock()
+	return SnapshotStats{
+		FullReads:    l.snapshot.fullReads.Load(),
+		ParsedLines:  l.snapshot.parsedLines.Load(),
+		RetainedCall: len(l.snapshot.calls),
+	}
+}
+
+func (l *Log) resetSnapshotStatsForTests() {
+	l.snapshot.fullReads.Store(0)
+	l.snapshot.parsedLines.Store(0)
+}
diff --git a/go/internal/usage/snapshot_test.go b/go/internal/usage/snapshot_test.go
new file mode 100644
index 00000000..77777777
--- /dev/null
+++ b/go/internal/usage/snapshot_test.go
@@ -0,0 +1,284 @@
+package usage
+
+import (
+	"encoding/json"
+	"errors"
+	"fmt"
+	"io"
+	"os"
+	"path/filepath"
+	"runtime"
+	"sync"
+	"testing"
+	"time"
+)
+
+func snapshotLine(id string) []byte {
+	data, err := json.Marshal(Entry{
+		RequestID: id, Timestamp: 1, Provider: "openai", Model: "gpt-5.5",
+		Status: 200, DurationMS: 1, UsageStatus: StatusReported,
+	})
+	if err != nil {
+		panic(err)
+	}
+	return append(data, '\n')
+}
+
+func writeSnapshotLog(t *testing.T, path string, ids ...string) {
+	t.Helper()
+	data := make([]byte, 0)
+	for _, id := range ids {
+		data = append(data, snapshotLine(id)...)
+	}
+	if err := os.WriteFile(path, data, 0o600); err != nil {
+		t.Fatal(err)
+	}
+}
+
+func setBeforeSnapshotRead(t *testing.T, log *Log, hook func(Revision)) {
+	t.Helper()
+	log.snapshot.mu.Lock()
+	log.snapshot.beforeReadForTests = hook
+	log.snapshot.mu.Unlock()
+	t.Cleanup(func() {
+		log.snapshot.mu.Lock()
+		log.snapshot.beforeReadForTests = nil
+		log.snapshot.mu.Unlock()
+	})
+}
+
+func TestCurrentRevisionMissingDirectoryAndRegularFile(t *testing.T) {
+	dir := t.TempDir()
+	path := filepath.Join(dir, "usage.jsonl")
+	log := NewLog(path)
+	missing, err := log.CurrentRevision()
+	if err != nil || !missing.Missing || missing.Path != path {
+		t.Fatalf("missing revision = %#v, %v", missing, err)
+	}
+	if _, err := NewLog(dir).CurrentRevision(); err == nil {
+		t.Fatal("directory accepted as a usage snapshot")
+	}
+	writeSnapshotLog(t, path, "a")
+	first, err := log.CurrentRevision()
+	if err != nil || first.Missing || first.Size <= 0 || first.Key() == missing.Key() {
+		t.Fatalf("regular revision = %#v, %v", first, err)
+	}
+	file, err := os.Open(path)
+	if err != nil {
+		t.Fatal(err)
+	}
+	direct, err := revisionFromFile(path, file)
+	_ = file.Close()
+	if err != nil || direct.Key() != first.Key() {
+		t.Fatalf("descriptor revision = %#v, %v; want %q", direct, err, first.Key())
+	}
+	if err := os.WriteFile(path, append(snapshotLine("a"), snapshotLine("b")...), 0o600); err != nil {
+		t.Fatal(err)
+	}
+	appended, err := log.CurrentRevision()
+	if err != nil || appended.Key() == first.Key() || appended.Size <= first.Size {
+		t.Fatalf("append revision = %#v, %v", appended, err)
+	}
+	if err := os.Truncate(path, 0); err != nil {
+		t.Fatal(err)
+	}
+	truncated, err := log.CurrentRevision()
+	if err != nil || truncated.Key() == appended.Key() || truncated.Size != 0 {
+		t.Fatalf("truncate revision = %#v, %v", truncated, err)
+	}
+}
+
+func TestReadSnapshotReadsExactlyObservedLength(t *testing.T) {
+	path := filepath.Join(t.TempDir(), "usage.jsonl")
+	writeSnapshotLog(t, path, "old")
+	log := NewLog(path)
+	var once sync.Once
+	setBeforeSnapshotRead(t, log, func(Revision) {
+		once.Do(func() {
+			file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
+			if err != nil {
+				t.Fatal(err)
+			}
+			if _, err := file.Write(snapshotLine("late")); err != nil {
+				t.Fatal(err)
+			}
+			_ = file.Close()
+		})
+	})
+	snapshot, err := log.ReadSnapshotForManagement()
+	if err != nil {
+		t.Fatal(err)
+	}
+	if len(snapshot.Entries) != 1 || snapshot.Entries[0].RequestID != "old" {
+		t.Fatalf("snapshot entries = %#v", snapshot.Entries)
+	}
+	current, err := log.CurrentRevision()
+	if err != nil || current.Size <= snapshot.Revision.Size {
+		t.Fatalf("current revision = %#v, %v; snapshot = %#v", current, err, snapshot.Revision)
+	}
+}
+
+func TestReadSnapshotFailsOnShortReadAfterTruncate(t *testing.T) {
+	path := filepath.Join(t.TempDir(), "usage.jsonl")
+	writeSnapshotLog(t, path, "old", "tail")
+	log := NewLog(path)
+	var once sync.Once
+	setBeforeSnapshotRead(t, log, func(Revision) {
+		once.Do(func() {
+			if err := os.Truncate(path, 1); err != nil {
+				t.Fatal(err)
+			}
+		})
+	})
+	_, err := log.ReadSnapshotForManagement()
+	if err == nil || !errors.Is(err, io.ErrUnexpectedEOF) {
+		t.Fatalf("short read error = %v", err)
+	}
+	if stats := log.SnapshotStatsForTests(); stats.FullReads != 0 || stats.RetainedCall != 0 {
+		t.Fatalf("stats after short read = %#v", stats)
+	}
+}
+
+func TestReadSnapshotSameRevisionSharesOneReadAndClonesSlices(t *testing.T) {
+	path := filepath.Join(t.TempDir(), "usage.jsonl")
+	writeSnapshotLog(t, path, "one", "two")
+	log := NewLog(path)
+	started := make(chan struct{})
+	release := make(chan struct{})
+	var once sync.Once
+	setBeforeSnapshotRead(t, log, func(Revision) {
+		once.Do(func() { close(started) })
+		<-release
+	})
+	const readers = 12
+	results := make(chan Snapshot, readers)
+	errorsOut := make(chan error, readers)
+	for range readers {
+		go func() {
+			snapshot, err := log.ReadSnapshotForManagement()
+			results <- snapshot
+			errorsOut <- err
+		}()
+	}
+	<-started
+	time.Sleep(10 * time.Millisecond)
+	close(release)
+	snapshots := make([]Snapshot, 0, readers)
+	for range readers {
+		if err := <-errorsOut; err != nil {
+			t.Fatal(err)
+		}
+		snapshots = append(snapshots, <-results)
+	}
+	if stats := log.SnapshotStatsForTests(); stats.FullReads != 1 || stats.ParsedLines != 2 || stats.RetainedCall != 0 {
+		t.Fatalf("shared-read stats = %#v", stats)
+	}
+	snapshots[0].Entries[0].RequestID = "mutated"
+	if snapshots[1].Entries[0].RequestID != "one" {
+		t.Fatalf("caller slices alias: %#v", snapshots[1].Entries)
+	}
+}
+
+func TestReadSnapshotReplacementDoesNotJoinOldRevision(t *testing.T) {
+	if runtime.GOOS == "windows" {
+		t.Skip("rename of an open file is filesystem-policy dependent on Windows")
+	}
+	dir := t.TempDir()
+	path := filepath.Join(dir, "usage.jsonl")
+	writeSnapshotLog(t, path, "old")
+	log := NewLog(path)
+	oldRevision, err := log.CurrentRevision()
+	if err != nil {
+		t.Fatal(err)
+	}
+	started := make(chan struct{})
+	release := make(chan struct{})
+	var once sync.Once
+	setBeforeSnapshotRead(t, log, func(revision Revision) {
+		if revision.Key() != oldRevision.Key() {
+			return
+		}
+		once.Do(func() { close(started) })
+		<-release
+	})
+	oldResult := make(chan Snapshot, 1)
+	oldError := make(chan error, 1)
+	go func() {
+		snapshot, err := log.ReadSnapshotForManagement()
+		oldResult <- snapshot
+		oldError <- err
+	}()
+	<-started
+	replacement := filepath.Join(dir, "replacement.jsonl")
+	writeSnapshotLog(t, replacement, "new")
+	if err := os.Rename(replacement, path); err != nil {
+		t.Fatal(err)
+	}
+	newSnapshot, err := log.ReadSnapshotForManagement()
+	if err != nil {
+		t.Fatal(err)
+	}
+	close(release)
+	if err := <-oldError; err != nil {
+		t.Fatal(err)
+	}
+	oldSnapshot := <-oldResult
+	if got := oldSnapshot.Entries[0].RequestID; got != "old" {
+		t.Fatalf("old snapshot id = %q", got)
+	}
+	if got := newSnapshot.Entries[0].RequestID; got != "new" {
+		t.Fatalf("new snapshot id = %q", got)
+	}
+	if oldSnapshot.Revision.Key() == newSnapshot.Revision.Key() {
+		t.Fatal("replacement reused the old revision")
+	}
+	if stats := log.SnapshotStatsForTests(); stats.FullReads != 2 || stats.RetainedCall != 0 {
+		t.Fatalf("replacement stats = %#v", stats)
+	}
+}
+
+func TestReadSnapshotToleratesMalformedRowsWithoutRetainingRows(t *testing.T) {
+	path := filepath.Join(t.TempDir(), "usage.jsonl")
+	data := append(snapshotLine("valid"), []byte("{partial\n")...)
+	if err := os.WriteFile(path, data, 0o600); err != nil {
+		t.Fatal(err)
+	}
+	log := NewLog(path)
+	snapshot, err := log.ReadSnapshotForManagement()
+	if err != nil || len(snapshot.Entries) != 1 || snapshot.Entries[0].RequestID != "valid" {
+		t.Fatalf("snapshot = %#v, %v", snapshot, err)
+	}
+	if stats := log.SnapshotStatsForTests(); stats.ParsedLines != 2 || stats.RetainedCall != 0 {
+		t.Fatalf("malformed-row stats = %#v", stats)
+	}
+}
+
+func TestReadSnapshotConcurrentWithAppendIsRaceFree(t *testing.T) {
+	path := filepath.Join(t.TempDir(), "usage.jsonl")
+	log := NewLog(path)
+	if err := log.Append(Entry{RequestID: "seed", Timestamp: 1, Provider: "p", Model: "m", Status: 200, UsageStatus: StatusReported}); err != nil {
+		t.Fatal(err)
+	}
+	const rounds = 40
+	var wg sync.WaitGroup
+	for i := range rounds {
+		wg.Add(2)
+		go func(index int) {
+			defer wg.Done()
+			entry := Entry{RequestID: fmt.Sprintf("append-%d", index), Timestamp: int64(index + 2), Provider: "p", Model: "m", Status: 200, UsageStatus: StatusReported}
+			if err := log.Append(entry); err != nil {
+				t.Errorf("Append(%d): %v", index, err)
+			}
+		}(i)
+		go func() {
+			defer wg.Done()
+			if _, err := log.ReadSnapshotForManagement(); err != nil {
+				t.Errorf("ReadSnapshotForManagement: %v", err)
+			}
+		}()
+	}
+	wg.Wait()
+	if stats := log.SnapshotStatsForTests(); stats.RetainedCall != 0 {
+		t.Fatalf("race test retained calls = %#v", stats)
+	}
+}
```

Verification after applying:

```bash
cd go
gofmt -w internal/usage/log.go internal/usage/revision*.go internal/usage/snapshot*.go
go test -race ./internal/usage -count=1
go test ./internal/usage ./internal/management ./internal/server -count=1
go vet ./...
GOOS=darwin GOARCH=arm64 go test -c -o /tmp/ocx-usage-darwin.test ./internal/usage
GOOS=linux GOARCH=amd64 go test -c -o /tmp/ocx-usage-linux.test ./internal/usage
GOOS=windows GOARCH=amd64 go test -c -o /tmp/ocx-usage-windows.test.exe ./internal/usage
```
