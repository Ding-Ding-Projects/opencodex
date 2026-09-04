# 071 — Literal patch: revision-safe native usage snapshots

Apply this unified diff against `8a029c843dd4785b0a8d6ed9a5e8b39fd357a4bb`.
It preserves the existing append/read/clear API and adds a context-aware
management snapshot owner. Exact strong revisions share one detached in-flight
read, each caller receives a deep clone, cancelled callers leave shared work
alive, and revision churn stops after 64 attempts. The real
`GET /api/usage` path consumes the snapshot while `/healthz` remains
independent.

```diff
diff --git a/go/internal/management/logs.go b/go/internal/management/logs.go
index 38645f1a..50f27911 100644
--- a/go/internal/management/logs.go
+++ b/go/internal/management/logs.go
@@ -297,11 +297,12 @@ func (a *API) handleLogs(w http.ResponseWriter, r *http.Request) bool {
 			writeJSON(w, http.StatusOK, usage.Summarize(nil, window, time.Now(), surface))
 			return true
 		}
-		entries, err := a.usageLog.ReadAll()
+		snapshot, err := a.usageLog.ReadSnapshotForManagement(r.Context())
 		if err != nil {
 			writeError(w, http.StatusInternalServerError, "usage log could not be read")
 			return true
 		}
+		entries := snapshot.Entries
 		writeJSON(w, http.StatusOK, usageSummaryResponse(usage.Summarize(entries, window, time.Now(), surface), entries))
 		return true
 	case "GET /api/storage":
diff --git a/go/internal/server/usage_snapshot_concurrency_test.go b/go/internal/server/usage_snapshot_concurrency_test.go
new file mode 100644
index 00000000..a6a24092
--- /dev/null
+++ b/go/internal/server/usage_snapshot_concurrency_test.go
@@ -0,0 +1,72 @@
+package server
+
+import (
+	"bytes"
+	"net/http"
+	"net/http/httptest"
+	"os"
+	"path/filepath"
+	"testing"
+	"time"
+
+	appconfig "github.com/lidge-jun/opencodex-go/internal/config"
+	"github.com/lidge-jun/opencodex-go/internal/usage"
+)
+
+func TestProductionUsageSnapshotRebuildDoesNotBlockHealthz(t *testing.T) {
+	path := filepath.Join(t.TempDir(), "usage.jsonl")
+	line := []byte(`{"requestId":"large","timestamp":1,"provider":"p","model":"m","status":200,"durationMs":1,"usageStatus":"reported"}` + "\n")
+	if err := os.WriteFile(path, bytes.Repeat(line, 200_000), 0o600); err != nil {
+		t.Fatal(err)
+	}
+	log := usage.NewLog(path)
+	cfg := appconfig.Default()
+	proxy := New(Config{UsageRecorder: log, ManagementConfig: &cfg})
+	defer proxy.Close()
+
+	usageDone := make(chan *httptest.ResponseRecorder, 1)
+	go func() {
+		response := httptest.NewRecorder()
+		proxy.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/usage?range=all", nil))
+		usageDone <- response
+	}()
+
+	deadline := time.Now().Add(5 * time.Second)
+	for log.SnapshotStatsForTests().RetainedCall == 0 {
+		select {
+		case response := <-usageDone:
+			t.Fatalf("usage rebuild completed before its production snapshot became observable: %d %s", response.Code, response.Body.String())
+		default:
+		}
+		if time.Now().After(deadline) {
+			t.Fatal("production usage route did not enter snapshot rebuild")
+		}
+	}
+
+	healthDone := make(chan *httptest.ResponseRecorder, 1)
+	go func() {
+		response := httptest.NewRecorder()
+		proxy.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/healthz", nil))
+		healthDone <- response
+	}()
+	select {
+	case response := <-healthDone:
+		if response.Code != http.StatusOK {
+			t.Fatalf("healthz response = %d %s", response.Code, response.Body.String())
+		}
+	case <-time.After(time.Second):
+		t.Fatal("healthz blocked behind a production usage rebuild")
+	}
+
+	select {
+	case response := <-usageDone:
+		if response.Code != http.StatusOK {
+			t.Fatalf("usage response = %d %s", response.Code, response.Body.String())
+		}
+	case <-time.After(20 * time.Second):
+		t.Fatal("production usage rebuild did not complete")
+	}
+	if stats := log.SnapshotStatsForTests(); stats.FullReads != 1 || stats.RetainedCall != 0 {
+		t.Fatalf("production usage route bypassed snapshot owner: %#v", stats)
+	}
+}
diff --git a/go/internal/usage/log.go b/go/internal/usage/log.go
index 24414e0b..c175aa1d 100644
--- a/go/internal/usage/log.go
+++ b/go/internal/usage/log.go
@@ -85,8 +85,9 @@ type Entry struct {
 // Log is an append-only JSONL usage recorder. Its mutex makes append/read/clear
 // safe within one process; O_APPEND keeps individual records atomic at the OS boundary.
 type Log struct {
-	path string
-	mu   sync.RWMutex
+	path     string
+	mu       sync.RWMutex
+	snapshot snapshotOwner
 }
 
 func NewLog(path string) *Log { return &Log{path: path} }
@@ -240,10 +241,35 @@ func normalizeEntry(entry Entry) Entry {
 	entry.RequestedServiceTier = capString(entry.RequestedServiceTier, 64)
 	entry.ConfiguredServiceTier = capString(entry.ConfiguredServiceTier, 64)
 	entry.ResponseServiceTier = capString(entry.ResponseServiceTier, 64)
-	if entry.Usage != nil {
-		entry.Usage = cloneUsage(entry.Usage)
+	return cloneEntry(entry)
+}
+
+func cloneEntries(entries []Entry) []Entry {
+	cloned := make([]Entry, len(entries))
+	for index := range entries {
+		cloned[index] = cloneEntry(entries[index])
+	}
+	return cloned
+}
+
+func cloneEntry(entry Entry) Entry {
+	attempts := entry.Attempts
+	entry.FirstOutputMS = cloneInt64(entry.FirstOutputMS)
+	entry.Usage = cloneUsage(entry.Usage)
+	entry.TotalTokens = cloneInt(entry.TotalTokens)
+	entry.ModelSupportsServiceTier = cloneBool(entry.ModelSupportsServiceTier)
+	if attempts == nil {
+		entry.Attempts = nil
+		return entry
+	}
+	entry.Attempts = make([]Attempt, len(attempts))
+	for index, attempt := range attempts {
+		attempt.FirstOutput = cloneInt64(attempt.FirstOutput)
+		attempt.Recovery = append([]string(nil), attempt.Recovery...)
+		attempt.Usage = cloneUsage(attempt.Usage)
+		attempt.TotalTokens = cloneInt(attempt.TotalTokens)
+		entry.Attempts[index] = attempt
 	}
-	entry.Attempts = append([]Attempt(nil), entry.Attempts...)
 	return entry
 }
 
@@ -255,6 +281,30 @@ func cloneUsage(value *types.Usage) *types.Usage {
 	return &clone
 }
 
+func cloneInt(value *int) *int {
+	if value == nil {
+		return nil
+	}
+	clone := *value
+	return &clone
+}
+
+func cloneInt64(value *int64) *int64 {
+	if value == nil {
+		return nil
+	}
+	clone := *value
+	return &clone
+}
+
+func cloneBool(value *bool) *bool {
+	if value == nil {
+		return nil
+	}
+	clone := *value
+	return &clone
+}
+
 func capString(value string, max int) string {
 	if len(value) > max {
 		return value[:max]
diff --git a/go/internal/usage/revision.go b/go/internal/usage/revision.go
new file mode 100644
index 00000000..78bba570
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
index 00000000..ac72b60e
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
diff --git a/go/internal/usage/revision_fallback.go b/go/internal/usage/revision_fallback.go
new file mode 100644
index 00000000..94ec8fcb
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
diff --git a/go/internal/usage/revision_linux.go b/go/internal/usage/revision_linux.go
new file mode 100644
index 00000000..d689090b
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
index 00000000..6ef63534
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
diff --git a/go/internal/usage/snapshot.go b/go/internal/usage/snapshot.go
new file mode 100644
index 00000000..226c5abb
--- /dev/null
+++ b/go/internal/usage/snapshot.go
@@ -0,0 +1,197 @@
+package usage
+
+import (
+	"bytes"
+	"context"
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
+const snapshotRevisionRetryLimit = 64
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
+	mu                   sync.Mutex
+	calls                map[string]*snapshotCall
+	weakSequence         atomic.Uint64
+	fullReads            atomic.Uint64
+	parsedLines          atomic.Uint64
+	beforeReadForTests   func(Revision)
+	afterAcquireForTests func()
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
+func (l *Log) ReadSnapshotForManagement(ctx context.Context) (Snapshot, error) {
+	if ctx == nil {
+		ctx = context.Background()
+	}
+	for attempt := 0; attempt < snapshotRevisionRetryLimit; attempt++ {
+		if err := ctx.Err(); err != nil {
+			return Snapshot{}, err
+		}
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
+		l.snapshot.notifyAcquireForTests()
+		if leader {
+			go l.snapshot.run(l.path, key, observed, call)
+		}
+		select {
+		case <-ctx.Done():
+			return Snapshot{}, ctx.Err()
+		case <-call.done:
+		}
+		if errors.Is(call.err, errSnapshotRevisionChanged) {
+			continue
+		}
+		if call.err != nil {
+			return Snapshot{}, call.err
+		}
+		return Snapshot{Entries: cloneEntries(call.entries), Revision: call.revision}, nil
+	}
+	return Snapshot{}, fmt.Errorf("%w after %d attempts", errSnapshotRevisionChanged, snapshotRevisionRetryLimit)
+}
+
+func (o *snapshotOwner) notifyAcquireForTests() {
+	o.mu.Lock()
+	hook := o.afterAcquireForTests
+	o.mu.Unlock()
+	if hook != nil {
+		hook()
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
index 00000000..6637b787
--- /dev/null
+++ b/go/internal/usage/snapshot_test.go
@@ -0,0 +1,480 @@
+package usage
+
+import (
+	"context"
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
+
+	"github.com/lidge-jun/opencodex-go/internal/types"
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
+func setAfterSnapshotAcquire(t *testing.T, log *Log, hook func()) {
+	t.Helper()
+	log.snapshot.mu.Lock()
+	log.snapshot.afterAcquireForTests = hook
+	log.snapshot.mu.Unlock()
+	t.Cleanup(func() {
+		log.snapshot.mu.Lock()
+		log.snapshot.afterAcquireForTests = nil
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
+	snapshot, err := log.ReadSnapshotForManagement(context.Background())
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
+	_, err := log.ReadSnapshotForManagement(context.Background())
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
+	acquired := make(chan struct{}, readers)
+	setAfterSnapshotAcquire(t, log, func() { acquired <- struct{}{} })
+	results := make(chan Snapshot, readers)
+	errorsOut := make(chan error, readers)
+	for range readers {
+		go func() {
+			snapshot, err := log.ReadSnapshotForManagement(context.Background())
+			results <- snapshot
+			errorsOut <- err
+		}()
+	}
+	<-started
+	for range readers {
+		<-acquired
+	}
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
+		snapshot, err := log.ReadSnapshotForManagement(context.Background())
+		oldResult <- snapshot
+		oldError <- err
+	}()
+	<-started
+	replacement := filepath.Join(dir, "replacement.jsonl")
+	writeSnapshotLog(t, replacement, "new")
+	if err := os.Rename(replacement, path); err != nil {
+		t.Fatal(err)
+	}
+	newSnapshot, err := log.ReadSnapshotForManagement(context.Background())
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
+	snapshot, err := log.ReadSnapshotForManagement(context.Background())
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
+			if _, err := log.ReadSnapshotForManagement(context.Background()); err != nil {
+				t.Errorf("ReadSnapshotForManagement: %v", err)
+			}
+		}()
+	}
+	wg.Wait()
+	if stats := log.SnapshotStatsForTests(); stats.RetainedCall != 0 {
+		t.Fatalf("race test retained calls = %#v", stats)
+	}
+}
+
+func TestReadSnapshotDeepClonesNestedEntryState(t *testing.T) {
+	path := filepath.Join(t.TempDir(), "usage.jsonl")
+	firstOutput, total, attemptFirstOutput, attemptTotal := int64(7), 11, int64(3), 5
+	modelTier := true
+	entry := Entry{
+		RequestID: "nested", Timestamp: 1, Provider: "openai", Model: "gpt-5.5",
+		Status: 200, DurationMS: 10, FirstOutputMS: &firstOutput,
+		UsageStatus: StatusReported, Usage: &types.Usage{InputTokens: 6, OutputTokens: 5}, TotalTokens: &total,
+		Attempts: []Attempt{{Ordinal: 1, Provider: "openai", Model: "gpt-5.5", HTTPStatus: 200,
+			FirstOutput: &attemptFirstOutput, Recovery: []string{"retry"}, UsageStatus: StatusReported,
+			Usage: &types.Usage{InputTokens: 3, OutputTokens: 2}, TotalTokens: &attemptTotal}},
+		ModelSupportsServiceTier: &modelTier,
+	}
+	data, err := json.Marshal(entry)
+	if err != nil {
+		t.Fatal(err)
+	}
+	if err := os.WriteFile(path, append(data, '\n'), 0o600); err != nil {
+		t.Fatal(err)
+	}
+	log := NewLog(path)
+	started := make(chan struct{})
+	release := make(chan struct{})
+	var once sync.Once
+	setBeforeSnapshotRead(t, log, func(Revision) {
+		once.Do(func() { close(started) })
+		<-release
+	})
+	acquired := make(chan struct{}, 2)
+	setAfterSnapshotAcquire(t, log, func() { acquired <- struct{}{} })
+	results := make(chan Snapshot, 2)
+	errorsOut := make(chan error, 2)
+	for range 2 {
+		go func() {
+			snapshot, err := log.ReadSnapshotForManagement(context.Background())
+			results <- snapshot
+			errorsOut <- err
+		}()
+	}
+	<-started
+	for range 2 {
+		<-acquired
+	}
+	close(release)
+	first, second := <-results, <-results
+	for range 2 {
+		if err := <-errorsOut; err != nil {
+			t.Fatal(err)
+		}
+	}
+	if stats := log.SnapshotStatsForTests(); stats.FullReads != 1 || stats.RetainedCall != 0 {
+		t.Fatalf("nested callers did not share one flight: %#v", stats)
+	}
+	first.Entries[0].Usage.InputTokens = 99
+	*first.Entries[0].FirstOutputMS = 99
+	*first.Entries[0].TotalTokens = 99
+	first.Entries[0].Attempts[0].Recovery[0] = "mutated"
+	first.Entries[0].Attempts[0].Usage.InputTokens = 99
+	*first.Entries[0].Attempts[0].FirstOutput = 99
+	*first.Entries[0].Attempts[0].TotalTokens = 99
+	*first.Entries[0].ModelSupportsServiceTier = false
+	got := second.Entries[0]
+	if got.Usage.InputTokens != 6 || *got.FirstOutputMS != 7 || *got.TotalTokens != 11 ||
+		got.Attempts[0].Recovery[0] != "retry" || got.Attempts[0].Usage.InputTokens != 3 ||
+		*got.Attempts[0].FirstOutput != 3 || *got.Attempts[0].TotalTokens != 5 || !*got.ModelSupportsServiceTier {
+		t.Fatalf("nested snapshot state aliases another caller: %#v", got)
+	}
+}
+
+func TestReadSnapshotCancellationDoesNotCancelSharedReadOrBlockAppend(t *testing.T) {
+	path := filepath.Join(t.TempDir(), "usage.jsonl")
+	writeSnapshotLog(t, path, "seed")
+	log := NewLog(path)
+	started := make(chan struct{})
+	release := make(chan struct{})
+	var once sync.Once
+	setBeforeSnapshotRead(t, log, func(Revision) {
+		once.Do(func() { close(started) })
+		<-release
+	})
+	acquired := make(chan struct{}, 2)
+	setAfterSnapshotAcquire(t, log, func() { acquired <- struct{}{} })
+	ctx, cancel := context.WithCancel(context.Background())
+	cancelled := make(chan error, 1)
+	go func() {
+		_, err := log.ReadSnapshotForManagement(ctx)
+		cancelled <- err
+	}()
+	<-started
+	<-acquired
+	follower := make(chan error, 1)
+	go func() {
+		_, err := log.ReadSnapshotForManagement(context.Background())
+		follower <- err
+	}()
+	<-acquired
+	cancel()
+	if err := <-cancelled; !errors.Is(err, context.Canceled) {
+		t.Fatalf("cancelled caller error = %v", err)
+	}
+	appendDone := make(chan error, 1)
+	go func() {
+		appendDone <- log.Append(Entry{RequestID: "append", Timestamp: 2, Provider: "p", Model: "m", Status: 200, UsageStatus: StatusReported})
+	}()
+	select {
+	case err := <-appendDone:
+		if err != nil {
+			t.Fatal(err)
+		}
+	case <-time.After(time.Second):
+		t.Fatal("Append blocked behind a management snapshot read")
+	}
+	close(release)
+	if err := <-follower; err != nil {
+		t.Fatalf("shared follower failed after leader cancellation: %v", err)
+	}
+}
+
+func TestCurrentRevisionDetectsSameSizeRewriteAndNativeIdentity(t *testing.T) {
+	path := filepath.Join(t.TempDir(), "usage.jsonl")
+	writeSnapshotLog(t, path, "aaa")
+	log := NewLog(path)
+	before, err := log.CurrentRevision()
+	if err != nil {
+		t.Fatal(err)
+	}
+	data := snapshotLine("bbb")
+	if got, want := int64(len(data)), before.Size; got != want {
+		t.Fatalf("test rows differ in size: got %d want %d", got, want)
+	}
+	if err := os.WriteFile(path, data, 0o600); err != nil {
+		t.Fatal(err)
+	}
+	forced := time.Unix(1_700_000_000, 123_456_789)
+	if err := os.Chtimes(path, forced, forced); err != nil {
+		t.Fatal(err)
+	}
+	after, err := log.CurrentRevision()
+	if err != nil {
+		t.Fatal(err)
+	}
+	if before.Key() == after.Key() {
+		t.Fatalf("same-size rewrite retained revision key: %#v", after)
+	}
+	if runtime.GOOS == "darwin" || runtime.GOOS == "linux" || runtime.GOOS == "windows" {
+		if after.Device == 0 || after.Inode == 0 || after.weakIdentity {
+			t.Fatalf("native identity missing on %s: %#v", runtime.GOOS, after)
+		}
+	}
+}
+
+func TestReadSnapshotBoundsRevisionChurnAndReleasesCalls(t *testing.T) {
+	dir := t.TempDir()
+	path := filepath.Join(dir, "usage.jsonl")
+	writeSnapshotLog(t, path, "seed")
+	log := NewLog(path)
+	var sequence int
+	setAfterSnapshotAcquire(t, log, func() {
+		sequence++
+		replacement := filepath.Join(dir, fmt.Sprintf("replacement-%d.jsonl", sequence))
+		writeSnapshotLog(t, replacement, fmt.Sprintf("next-%03d", sequence))
+		if err := os.Rename(replacement, path); err != nil {
+			t.Fatal(err)
+		}
+	})
+	_, err := log.ReadSnapshotForManagement(context.Background())
+	if !errors.Is(err, errSnapshotRevisionChanged) {
+		t.Fatalf("revision churn error = %v", err)
+	}
+	if sequence != snapshotRevisionRetryLimit {
+		t.Fatalf("revision attempts = %d, want %d", sequence, snapshotRevisionRetryLimit)
+	}
+	if stats := log.SnapshotStatsForTests(); stats.RetainedCall != 0 {
+		t.Fatalf("revision churn retained calls: %#v", stats)
+	}
+}
```

Verification after applying:

```bash
cd go
gofmt -w internal/management/logs.go internal/server/usage_snapshot_concurrency_test.go internal/usage/log.go internal/usage/revision*.go internal/usage/snapshot*.go
go test -race ./internal/usage -count=1
go test -race ./internal/usage -run 'TestReadSnapshot(SameRevisionSharesOneReadAndClonesSlices|CancellationDoesNotCancelSharedReadOrBlockAppend|DeepClonesNestedEntryState)' -count=20
go test ./internal/usage ./internal/management ./internal/server -count=1
go test ./internal/server -run TestProductionUsageSnapshotRebuildDoesNotBlockHealthz -count=1
go vet ./...
GOOS=darwin GOARCH=arm64 go test -c -o /tmp/ocx-usage-darwin.test ./internal/usage
GOOS=linux GOARCH=amd64 go test -c -o /tmp/ocx-usage-linux.test ./internal/usage
GOOS=windows GOARCH=amd64 go test -c -o /tmp/ocx-usage-windows.test.exe ./internal/usage
```

