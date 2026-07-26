package management

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/claude"
	"github.com/lidge-jun/opencodex-go/internal/config"
	ocxlib "github.com/lidge-jun/opencodex-go/internal/lib"
)

type runtimeControlStub struct {
	action, channel string
	restart         bool
}

func (*runtimeControlStub) StartupHealth(context.Context) (map[string]any, error) {
	return map[string]any{"status": "protected"}, nil
}
func (s *runtimeControlStub) RunStartupAction(_ context.Context, action string) (string, error) {
	s.action = action
	return "installed", nil
}
func (*runtimeControlStub) WindowsTray(context.Context, string) (map[string]any, error) {
	return map[string]any{"supported": true}, nil
}
func (*runtimeControlStub) SyncModels(context.Context) (map[string]any, error) {
	return map[string]any{"ok": true, "changed": 2}, nil
}
func (s *runtimeControlStub) CheckUpdate(_ context.Context, channel string) (map[string]any, error) {
	s.channel = channel
	return map[string]any{"available": false}, nil
}
func (s *runtimeControlStub) StartUpdate(_ context.Context, channel string, restart bool) (map[string]any, error) {
	s.channel, s.restart = channel, restart
	return map[string]any{"id": "job-1", "accessToken": "never-return"}, nil
}
func (*runtimeControlStub) UpdateStatus(context.Context, string) (map[string]any, bool, error) {
	return map[string]any{"id": "job-1", "status": "done"}, true, nil
}

type quotaBackendStub struct{}

func (quotaBackendStub) ProviderQuotas(context.Context, bool) (ProviderQuotaResponse, error) {
	return ProviderQuotaResponse{GeneratedAt: 123, Reports: []ProviderQuotaReport{}}, nil
}

type claudeRuntimeStub struct{ applied, synced int }

func (s *claudeRuntimeStub) ApplyClaudeCodeSystemEnv(context.Context) error {
	s.applied++
	return errors.New("synthetic apply failure")
}
func (s *claudeRuntimeStub) SyncClaudeAgentDefinitions(context.Context) error { s.synced++; return nil }

func TestRuntimeSettingsRoutesPersistAndMatchTSValidation(t *testing.T) {
	cfg := config.Default()
	runtimeHook := &claudeRuntimeStub{}
	api := newParityAPI(t, &cfg, func(o *Options) { o.ProviderQuotas = quotaBackendStub{}; o.ClaudeRuntime = runtimeHook })
	fallback := serveManagement(api, http.MethodPut, "/api/subagent-model-fallback", `{"models":[" p/m "],"pollMs":5000}`)
	if fallback.Code != 200 || fallback.Body.String() != `{"ok":true,"models":["p/m"],"pollMs":5000}` || cfg.SubagentModelFallback[0] != "p/m" {
		t.Fatalf("fallback=%d %s cfg=%+v", fallback.Code, fallback.Body.String(), cfg.SubagentModelFallback)
	}
	invalid := serveManagement(api, http.MethodPut, "/api/subagent-model-fallback", `{"models":[""]}`)
	if invalid.Code != 400 || invalid.Body.String() != `{"error":"models[0] must be a non-empty string","index":0,"value":""}` {
		t.Fatalf("invalid=%d %s", invalid.Code, invalid.Body.String())
	}
	shadow := serveManagement(api, http.MethodPut, "/api/shadow-call-settings", `{"enabled":true,"model":"helper"}`)
	if shadow.Body.String() != `{"ok":true,"enabled":true,"model":"helper"}` || cfg.ShadowCallIntercept == nil || !cfg.ShadowCallIntercept.Enabled {
		t.Fatalf("shadow=%s cfg=%+v", shadow.Body.String(), cfg.ShadowCallIntercept)
	}
	claudeResponse := serveManagement(api, http.MethodPut, "/api/claude-code", `{"enabled":false,"authMode":"proxy","systemEnv":true,"autoContext":false,"blockedSkills":[" safe "]}`)
	if claudeResponse.Code != 200 || !strings.Contains(claudeResponse.Body.String(), `"warnings":["Failed to apply system environment setting: synthetic apply failure"]`) || cfg.ClaudeCode == nil || cfg.ClaudeCode.Enabled == nil || *cfg.ClaudeCode.Enabled {
		t.Fatalf("claude=%d %s cfg=%+v", claudeResponse.Code, claudeResponse.Body.String(), cfg.ClaudeCode)
	}
	quota := serveManagement(api, http.MethodGet, "/api/provider-quotas?refresh=true", "")
	if quota.Body.String() != `{"generatedAt":123,"reports":[]}` {
		t.Fatalf("quota=%s", quota.Body.String())
	}
}

func TestDiagnosticRoutesUseProductionRingsAndRemainMetadataOnly(t *testing.T) {
	provider := ocxlib.NewDebugLogBuffer()
	injection := ocxlib.NewDebugLogBuffer()
	ring := claude.NewDebugRing(20, true)
	provider.Append("provider ready")
	injection.Append("guidance applied")
	ring.Capture("messages", map[string]any{"model": "m", "metadata": map[string]any{"user_id": "private-user"}, "system": "private prompt"}, "p/m", "")
	cfg := config.Default()
	api := newParityAPI(t, &cfg, func(o *Options) { o.DebugLogs = provider; o.InjectionLogs = injection; o.ClaudeDebug = ring })
	for path, want := range map[string]string{"/api/debug/logs?limit=1": "provider ready", "/api/debug/injection-logs": "guidance applied", "/api/claude/inbound-debug": "userIdTag"} {
		response := serveManagement(api, http.MethodGet, path, "")
		if response.Code != 200 || !strings.Contains(response.Body.String(), want) || strings.Contains(response.Body.String(), "private-user") || strings.Contains(response.Body.String(), "private prompt") {
			t.Fatalf("%s=%d %s", path, response.Code, response.Body.String())
		}
	}
}

func TestRuntimeControlRoutesValidateWrapAndScrub(t *testing.T) {
	backend := &runtimeControlStub{}
	cfg := config.Default()
	api := newParityAPI(t, &cfg, func(o *Options) { o.RuntimeControl = backend })
	action := serveManagement(api, http.MethodPost, "/api/startup-action", `{"action":"install-service"}`)
	if action.Body.String() != `{"ok":true,"action":"install-service","message":"installed"}` || backend.action != "install-service" {
		t.Fatalf("action=%s", action.Body.String())
	}
	update := serveManagement(api, http.MethodPost, "/api/update/run", `{"tag":"preview","restart":false}`)
	if update.Code != 200 || strings.Contains(update.Body.String(), "never-return") || strings.Contains(strings.ToLower(update.Body.String()), "accesstoken") || backend.channel != "preview" || backend.restart {
		t.Fatalf("update=%d %s backend=%+v", update.Code, update.Body.String(), backend)
	}
	invalid := serveManagement(api, http.MethodGet, "/api/update/check?tag=nightly", "")
	if invalid.Code != 400 || invalid.Body.String() != `{"error":"tag must be latest or preview"}` {
		t.Fatalf("invalid=%d %s", invalid.Code, invalid.Body.String())
	}
}
