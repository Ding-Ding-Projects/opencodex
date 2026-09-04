package server

import (
	"net/http"
	"path/filepath"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/codex"
	appconfig "github.com/lidge-jun/opencodex-go/internal/config"
)

func TestProductionCodexManualSelectionResetsSharedRouterImmediately(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	cfg := appconfig.Default()
	cfg.CodexAccounts = []appconfig.CodexAccount{{ID: "work", Email: "work@example.test"}}
	if err := appconfig.Save(path, &cfg); err != nil {
		t.Fatal(err)
	}
	router := codex.NewRouter(nil, nil)
	threshold := 3
	routing := &codex.RoutingConfig{ActiveCodexAccountID: "work", UpstreamFailoverThreshold: &threshold}
	for index := 0; index < 3; index++ {
		router.RecordCodexUpstreamOutcome(routing, "work", 503, codex.CodexUpstreamOutcomeMeta{Now: time.UnixMilli(1_700_000_000_000 + int64(index))})
	}

	proxy := New(Config{ManagementConfig: &cfg, ConfigPath: path, CodexRouter: router})
	defer proxy.Close()
	response := managementRequest(t, proxy.Handler(), http.MethodPut, "/api/codex-auth/active", `{"accountId":"work"}`)
	if response.Code != http.StatusOK || response.Body.String() != `{"ok":true,"activeCodexAccountId":"work","appliesImmediately":true}` {
		t.Fatalf("selection = %d %s", response.Code, response.Body.String())
	}
	if _, exists := router.GetCodexUpstreamHealth("work"); exists {
		t.Fatal("production management route did not reset the shared router")
	}
	loaded, err := appconfig.Load(path)
	if err != nil || loaded.ActiveCodexAccountID != "work" {
		t.Fatalf("persisted selection = %q, error=%v", loaded.ActiveCodexAccountID, err)
	}

	mainRouting := &codex.RoutingConfig{ActiveCodexAccountID: codex.MainCodexAccountID, UpstreamFailoverThreshold: &threshold}
	router.RecordCodexUpstreamOutcome(mainRouting, codex.MainCodexAccountID, 503, codex.CodexUpstreamOutcomeMeta{Now: time.UnixMilli(1_700_000_000_100)})
	response = managementRequest(t, proxy.Handler(), http.MethodPut, "/api/codex-auth/active", `{"accountId":null}`)
	if response.Code != http.StatusOK || response.Body.String() != `{"ok":true,"activeCodexAccountId":null,"appliesImmediately":true}` {
		t.Fatalf("main selection = %d %s", response.Code, response.Body.String())
	}
	if _, exists := router.GetCodexUpstreamHealth(codex.MainCodexAccountID); exists {
		t.Fatal("null selection did not reset main router state")
	}
	loaded, err = appconfig.Load(path)
	if err != nil || loaded.ActiveCodexAccountID != "" {
		t.Fatalf("persisted main selection = %q, error=%v", loaded.ActiveCodexAccountID, err)
	}
}

func TestProductionCodexManualSelectionDoesNotResetRouterWhenPersistenceFails(t *testing.T) {
	cfg := appconfig.Default()
	cfg.CodexAccounts = []appconfig.CodexAccount{{ID: "work", Email: "work@example.test"}}
	router := codex.NewRouter(nil, nil)
	threshold := 1
	routing := &codex.RoutingConfig{ActiveCodexAccountID: "work", UpstreamFailoverThreshold: &threshold}
	router.RecordCodexUpstreamOutcome(routing, "work", 503, codex.CodexUpstreamOutcomeMeta{Now: time.UnixMilli(1_700_000_000_000)})

	// A directory cannot be replaced by the atomic config writer.
	proxy := New(Config{ManagementConfig: &cfg, ConfigPath: t.TempDir(), CodexRouter: router})
	defer proxy.Close()
	response := managementRequest(t, proxy.Handler(), http.MethodPut, "/api/codex-auth/active", `{"accountId":"work"}`)
	if response.Code != http.StatusInternalServerError || cfg.ActiveCodexAccountID != "" {
		t.Fatalf("failed selection = %d %s active=%q", response.Code, response.Body.String(), cfg.ActiveCodexAccountID)
	}
	if health, exists := router.GetCodexUpstreamHealth("work"); !exists || health.ConsecutiveFailures != 1 {
		t.Fatalf("failed persistence reset router: health=%#v exists=%t", health, exists)
	}
}
