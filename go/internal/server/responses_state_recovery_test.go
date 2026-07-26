package server

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/bridge"
	"github.com/lidge-jun/opencodex-go/internal/platform"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

type responseStateTestDir struct {
	entries   []os.DirEntry
	reads     int
	failAfter int
}

func (d *responseStateTestDir) ReadDir(n int) ([]os.DirEntry, error) {
	if d.failAfter >= 0 && d.reads >= d.failAfter {
		return nil, errors.New("injected iterator failure")
	}
	if d.reads >= len(d.entries) {
		return nil, io.EOF
	}
	entry := d.entries[d.reads]
	d.reads++
	return []os.DirEntry{entry}, nil
}

func (*responseStateTestDir) Close() error { return nil }

type responseStateTestEntry struct{ name string }

func (e responseStateTestEntry) Name() string             { return e.name }
func (responseStateTestEntry) IsDir() bool                { return false }
func (responseStateTestEntry) Type() os.FileMode          { return 0 }
func (responseStateTestEntry) Info() (os.FileInfo, error) { return nil, errors.New("unused") }

type responseStateTestInfo struct {
	name    string
	size    int64
	mode    os.FileMode
	modTime time.Time
}

func (i responseStateTestInfo) Name() string       { return i.name }
func (i responseStateTestInfo) Size() int64        { return i.size }
func (i responseStateTestInfo) Mode() os.FileMode  { return i.mode }
func (i responseStateTestInfo) ModTime() time.Time { return i.modTime }
func (i responseStateTestInfo) IsDir() bool        { return i.mode.IsDir() }
func (responseStateTestInfo) Sys() any             { return nil }

func TestResponseStateTempNameRequiresExactCanonicalBasename(t *testing.T) {
	snapshot := filepath.Join(t.TempDir(), "responses-state.json")
	maxInt := strconv.FormatUint(uint64(^uint(0)>>1), 10)
	tooLargeInt := maxInt + "0"
	tests := []struct {
		name           string
		matched, valid bool
	}{
		{"responses-state.json.ocx.42.7.tmp", true, true},
		{"responses-state.json.ocx.0.7.tmp", true, false},
		{"responses-state.json.ocx.42.0.tmp", true, false},
		{"responses-state.json.ocx." + tooLargeInt + ".7.tmp", true, false},
		{"responses-state.json.ocx.42.18446744073709551616.tmp", true, false},
		{"responses-state.json.ocx.42.9007199254740992.tmp", true, false},
		{"responses-state.json.ocx.+42.7.tmp", false, false},
		{"responses-state.json.ocx.42.7.tmp.extra", false, false},
		{"other.json.ocx.42.7.tmp", false, false},
		{"responses-state.json.ocx.42.tmp", false, false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, _, matched, valid := parseResponseStateTempName(snapshot, test.name)
			if matched != test.matched || valid != test.valid {
				t.Fatalf("matched=%v valid=%v, want %v/%v", matched, valid, test.matched, test.valid)
			}
		})
	}
}

func TestRecoverStaleResponseStateTempsGuardsAndAccounting(t *testing.T) {
	directory := t.TempDir()
	snapshot := filepath.Join(directory, "responses-state.json")
	now := time.Unix(10_000, 0)
	old := now.Add(-time.Hour)
	paths := map[string]string{
		"stale":     filepath.Join(directory, "responses-state.json.ocx.4242.1.tmp"),
		"live":      filepath.Join(directory, "responses-state.json.ocx.5252.2.tmp"),
		"current":   filepath.Join(directory, "responses-state.json.ocx.6262.3.tmp"),
		"young":     filepath.Join(directory, "responses-state.json.ocx.7272.4.tmp"),
		"zero":      filepath.Join(directory, "responses-state.json.ocx.0.5.tmp"),
		"overflow":  filepath.Join(directory, "responses-state.json.ocx.999999999999999999999.6.tmp"),
		"inspect":   filepath.Join(directory, "responses-state.json.ocx.8282.7.tmp"),
		"unlink":    filepath.Join(directory, "responses-state.json.ocx.9292.8.tmp"),
		"directory": filepath.Join(directory, "responses-state.json.ocx.10303.9.tmp"),
		"symlink":   filepath.Join(directory, "responses-state.json.ocx.10404.10.tmp"),
		"unrelated": filepath.Join(directory, "responses-state.json.ocx.4242.tmp"),
	}
	for label, path := range paths {
		if label == "directory" || label == "symlink" {
			continue
		}
		if err := os.WriteFile(path, []byte(label), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Mkdir(paths["directory"], 0o700); err != nil {
		t.Fatal(err)
	}
	symlinkCreated := os.Symlink(paths["stale"], paths["symlink"]) == nil
	for label, path := range paths {
		if label == "young" || label == "symlink" {
			continue
		}
		if err := os.Chtimes(path, old, old); err != nil {
			t.Fatal(err)
		}
	}

	recoveryIO := defaultResponseStateTempRecoveryIO()
	recoveryIO.now = func() time.Time { return now }
	recoveryIO.currentPID = 6262
	recoveryIO.processExists = func(pid int) bool { return pid == 5252 }
	inspect := recoveryIO.inspect
	recoveryIO.inspect = func(path string) (os.FileInfo, error) {
		if path == paths["inspect"] {
			return nil, errors.New("injected inspect failure")
		}
		return inspect(path)
	}
	unlink := recoveryIO.unlink
	recoveryIO.unlink = func(path string) error {
		if path == paths["unlink"] {
			return errors.New("injected unlink failure")
		}
		return unlink(path)
	}
	result := recoverStaleResponseStateTemps(snapshot, recoveryIO)
	wantMatched := 9
	if symlinkCreated {
		wantMatched++
	}
	if result.Matched != wantMatched || result.Removed != 1 || result.Failed != 1 || result.BytesRemoved != int64(len("stale")) {
		t.Fatalf("result=%+v, want matched=%d removed=1 failed=1 bytes=%d", result, wantMatched, len("stale"))
	}
	if _, err := os.Stat(paths["stale"]); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("stale file was not removed: %v", err)
	}
	for label, path := range paths {
		if label == "stale" || (label == "symlink" && !symlinkCreated) {
			continue
		}
		if _, err := os.Lstat(path); err != nil {
			t.Fatalf("%s path was touched: %v", label, err)
		}
	}
}

func TestRecoverStaleResponseStateTempsContainsOpenAndIteratorFailures(t *testing.T) {
	snapshot := filepath.Join(t.TempDir(), "responses-state.json")
	recoveryIO := defaultResponseStateTempRecoveryIO()
	recoveryIO.openDir = func(string) (responseStateTempDir, error) { return nil, errors.New("open failed") }
	if result := recoverStaleResponseStateTemps(snapshot, recoveryIO); result != (ResponseStateTempRecoveryResult{}) {
		t.Fatalf("open failure result=%+v", result)
	}

	directory := &responseStateTestDir{entries: []os.DirEntry{responseStateTestEntry{"responses-state.json.ocx.42.1.tmp"}}, failAfter: 1}
	recoveryIO = syntheticResponseStateRecoveryIO(directory)
	result := recoverStaleResponseStateTemps(snapshot, recoveryIO)
	if result.Removed != 1 || directory.reads != 1 {
		t.Fatalf("iterator failure result=%+v reads=%d", result, directory.reads)
	}
}

func TestRecoverStaleResponseStateTempsNeverRemovesReplacementDirectory(t *testing.T) {
	directory := t.TempDir()
	snapshot := filepath.Join(directory, "responses-state.json")
	path := snapshot + ".ocx.42.1.tmp"
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatal(err)
	}
	recoveryIO := defaultResponseStateTempRecoveryIO()
	now := time.Now()
	recoveryIO.now = func() time.Time { return now }
	recoveryIO.currentPID = 99
	recoveryIO.processExists = func(int) bool { return false }
	recoveryIO.inspect = func(string) (os.FileInfo, error) {
		return responseStateTestInfo{name: filepath.Base(path), size: 7, mode: 0o600, modTime: now.Add(-time.Hour)}, nil
	}
	result := recoverStaleResponseStateTemps(snapshot, recoveryIO)
	if result.Removed != 0 || result.Failed != 1 {
		t.Fatalf("replacement-directory result=%+v", result)
	}
	if info, err := os.Stat(path); err != nil || !info.IsDir() {
		t.Fatalf("replacement directory was removed: info=%v err=%v", info, err)
	}
}

func TestRecoverStaleResponseStateTempsEnforcesEntryAndCleanupCaps(t *testing.T) {
	entries := make([]os.DirEntry, 5)
	for index := range entries {
		entries[index] = responseStateTestEntry{"responses-state.json.ocx.42." + strconv.Itoa(index+1) + ".tmp"}
	}
	for _, test := range []struct {
		name                    string
		maxEntries, maxCleanups int
	}{
		{"entry cap", 2, 5},
		{"cleanup cap", 5, 2},
	} {
		t.Run(test.name, func(t *testing.T) {
			directory := &responseStateTestDir{entries: entries, failAfter: -1}
			recoveryIO := syntheticResponseStateRecoveryIO(directory)
			recoveryIO.maxEntries = test.maxEntries
			recoveryIO.maxCleanups = test.maxCleanups
			result := recoverStaleResponseStateTemps(filepath.Join(t.TempDir(), "responses-state.json"), recoveryIO)
			if result.Removed != 2 || directory.reads != 2 {
				t.Fatalf("result=%+v reads=%d", result, directory.reads)
			}
		})
	}
}

func syntheticResponseStateRecoveryIO(directory responseStateTempDir) responseStateTempRecoveryIO {
	now := time.Unix(10_000, 0)
	return responseStateTempRecoveryIO{
		now:     func() time.Time { return now },
		openDir: func(string) (responseStateTempDir, error) { return directory, nil },
		inspect: func(path string) (os.FileInfo, error) {
			return responseStateTestInfo{name: filepath.Base(path), size: 3, mode: 0o600, modTime: now.Add(-time.Hour)}, nil
		},
		processExists: func(int) bool { return false },
		unlink:        func(string) error { return nil },
		currentPID:    99,
		maxEntries:    responseStateTempEntries,
		maxCleanups:   responseStateTempCleanups,
	}
}

func TestCreateResponseStateTempUsesExclusiveCanonicalPrivateFile(t *testing.T) {
	directory := t.TempDir()
	snapshot := filepath.Join(directory, "responses-state.json")
	responseStateTempSequence.Store(0)
	collision := snapshot + ".ocx." + strconv.Itoa(os.Getpid()) + ".1.tmp"
	if err := os.WriteFile(collision, []byte("existing"), 0o600); err != nil {
		t.Fatal(err)
	}
	file, path, err := createResponseStateTemp(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(path)
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	pid, sequence, matched, valid := parseResponseStateTempName(snapshot, filepath.Base(path))
	if !matched || !valid || pid != os.Getpid() || sequence != 2 || path == collision {
		t.Fatalf("temp path=%q pid=%d sequence=%d matched=%v valid=%v", path, pid, sequence, matched, valid)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm()&0o077 != 0 {
		t.Fatalf("temp permissions=%o", info.Mode().Perm())
	}
	content, err := os.ReadFile(collision)
	if err != nil || string(content) != "existing" {
		t.Fatalf("exclusive collision was overwritten: %q, %v", content, err)
	}
}

func TestResponseStatePersistenceLeavesNoCanonicalTempAfterRename(t *testing.T) {
	directory := t.TempDir()
	snapshot := filepath.Join(directory, "responses-state.json")
	store := NewResponseStateStore(snapshot)
	store.Remember([]byte(`{"input":"hello"}`), bridge.Response{ID: "resp_temp_cleanup", Status: "completed", Output: []map[string]any{}}, nil, false)
	store.Flush()
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.Contains(entry.Name(), ".ocx.") {
			t.Fatalf("successful rename left temp %q", entry.Name())
		}
	}
}

func TestResponseStateRecoveryIsActiveFromProductionResponsesRoute(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{}`)
	}))
	defer upstream.Close()
	command := exec.Command(os.Args[0], "-test.run=^$")
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	deadPID := command.Process.Pid
	if err := command.Wait(); err != nil {
		t.Fatal(err)
	}
	if platform.ProcessExists(deadPID) {
		t.Fatalf("exited child pid %d still reported alive", deadPID)
	}

	for _, test := range []struct {
		name string
		seed func(*testing.T, string) string
	}{
		{
			name: "Bun-era canonical residual",
			seed: func(t *testing.T, snapshot string) string {
				path := snapshot + ".ocx." + strconv.Itoa(deadPID) + ".1.tmp"
				if err := os.WriteFile(path, []byte("bun residual"), 0o600); err != nil {
					t.Fatal(err)
				}
				return path
			},
		},
		{
			name: "Go-writer canonical residual",
			seed: func(t *testing.T, snapshot string) string {
				file, path, err := createResponseStateTemp(snapshot)
				if err != nil {
					t.Fatal(err)
				}
				if _, err := file.WriteString("go residual"); err != nil {
					t.Fatal(err)
				}
				if err := file.Close(); err != nil {
					t.Fatal(err)
				}
				_, sequence, _, valid := parseResponseStateTempName(snapshot, filepath.Base(path))
				if !valid {
					t.Fatalf("writer produced invalid path %q", path)
				}
				abandoned := snapshot + ".ocx." + strconv.Itoa(deadPID) + "." + strconv.FormatUint(sequence, 10) + ".tmp"
				if err := os.Rename(path, abandoned); err != nil {
					t.Fatal(err)
				}
				return abandoned
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			directory := t.TempDir()
			configPath := filepath.Join(directory, "config.json")
			snapshot := filepath.Join(directory, "responses-state.json")
			residual := test.seed(t, snapshot)
			old := time.Now().Add(-time.Hour)
			if err := os.Chtimes(residual, old, old); err != nil {
				t.Fatal(err)
			}
			proxy := New(Config{
				ConfigPath: configPath,
				Registry:   coreRegistry{endpoint: upstream.URL},
				ResolveAdapter: func(_ *types.ResolvedModel, transport *types.Transport, _ *types.AuthContext, _ http.Header) (types.Adapter, error) {
					return coreAdapter{endpoint: transport.BaseURL}, nil
				},
			})
			defer proxy.Close()
			response := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"public","stream":false,"previous_response_id":"missing","input":"next"}`))
			proxy.Handler().ServeHTTP(response, request)
			if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"status":"completed"`) {
				t.Fatalf("response=%d %s", response.Code, response.Body.String())
			}
			if _, err := os.Stat(residual); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("production lazy load did not remove %q: %v", residual, err)
			}
		})
	}
}
