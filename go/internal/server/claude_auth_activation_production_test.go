package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	appconfig "github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/registry"
)

type reentrantClaudeRuntime struct {
	handler http.Handler
	status  int
}

func (r *reentrantClaudeRuntime) ApplyClaudeCodeSystemEnv(ctx context.Context) error {
	done := make(chan struct{})
	go func() {
		request := httptest.NewRequest(http.MethodGet, "/v1/models", nil).WithContext(ctx)
		response := httptest.NewRecorder()
		r.handler.ServeHTTP(response, request)
		r.status = response.Code
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(500 * time.Millisecond):
		return errors.New("nested models request blocked behind config persistence")
	}
}

func (*reentrantClaudeRuntime) SyncClaudeAgentDefinitions(context.Context) error { return nil }

func TestClaudeAuthPutReleasesPersistenceBeforeRuntimeReconciliationAndSurvivesRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	cfg := appconfig.Default()
	if err := appconfig.Save(path, &cfg); err != nil {
		t.Fatal(err)
	}
	reg := registry.New(registry.Provider{ID: "openai", DefaultModel: "gpt", Models: []registry.ModelDefinition{{ID: "gpt"}}})
	runtime := &reentrantClaudeRuntime{}
	first := New(Config{ManagementConfig: &cfg, ConfigPath: path, Registry: reg, ClaudeRuntime: runtime})
	runtime.handler = first.Handler()
	response := serveRequest(first.Handler(), http.MethodPut, "/api/claude-code", `{"authMode":"auto"}`, nil)
	if response.Code != http.StatusOK || runtime.status != http.StatusOK {
		t.Fatalf("PUT=%d nested-models=%d body=%s", response.Code, runtime.status, response.Body.String())
	}
	var put map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &put); err != nil {
		t.Fatal(err)
	}
	if warnings, ok := put["warnings"].([]any); !ok || len(warnings) != 0 {
		t.Fatalf("reconciliation warnings = %#v", put["warnings"])
	}
	first.Close()

	reloaded, err := appconfig.LoadMigrated(path)
	if err != nil {
		t.Fatal(err)
	}
	second := New(Config{ManagementConfig: reloaded, ConfigPath: path, Registry: reg})
	defer second.Close()
	get := serveRequest(second.Handler(), http.MethodGet, "/api/claude-code", "", nil)
	var payload map[string]any
	if get.Code != http.StatusOK || json.Unmarshal(get.Body.Bytes(), &payload) != nil || payload["authMode"] != "auto" {
		t.Fatalf("restart GET=%d body=%s payload=%v", get.Code, get.Body.String(), payload)
	}
}
