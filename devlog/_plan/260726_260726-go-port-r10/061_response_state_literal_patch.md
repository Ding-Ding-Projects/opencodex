# 061 — Response-state recovery literal patch

Verified base after the second current-dev rebase: `ddd968a0169e4c190bf1037e78a824c6780568e9`

This is the complete apply-ready implementation diff for
[060_response_state_recovery.md](./060_response_state_recovery.md). It uses the
current TypeScript owner and tests as the behavioral oracle, keeps
`ProcessAlive` unchanged, and adds a separate conservative process-existence
contract for stale-file cleanup.

## Apply

Extract the fenced diff and apply it at repository root with `git apply`.
The patch includes every production, platform, test, and structure file.

## Literal diff

```diff
diff --git a/go/internal/platform/process.go b/go/internal/platform/process.go
index 933b1eab7a6b0bb309d2b28d7a7014b3aaac401e..47e20dd02e6711ded0ad872a6167215c30f44076 100644
--- a/go/internal/platform/process.go
+++ b/go/internal/platform/process.go
@@ -30,6 +30,15 @@ func ProcessAlive(pid int) bool {
 	return process.Signal(syscall.Signal(0)) == nil
 }
 
+// ProcessExists conservatively reports process existence for stale-file recovery.
+// It returns false only when the operating system definitively reports absence.
+func ProcessExists(pid int) bool {
+	if pid <= 0 {
+		return false
+	}
+	return processExists(pid)
+}
+
 func WaitForExit(ctx context.Context, pid int) bool {
 	ticker := time.NewTicker(50 * time.Millisecond)
 	defer ticker.Stop()
diff --git a/go/internal/platform/process_exists_test.go b/go/internal/platform/process_exists_test.go
new file mode 100644
index 0000000000000000000000000000000000000000..27591682138e0030e72b5dc07a7b766717df7e50
--- /dev/null
+++ b/go/internal/platform/process_exists_test.go
@@ -0,0 +1,17 @@
+package platform
+
+import (
+	"os"
+	"testing"
+)
+
+func TestProcessExistsRejectsInvalidAndProtectsCurrentProcess(t *testing.T) {
+	for _, pid := range []int{-1, 0} {
+		if ProcessExists(pid) {
+			t.Fatalf("invalid pid %d reported as existing", pid)
+		}
+	}
+	if !ProcessExists(os.Getpid()) {
+		t.Fatal("current process reported absent")
+	}
+}
diff --git a/go/internal/platform/process_exists_unix.go b/go/internal/platform/process_exists_unix.go
new file mode 100644
index 0000000000000000000000000000000000000000..9f3e1d0490a7fa46a0c9436bddfc622751fbcb4a
--- /dev/null
+++ b/go/internal/platform/process_exists_unix.go
@@ -0,0 +1,13 @@
+//go:build !windows
+
+package platform
+
+import (
+	"errors"
+	"syscall"
+)
+
+func processExists(pid int) bool {
+	err := syscall.Kill(pid, 0)
+	return err == nil || !errors.Is(err, syscall.ESRCH)
+}
diff --git a/go/internal/platform/process_exists_windows.go b/go/internal/platform/process_exists_windows.go
new file mode 100644
index 0000000000000000000000000000000000000000..2a133c77855e13b32198eedce8645580a9e2801e
--- /dev/null
+++ b/go/internal/platform/process_exists_windows.go
@@ -0,0 +1,22 @@
+//go:build windows
+
+package platform
+
+import (
+	"errors"
+	"math"
+
+	"golang.org/x/sys/windows"
+)
+
+func processExists(pid int) bool {
+	if uint64(pid) > math.MaxUint32 {
+		return false
+	}
+	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
+	if err == nil {
+		windows.CloseHandle(handle)
+		return true
+	}
+	return !errors.Is(err, windows.ERROR_INVALID_PARAMETER)
+}
diff --git a/go/internal/server/responses_state.go b/go/internal/server/responses_state.go
index f1b9e1a86e53a1187ac454c0c8124e59af6fe8d4..bede400853a4650cddacaf706221f50fc834a77e 100644
--- a/go/internal/server/responses_state.go
+++ b/go/internal/server/responses_state.go
@@ -3,24 +3,171 @@ package server
 import (
 	"encoding/json"
 	"errors"
+	"io"
 	"os"
 	"path/filepath"
+	"strconv"
+	"strings"
 	"sync"
+	"sync/atomic"
 	"time"
 
 	"github.com/lidge-jun/opencodex-go/internal/bridge"
+	"github.com/lidge-jun/opencodex-go/internal/platform"
 	"github.com/lidge-jun/opencodex-go/internal/types"
 )
 
 const (
-	maxStoredResponses       = 1000
-	responseStateTTL         = time.Hour
-	maxStoredResponseBytes   = 64 << 20
-	responseSnapshotEntryMax = 2 << 20
-	responseSnapshotTotalMax = 24 << 20
-	responseSnapshotDebounce = 2 * time.Second
+	maxStoredResponses        = 1000
+	responseStateTTL          = time.Hour
+	maxStoredResponseBytes    = 64 << 20
+	responseSnapshotEntryMax  = 2 << 20
+	responseSnapshotTotalMax  = 24 << 20
+	responseSnapshotDebounce  = 2 * time.Second
+	responseStateTempGrace    = 15 * time.Minute
+	responseStateTempEntries  = 4096
+	responseStateTempCleanups = 512
+	responseStateTempMaxSafe  = uint64(1<<53 - 1)
 )
 
+var responseStateTempSequence atomic.Uint64
+
+type ResponseStateTempRecoveryResult struct {
+	Matched      int
+	Removed      int
+	Failed       int
+	BytesRemoved int64
+}
+
+type responseStateTempDir interface {
+	ReadDir(int) ([]os.DirEntry, error)
+	Close() error
+}
+
+type responseStateTempRecoveryIO struct {
+	now           func() time.Time
+	openDir       func(string) (responseStateTempDir, error)
+	inspect       func(string) (os.FileInfo, error)
+	processExists func(int) bool
+	unlink        func(string) error
+	currentPID    int
+	maxEntries    int
+	maxCleanups   int
+}
+
+func defaultResponseStateTempRecoveryIO() responseStateTempRecoveryIO {
+	return responseStateTempRecoveryIO{
+		now:           time.Now,
+		openDir:       func(path string) (responseStateTempDir, error) { return os.Open(path) },
+		inspect:       os.Lstat,
+		processExists: platform.ProcessExists,
+		unlink:        unlinkResponseStateTemp,
+		currentPID:    os.Getpid(),
+		maxEntries:    responseStateTempEntries,
+		maxCleanups:   responseStateTempCleanups,
+	}
+}
+
+func responseStateTempDigits(value string) bool {
+	if value == "" {
+		return false
+	}
+	for _, digit := range value {
+		if digit < '0' || digit > '9' {
+			return false
+		}
+	}
+	return true
+}
+
+func parseResponseStateTempName(snapshotPath, name string) (int, uint64, bool, bool) {
+	prefix := filepath.Base(snapshotPath) + ".ocx."
+	if !strings.HasPrefix(name, prefix) || !strings.HasSuffix(name, ".tmp") {
+		return 0, 0, false, false
+	}
+	parts := strings.Split(strings.TrimSuffix(strings.TrimPrefix(name, prefix), ".tmp"), ".")
+	if len(parts) != 2 || !responseStateTempDigits(parts[0]) || !responseStateTempDigits(parts[1]) {
+		return 0, 0, false, false
+	}
+	pidValue, err := strconv.ParseUint(parts[0], 10, 64)
+	if err != nil || pidValue == 0 || pidValue > responseStateTempMaxSafe || pidValue > uint64(^uint(0)>>1) {
+		return 0, 0, true, false
+	}
+	sequence, err := strconv.ParseUint(parts[1], 10, 64)
+	if err != nil || sequence == 0 || sequence > responseStateTempMaxSafe {
+		return 0, 0, true, false
+	}
+	return int(pidValue), sequence, true, true
+}
+
+func recoverStaleResponseStateTemps(snapshotPath string, recoveryIO responseStateTempRecoveryIO) ResponseStateTempRecoveryResult {
+	result := ResponseStateTempRecoveryResult{}
+	if snapshotPath == "" || recoveryIO.maxEntries <= 0 || recoveryIO.maxCleanups <= 0 {
+		return result
+	}
+	directory, err := recoveryIO.openDir(filepath.Dir(snapshotPath))
+	if err != nil {
+		return result
+	}
+	defer directory.Close()
+
+	scanned := 0
+	for scanned < recoveryIO.maxEntries && result.Removed+result.Failed < recoveryIO.maxCleanups {
+		entries, readErr := directory.ReadDir(1)
+		if len(entries) == 0 {
+			if readErr != nil {
+				return result
+			}
+			continue
+		}
+		if readErr != nil && !errors.Is(readErr, io.EOF) {
+			return result
+		}
+		scanned++
+		entry := entries[0]
+		pid, _, matches, valid := parseResponseStateTempName(snapshotPath, entry.Name())
+		if !matches {
+			continue
+		}
+		result.Matched++
+		if !valid {
+			continue
+		}
+		path := filepath.Join(filepath.Dir(snapshotPath), entry.Name())
+		info, inspectErr := recoveryIO.inspect(path)
+		if inspectErr == nil && info.Mode().IsRegular() && recoveryIO.now().Sub(info.ModTime()) >= responseStateTempGrace && pid != recoveryIO.currentPID && !recoveryIO.processExists(pid) {
+			if recoveryIO.unlink(path) == nil {
+				result.Removed++
+				result.BytesRemoved += info.Size()
+			} else {
+				result.Failed++
+			}
+		}
+		if readErr != nil {
+			return result
+		}
+	}
+	return result
+}
+
+func createResponseStateTemp(snapshotPath string) (*os.File, string, error) {
+	for {
+		sequence := responseStateTempSequence.Add(1)
+		if sequence == 0 {
+			continue
+		}
+		if sequence > responseStateTempMaxSafe {
+			return nil, "", errors.New("response-state temp sequence exhausted")
+		}
+		path := snapshotPath + ".ocx." + strconv.Itoa(os.Getpid()) + "." + strconv.FormatUint(sequence, 10) + ".tmp"
+		file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
+		if errors.Is(err, os.ErrExist) {
+			continue
+		}
+		return file, path, err
+	}
+}
+
 type ResponseStateMetrics struct {
 	Count        int   `json:"count"`
 	TotalBytes   int64 `json:"totalBytes"`
@@ -210,6 +357,7 @@ func (s *ResponseStateStore) ensureLoadedLocked() {
 	if s.path == "" {
 		return
 	}
+	_ = recoverStaleResponseStateTemps(s.path, defaultResponseStateTempRecoveryIO())
 	payload, err := os.ReadFile(s.path)
 	if err != nil {
 		return
@@ -338,11 +486,10 @@ func (s *ResponseStateStore) persistLocked() {
 		return
 	}
 	_ = os.Chmod(directory, 0o700)
-	temporary, err := os.CreateTemp(directory, ".responses-state-*")
+	temporary, temporaryPath, err := createResponseStateTemp(s.path)
 	if err != nil {
 		return
 	}
-	temporaryPath := temporary.Name()
 	defer os.Remove(temporaryPath)
 	if errors.Join(temporary.Chmod(0o600), func() error { _, err := temporary.Write(payload); return err }(), temporary.Sync(), temporary.Close()) != nil {
 		return
diff --git a/go/internal/server/responses_state_recovery_test.go b/go/internal/server/responses_state_recovery_test.go
new file mode 100644
index 0000000000000000000000000000000000000000..8b01a89c5b2f4052567b845e96b5b1648f7ad617
--- /dev/null
+++ b/go/internal/server/responses_state_recovery_test.go
@@ -0,0 +1,384 @@
+package server
+
+import (
+	"errors"
+	"io"
+	"net/http"
+	"net/http/httptest"
+	"os"
+	"os/exec"
+	"path/filepath"
+	"strconv"
+	"strings"
+	"testing"
+	"time"
+
+	"github.com/lidge-jun/opencodex-go/internal/bridge"
+	"github.com/lidge-jun/opencodex-go/internal/platform"
+	"github.com/lidge-jun/opencodex-go/internal/types"
+)
+
+type responseStateTestDir struct {
+	entries   []os.DirEntry
+	reads     int
+	failAfter int
+}
+
+func (d *responseStateTestDir) ReadDir(n int) ([]os.DirEntry, error) {
+	if d.failAfter >= 0 && d.reads >= d.failAfter {
+		return nil, errors.New("injected iterator failure")
+	}
+	if d.reads >= len(d.entries) {
+		return nil, io.EOF
+	}
+	entry := d.entries[d.reads]
+	d.reads++
+	return []os.DirEntry{entry}, nil
+}
+
+func (*responseStateTestDir) Close() error { return nil }
+
+type responseStateTestEntry struct{ name string }
+
+func (e responseStateTestEntry) Name() string             { return e.name }
+func (responseStateTestEntry) IsDir() bool                { return false }
+func (responseStateTestEntry) Type() os.FileMode          { return 0 }
+func (responseStateTestEntry) Info() (os.FileInfo, error) { return nil, errors.New("unused") }
+
+type responseStateTestInfo struct {
+	name    string
+	size    int64
+	mode    os.FileMode
+	modTime time.Time
+}
+
+func (i responseStateTestInfo) Name() string       { return i.name }
+func (i responseStateTestInfo) Size() int64        { return i.size }
+func (i responseStateTestInfo) Mode() os.FileMode  { return i.mode }
+func (i responseStateTestInfo) ModTime() time.Time { return i.modTime }
+func (i responseStateTestInfo) IsDir() bool        { return i.mode.IsDir() }
+func (responseStateTestInfo) Sys() any             { return nil }
+
+func TestResponseStateTempNameRequiresExactCanonicalBasename(t *testing.T) {
+	snapshot := filepath.Join(t.TempDir(), "responses-state.json")
+	maxInt := strconv.FormatUint(uint64(^uint(0)>>1), 10)
+	tooLargeInt := maxInt + "0"
+	tests := []struct {
+		name           string
+		matched, valid bool
+	}{
+		{"responses-state.json.ocx.42.7.tmp", true, true},
+		{"responses-state.json.ocx.0.7.tmp", true, false},
+		{"responses-state.json.ocx.42.0.tmp", true, false},
+		{"responses-state.json.ocx." + tooLargeInt + ".7.tmp", true, false},
+		{"responses-state.json.ocx.42.18446744073709551616.tmp", true, false},
+		{"responses-state.json.ocx.42.9007199254740992.tmp", true, false},
+		{"responses-state.json.ocx.+42.7.tmp", false, false},
+		{"responses-state.json.ocx.42.7.tmp.extra", false, false},
+		{"other.json.ocx.42.7.tmp", false, false},
+		{"responses-state.json.ocx.42.tmp", false, false},
+	}
+	for _, test := range tests {
+		t.Run(test.name, func(t *testing.T) {
+			_, _, matched, valid := parseResponseStateTempName(snapshot, test.name)
+			if matched != test.matched || valid != test.valid {
+				t.Fatalf("matched=%v valid=%v, want %v/%v", matched, valid, test.matched, test.valid)
+			}
+		})
+	}
+}
+
+func TestRecoverStaleResponseStateTempsGuardsAndAccounting(t *testing.T) {
+	directory := t.TempDir()
+	snapshot := filepath.Join(directory, "responses-state.json")
+	now := time.Unix(10_000, 0)
+	old := now.Add(-time.Hour)
+	paths := map[string]string{
+		"stale":     filepath.Join(directory, "responses-state.json.ocx.4242.1.tmp"),
+		"live":      filepath.Join(directory, "responses-state.json.ocx.5252.2.tmp"),
+		"current":   filepath.Join(directory, "responses-state.json.ocx.6262.3.tmp"),
+		"young":     filepath.Join(directory, "responses-state.json.ocx.7272.4.tmp"),
+		"zero":      filepath.Join(directory, "responses-state.json.ocx.0.5.tmp"),
+		"overflow":  filepath.Join(directory, "responses-state.json.ocx.999999999999999999999.6.tmp"),
+		"inspect":   filepath.Join(directory, "responses-state.json.ocx.8282.7.tmp"),
+		"unlink":    filepath.Join(directory, "responses-state.json.ocx.9292.8.tmp"),
+		"directory": filepath.Join(directory, "responses-state.json.ocx.10303.9.tmp"),
+		"symlink":   filepath.Join(directory, "responses-state.json.ocx.10404.10.tmp"),
+		"unrelated": filepath.Join(directory, "responses-state.json.ocx.4242.tmp"),
+	}
+	for label, path := range paths {
+		if label == "directory" || label == "symlink" {
+			continue
+		}
+		if err := os.WriteFile(path, []byte(label), 0o600); err != nil {
+			t.Fatal(err)
+		}
+	}
+	if err := os.Mkdir(paths["directory"], 0o700); err != nil {
+		t.Fatal(err)
+	}
+	symlinkCreated := os.Symlink(paths["stale"], paths["symlink"]) == nil
+	for label, path := range paths {
+		if label == "young" || label == "symlink" {
+			continue
+		}
+		if err := os.Chtimes(path, old, old); err != nil {
+			t.Fatal(err)
+		}
+	}
+
+	recoveryIO := defaultResponseStateTempRecoveryIO()
+	recoveryIO.now = func() time.Time { return now }
+	recoveryIO.currentPID = 6262
+	recoveryIO.processExists = func(pid int) bool { return pid == 5252 }
+	inspect := recoveryIO.inspect
+	recoveryIO.inspect = func(path string) (os.FileInfo, error) {
+		if path == paths["inspect"] {
+			return nil, errors.New("injected inspect failure")
+		}
+		return inspect(path)
+	}
+	unlink := recoveryIO.unlink
+	recoveryIO.unlink = func(path string) error {
+		if path == paths["unlink"] {
+			return errors.New("injected unlink failure")
+		}
+		return unlink(path)
+	}
+	result := recoverStaleResponseStateTemps(snapshot, recoveryIO)
+	wantMatched := 9
+	if symlinkCreated {
+		wantMatched++
+	}
+	if result.Matched != wantMatched || result.Removed != 1 || result.Failed != 1 || result.BytesRemoved != int64(len("stale")) {
+		t.Fatalf("result=%+v, want matched=%d removed=1 failed=1 bytes=%d", result, wantMatched, len("stale"))
+	}
+	if _, err := os.Stat(paths["stale"]); !errors.Is(err, os.ErrNotExist) {
+		t.Fatalf("stale file was not removed: %v", err)
+	}
+	for label, path := range paths {
+		if label == "stale" || (label == "symlink" && !symlinkCreated) {
+			continue
+		}
+		if _, err := os.Lstat(path); err != nil {
+			t.Fatalf("%s path was touched: %v", label, err)
+		}
+	}
+}
+
+func TestRecoverStaleResponseStateTempsContainsOpenAndIteratorFailures(t *testing.T) {
+	snapshot := filepath.Join(t.TempDir(), "responses-state.json")
+	recoveryIO := defaultResponseStateTempRecoveryIO()
+	recoveryIO.openDir = func(string) (responseStateTempDir, error) { return nil, errors.New("open failed") }
+	if result := recoverStaleResponseStateTemps(snapshot, recoveryIO); result != (ResponseStateTempRecoveryResult{}) {
+		t.Fatalf("open failure result=%+v", result)
+	}
+
+	directory := &responseStateTestDir{entries: []os.DirEntry{responseStateTestEntry{"responses-state.json.ocx.42.1.tmp"}}, failAfter: 1}
+	recoveryIO = syntheticResponseStateRecoveryIO(directory)
+	result := recoverStaleResponseStateTemps(snapshot, recoveryIO)
+	if result.Removed != 1 || directory.reads != 1 {
+		t.Fatalf("iterator failure result=%+v reads=%d", result, directory.reads)
+	}
+}
+
+func TestRecoverStaleResponseStateTempsNeverRemovesReplacementDirectory(t *testing.T) {
+	directory := t.TempDir()
+	snapshot := filepath.Join(directory, "responses-state.json")
+	path := snapshot + ".ocx.42.1.tmp"
+	if err := os.Mkdir(path, 0o700); err != nil {
+		t.Fatal(err)
+	}
+	recoveryIO := defaultResponseStateTempRecoveryIO()
+	now := time.Now()
+	recoveryIO.now = func() time.Time { return now }
+	recoveryIO.currentPID = 99
+	recoveryIO.processExists = func(int) bool { return false }
+	recoveryIO.inspect = func(string) (os.FileInfo, error) {
+		return responseStateTestInfo{name: filepath.Base(path), size: 7, mode: 0o600, modTime: now.Add(-time.Hour)}, nil
+	}
+	result := recoverStaleResponseStateTemps(snapshot, recoveryIO)
+	if result.Removed != 0 || result.Failed != 1 {
+		t.Fatalf("replacement-directory result=%+v", result)
+	}
+	if info, err := os.Stat(path); err != nil || !info.IsDir() {
+		t.Fatalf("replacement directory was removed: info=%v err=%v", info, err)
+	}
+}
+
+func TestRecoverStaleResponseStateTempsEnforcesEntryAndCleanupCaps(t *testing.T) {
+	entries := make([]os.DirEntry, 5)
+	for index := range entries {
+		entries[index] = responseStateTestEntry{"responses-state.json.ocx.42." + strconv.Itoa(index+1) + ".tmp"}
+	}
+	for _, test := range []struct {
+		name                    string
+		maxEntries, maxCleanups int
+	}{
+		{"entry cap", 2, 5},
+		{"cleanup cap", 5, 2},
+	} {
+		t.Run(test.name, func(t *testing.T) {
+			directory := &responseStateTestDir{entries: entries, failAfter: -1}
+			recoveryIO := syntheticResponseStateRecoveryIO(directory)
+			recoveryIO.maxEntries = test.maxEntries
+			recoveryIO.maxCleanups = test.maxCleanups
+			result := recoverStaleResponseStateTemps(filepath.Join(t.TempDir(), "responses-state.json"), recoveryIO)
+			if result.Removed != 2 || directory.reads != 2 {
+				t.Fatalf("result=%+v reads=%d", result, directory.reads)
+			}
+		})
+	}
+}
+
+func syntheticResponseStateRecoveryIO(directory responseStateTempDir) responseStateTempRecoveryIO {
+	now := time.Unix(10_000, 0)
+	return responseStateTempRecoveryIO{
+		now:     func() time.Time { return now },
+		openDir: func(string) (responseStateTempDir, error) { return directory, nil },
+		inspect: func(path string) (os.FileInfo, error) {
+			return responseStateTestInfo{name: filepath.Base(path), size: 3, mode: 0o600, modTime: now.Add(-time.Hour)}, nil
+		},
+		processExists: func(int) bool { return false },
+		unlink:        func(string) error { return nil },
+		currentPID:    99,
+		maxEntries:    responseStateTempEntries,
+		maxCleanups:   responseStateTempCleanups,
+	}
+}
+
+func TestCreateResponseStateTempUsesExclusiveCanonicalPrivateFile(t *testing.T) {
+	directory := t.TempDir()
+	snapshot := filepath.Join(directory, "responses-state.json")
+	responseStateTempSequence.Store(0)
+	collision := snapshot + ".ocx." + strconv.Itoa(os.Getpid()) + ".1.tmp"
+	if err := os.WriteFile(collision, []byte("existing"), 0o600); err != nil {
+		t.Fatal(err)
+	}
+	file, path, err := createResponseStateTemp(snapshot)
+	if err != nil {
+		t.Fatal(err)
+	}
+	defer os.Remove(path)
+	if err := file.Close(); err != nil {
+		t.Fatal(err)
+	}
+	pid, sequence, matched, valid := parseResponseStateTempName(snapshot, filepath.Base(path))
+	if !matched || !valid || pid != os.Getpid() || sequence != 2 || path == collision {
+		t.Fatalf("temp path=%q pid=%d sequence=%d matched=%v valid=%v", path, pid, sequence, matched, valid)
+	}
+	info, err := os.Stat(path)
+	if err != nil {
+		t.Fatal(err)
+	}
+	if info.Mode().Perm()&0o077 != 0 {
+		t.Fatalf("temp permissions=%o", info.Mode().Perm())
+	}
+	content, err := os.ReadFile(collision)
+	if err != nil || string(content) != "existing" {
+		t.Fatalf("exclusive collision was overwritten: %q, %v", content, err)
+	}
+}
+
+func TestResponseStatePersistenceLeavesNoCanonicalTempAfterRename(t *testing.T) {
+	directory := t.TempDir()
+	snapshot := filepath.Join(directory, "responses-state.json")
+	store := NewResponseStateStore(snapshot)
+	store.Remember([]byte(`{"input":"hello"}`), bridge.Response{ID: "resp_temp_cleanup", Status: "completed", Output: []map[string]any{}}, nil, false)
+	store.Flush()
+	entries, err := os.ReadDir(directory)
+	if err != nil {
+		t.Fatal(err)
+	}
+	for _, entry := range entries {
+		if strings.Contains(entry.Name(), ".ocx.") {
+			t.Fatalf("successful rename left temp %q", entry.Name())
+		}
+	}
+}
+
+func TestResponseStateRecoveryIsActiveFromProductionResponsesRoute(t *testing.T) {
+	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
+		_, _ = io.WriteString(w, `{}`)
+	}))
+	defer upstream.Close()
+	command := exec.Command(os.Args[0], "-test.run=^$")
+	if err := command.Start(); err != nil {
+		t.Fatal(err)
+	}
+	deadPID := command.Process.Pid
+	if err := command.Wait(); err != nil {
+		t.Fatal(err)
+	}
+	if platform.ProcessExists(deadPID) {
+		t.Fatalf("exited child pid %d still reported alive", deadPID)
+	}
+
+	for _, test := range []struct {
+		name string
+		seed func(*testing.T, string) string
+	}{
+		{
+			name: "Bun-era canonical residual",
+			seed: func(t *testing.T, snapshot string) string {
+				path := snapshot + ".ocx." + strconv.Itoa(deadPID) + ".1.tmp"
+				if err := os.WriteFile(path, []byte("bun residual"), 0o600); err != nil {
+					t.Fatal(err)
+				}
+				return path
+			},
+		},
+		{
+			name: "Go-writer canonical residual",
+			seed: func(t *testing.T, snapshot string) string {
+				file, path, err := createResponseStateTemp(snapshot)
+				if err != nil {
+					t.Fatal(err)
+				}
+				if _, err := file.WriteString("go residual"); err != nil {
+					t.Fatal(err)
+				}
+				if err := file.Close(); err != nil {
+					t.Fatal(err)
+				}
+				_, sequence, _, valid := parseResponseStateTempName(snapshot, filepath.Base(path))
+				if !valid {
+					t.Fatalf("writer produced invalid path %q", path)
+				}
+				abandoned := snapshot + ".ocx." + strconv.Itoa(deadPID) + "." + strconv.FormatUint(sequence, 10) + ".tmp"
+				if err := os.Rename(path, abandoned); err != nil {
+					t.Fatal(err)
+				}
+				return abandoned
+			},
+		},
+	} {
+		t.Run(test.name, func(t *testing.T) {
+			directory := t.TempDir()
+			configPath := filepath.Join(directory, "config.json")
+			snapshot := filepath.Join(directory, "responses-state.json")
+			residual := test.seed(t, snapshot)
+			old := time.Now().Add(-time.Hour)
+			if err := os.Chtimes(residual, old, old); err != nil {
+				t.Fatal(err)
+			}
+			proxy := New(Config{
+				ConfigPath: configPath,
+				Registry:   coreRegistry{endpoint: upstream.URL},
+				ResolveAdapter: func(_ *types.ResolvedModel, transport *types.Transport, _ *types.AuthContext, _ http.Header) (types.Adapter, error) {
+					return coreAdapter{endpoint: transport.BaseURL}, nil
+				},
+			})
+			defer proxy.Close()
+			response := httptest.NewRecorder()
+			request := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"public","stream":false,"previous_response_id":"missing","input":"next"}`))
+			proxy.Handler().ServeHTTP(response, request)
+			if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"status":"completed"`) {
+				t.Fatalf("response=%d %s", response.Code, response.Body.String())
+			}
+			if _, err := os.Stat(residual); !errors.Is(err, os.ErrNotExist) {
+				t.Fatalf("production lazy load did not remove %q: %v", residual, err)
+			}
+		})
+	}
+}
diff --git a/go/internal/server/responses_state_unlink_unix.go b/go/internal/server/responses_state_unlink_unix.go
new file mode 100644
index 0000000000000000000000000000000000000000..586e78492898243919646351a9d56904cd68ef38
--- /dev/null
+++ b/go/internal/server/responses_state_unlink_unix.go
@@ -0,0 +1,9 @@
+//go:build !windows
+
+package server
+
+import "syscall"
+
+func unlinkResponseStateTemp(path string) error {
+	return syscall.Unlink(path)
+}
diff --git a/go/internal/server/responses_state_unlink_windows.go b/go/internal/server/responses_state_unlink_windows.go
new file mode 100644
index 0000000000000000000000000000000000000000..2f4bf088009635ac4f484edc5a1c88b292d47a1e
--- /dev/null
+++ b/go/internal/server/responses_state_unlink_windows.go
@@ -0,0 +1,13 @@
+//go:build windows
+
+package server
+
+import "golang.org/x/sys/windows"
+
+func unlinkResponseStateTemp(path string) error {
+	pointer, err := windows.UTF16PtrFromString(path)
+	if err != nil {
+		return err
+	}
+	return windows.DeleteFile(pointer)
+}
diff --git a/structure/02_config-and-codex-home.md b/structure/02_config-and-codex-home.md
index 9dd4fdaab62e69e45f7cab7d1c86a9e78a19a862..a22a3981836110649d3411f695aa074eafac62d1 100644
--- a/structure/02_config-and-codex-home.md
+++ b/structure/02_config-and-codex-home.md
@@ -21,8 +21,8 @@ shutdown handler) both restore Codex config simultaneously. The temp is renamed
 
 Response-state loading performs a bounded recovery pass for interrupted snapshot writes. It only
 matches regular files named `responses-state.json.ocx.<pid>.<sequence>.tmp`, waits at least 15
-minutes, and skips the current or any live PID. Eligible files are truncated before unlinking so a
-matching stale path is unlinked without following it. Path-based truncation is intentionally avoided:
+minutes, and skips the current or any live PID. Eligible files are removed with unlink only.
+Path-based truncation is intentionally avoided:
 a same-user replacement could otherwise turn cleanup into a write through a symlink. Unrelated
 temporary files, symlinks, directories, and young/active writes are never touched; directory entries
 are consumed incrementally and at most 512 stale files are attempted per process start.
```

## Verification

Run from `go/` after applying:

```bash
go test ./internal/server ./internal/platform -count=1
go test ./... -count=1 -timeout 400s
go vet ./...
GOOS=windows GOARCH=amd64 go build ./...
GOOS=linux GOARCH=amd64 go build ./...
```
