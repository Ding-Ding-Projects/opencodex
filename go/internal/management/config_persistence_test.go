package management

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/codex"
	"github.com/lidge-jun/opencodex-go/internal/config"
)

func TestManagementAndClaudeDesktopSavesShareGuardedPersistence(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	cfg := config.Default()
	cfg.ClaudeCode = &config.ClaudeCodeConfig{AuthMode: "subscription", AuthModeMigratedAt: "2026-07-26T00:00:00Z"}
	if err := config.Save(path, &cfg); err != nil {
		t.Fatal(err)
	}
	persistence := config.NewLivePersistence(path, &cfg)
	api, err := New(Options{Config: &cfg, ConfigPath: path, ConfigPersistence: persistence, ModelCache: codex.NewModelCache()})
	if err != nil {
		t.Fatal(err)
	}
	rewriteManagementClaudeCode(t, path, "proxy")
	api.mu.Lock()
	api.config.DisabledModels = []string{"acme/one"}
	err = api.saveLocked()
	api.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	assertManagementClaudeMode(t, path, "proxy")

	rewriteManagementClaudeCode(t, path, "subscription")
	api.mu.Lock()
	err = api.saveClaudeDesktopLocked()
	api.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	assertManagementClaudeMode(t, path, "subscription")
}

func TestManagementMutationAndRuntimeUpdateShareOneTransactionLock(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	cfg := config.Default()
	if err := config.Save(path, &cfg); err != nil {
		t.Fatal(err)
	}
	persistence := config.NewLivePersistence(path, &cfg)
	api, err := New(Options{Config: &cfg, ConfigPath: path, ConfigPersistence: persistence, ModelCache: codex.NewModelCache()})
	if err != nil {
		t.Fatal(err)
	}

	const updates = 40
	var wait sync.WaitGroup
	wait.Add(3)
	go func() {
		defer wait.Done()
		for index := 0; index < updates; index++ {
			mode := "legacy-tee"
			if index%2 == 0 {
				mode = "eager-relay"
			}
			request := httptest.NewRequest(http.MethodPut, "/api/settings", strings.NewReader(`{"streamMode":"`+mode+`"}`))
			response := httptest.NewRecorder()
			api.ServeHTTP(response, request)
			if response.Code != http.StatusOK {
				t.Errorf("settings status = %d body=%s", response.Code, response.Body.String())
				return
			}
		}
	}()
	go func() {
		defer wait.Done()
		for index := 0; index < updates; index++ {
			request := httptest.NewRequest(http.MethodGet, "/api/selected-models", nil)
			response := httptest.NewRecorder()
			api.ServeHTTP(response, request)
			if response.Code != http.StatusOK {
				t.Errorf("selected models status = %d body=%s", response.Code, response.Body.String())
				return
			}
		}
	}()
	go func() {
		defer wait.Done()
		for index := 0; index < updates; index++ {
			if err := persistence.Update(func(live *config.Config) { live.Port++ }); err != nil {
				t.Errorf("runtime update: %v", err)
				return
			}
		}
	}()
	wait.Wait()
	if cfg.Port != config.DefaultPort+updates {
		t.Fatalf("live port = %d, want %d", cfg.Port, config.DefaultPort+updates)
	}
	loaded, err := config.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Port != cfg.Port || loaded.StreamMode != cfg.StreamMode {
		t.Fatalf("disk/live diverged: disk=(%d,%q) live=(%d,%q)", loaded.Port, loaded.StreamMode, cfg.Port, cfg.StreamMode)
	}
}

func rewriteManagementClaudeCode(t *testing.T, path, mode string) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var object map[string]any
	if err := json.Unmarshal(data, &object); err != nil {
		t.Fatal(err)
	}
	object["claudeCode"] = map[string]any{"authMode": mode, "authModeMigratedAt": "2026-07-26T00:00:00Z"}
	data, _ = json.MarshalIndent(object, "", "  ")
	if err := os.WriteFile(path, append(data, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
}

func assertManagementClaudeMode(t *testing.T, path, want string) {
	t.Helper()
	loaded, err := config.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.ClaudeCode == nil || loaded.ClaudeCode.AuthMode != want {
		t.Fatalf("claudeCode = %#v, want %q", loaded.ClaudeCode, want)
	}
}
