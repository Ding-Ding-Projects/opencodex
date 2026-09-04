package management

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/claude"
	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/registry"
)

func TestClaudeManagementThreeStateContractAndRestartActivation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	cfg := config.Default()
	profile := claude.EmptyDesktopProfile()
	profile.AppliedFingerprint = "keep-desktop"
	desktopAutoApply := false
	cfg.ClaudeCode = &config.ClaudeCodeConfig{DesktopProfile: &profile, DesktopAutoApply: &desktopAutoApply}
	if err := config.Save(path, &cfg); err != nil {
		t.Fatal(err)
	}
	runtimeHook := &claudeRuntimeStub{}
	api, err := New(Options{Config: &cfg, ConfigPath: path, ClaudeRuntime: runtimeHook})
	if err != nil {
		t.Fatal(err)
	}
	get := serveManagement(api, http.MethodGet, "/api/claude-code", "")
	var initial map[string]any
	if get.Code != http.StatusOK || json.Unmarshal(get.Body.Bytes(), &initial) != nil {
		t.Fatalf("GET=%d %s", get.Code, get.Body.String())
	}
	if initial["authMode"] != "auto" || initial["detectionScope"] != "daemon" || initial["admissionKeyActive"] != false {
		t.Fatalf("initial=%v", initial)
	}
	for _, field := range []string{"markerMode", "authModeOrigin", "authDetectionUnknown"} {
		if _, ok := initial[field]; !ok {
			t.Fatalf("missing effective field %s: %v", field, initial)
		}
	}
	for _, transition := range []struct {
		body, stored, intent string
	}{
		{`{"authMode":"proxy"}`, "proxy", "proxy"},
		{`{"authMode":"subscription"}`, "subscription", "subscription"},
		{`{"authMode":"auto"}`, "", "auto"},
	} {
		response := serveManagement(api, http.MethodPut, "/api/claude-code", transition.body)
		if response.Code != http.StatusOK || cfg.ClaudeCode == nil || cfg.ClaudeCode.AuthMode != transition.stored || cfg.ClaudeCode.AuthModeMigratedAt == "" {
			t.Fatalf("PUT %s=%d %s cfg=%+v", transition.body, response.Code, response.Body.String(), cfg.ClaudeCode)
		}
		if cfg.ClaudeCode.DesktopProfile == nil || cfg.ClaudeCode.DesktopProfile.AppliedFingerprint != "keep-desktop" {
			t.Fatalf("auth PUT lost concurrent-owner Desktop profile: %+v", cfg.ClaudeCode.DesktopProfile)
		}
		after := serveManagement(api, http.MethodGet, "/api/claude-code", "")
		var payload map[string]any
		_ = json.Unmarshal(after.Body.Bytes(), &payload)
		if payload["authMode"] != transition.intent {
			t.Fatalf("intent after %s=%v", transition.body, payload)
		}
	}
	if runtimeHook.applied != 3 {
		t.Fatalf("auth-only PUT did not reconcile system env: applied=%d", runtimeHook.applied)
	}
	beforeInvalid, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, body := range []string{`{"authMode":"passthrough"}`, `{"authMode":42}`} {
		if response := serveManagement(api, http.MethodPut, "/api/claude-code", body); response.Code != http.StatusBadRequest {
			t.Fatalf("invalid %s=%d %s", body, response.Code, response.Body.String())
		}
	}
	afterInvalid, _ := os.ReadFile(path)
	if string(afterInvalid) != string(beforeInvalid) {
		t.Fatal("invalid auth mode mutated persisted config")
	}

	reloaded, err := config.LoadMigrated(path)
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.ClaudeCode == nil || reloaded.ClaudeCode.AuthMode != "" || reloaded.ClaudeCode.AuthModeMigratedAt == "" {
		t.Fatalf("auto did not survive restart migration: %+v", reloaded.ClaudeCode)
	}
	restarted, err := New(Options{Config: reloaded, ConfigPath: path})
	if err != nil {
		t.Fatal(err)
	}
	var restartedPayload map[string]any
	response := serveManagement(restarted, http.MethodGet, "/api/claude-code", "")
	_ = json.Unmarshal(response.Body.Bytes(), &restartedPayload)
	if restartedPayload["authMode"] != "auto" {
		t.Fatalf("restart intent=%v", restartedPayload)
	}
}

func TestClaudeManagementGetUsesDetachedPersistenceSnapshot(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	cfg := config.Default()
	cfg.Providers["acme"] = config.ProviderConfig{Adapter: "openai", BaseURL: "https://example.test/v1", Models: []string{"model"}}
	if err := config.Save(path, &cfg); err != nil {
		t.Fatal(err)
	}
	persistence := config.NewLivePersistence(path, &cfg)
	reg := registry.New(registry.Provider{ID: "acme", DefaultModel: "model", Models: []registry.ModelDefinition{{ID: "model"}}})
	api, err := New(Options{Config: &cfg, ConfigPath: path, ConfigPersistence: persistence, Registry: reg})
	if err != nil {
		t.Fatal(err)
	}
	var wait sync.WaitGroup
	wait.Add(2)
	go func() {
		defer wait.Done()
		for index := 0; index < 40; index++ {
			if err := persistence.Update(func(live *config.Config) {
				provider := live.Providers["acme"]
				provider.Disabled = index%2 == 0
				live.Providers["acme"] = provider
			}); err != nil {
				t.Errorf("Update: %v", err)
				return
			}
		}
	}()
	go func() {
		defer wait.Done()
		for index := 0; index < 40; index++ {
			response := serveManagement(api, http.MethodGet, "/api/claude-code", "")
			if response.Code != http.StatusOK {
				t.Errorf("GET=%d %s", response.Code, response.Body.String())
				return
			}
		}
	}()
	wait.Wait()
}

func TestFreshClaudeBlockStampsMigrationSentinel(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	cfg := config.Default()
	if err := config.Save(path, &cfg); err != nil {
		t.Fatal(err)
	}
	api, err := New(Options{Config: &cfg, ConfigPath: path})
	if err != nil {
		t.Fatal(err)
	}
	response := serveManagement(api, http.MethodPut, "/api/claude-code", `{"enabled":true}`)
	if response.Code != http.StatusOK || cfg.ClaudeCode == nil || cfg.ClaudeCode.AuthMode != "" || cfg.ClaudeCode.AuthModeMigratedAt == "" {
		t.Fatalf("fresh block=%d %s cfg=%+v", response.Code, response.Body.String(), cfg.ClaudeCode)
	}
	reloaded, err := config.LoadMigrated(path)
	if err != nil || reloaded.ClaudeCode == nil || reloaded.ClaudeCode.AuthMode != "" {
		t.Fatalf("fresh restart cfg=%+v err=%v", reloaded.ClaudeCode, err)
	}
}
