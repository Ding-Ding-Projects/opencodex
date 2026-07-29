package management

import (
	"net/http"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/config"
)

// The generated ~/.claude/agents/*.md files are how a chosen subagent model becomes
// dispatchable. Saving a new roster without regenerating them leaves the previous roster
// live: models the user just picked cannot be called, and ones they removed still can.
func TestSubagentRosterChangeRegeneratesClaudeAgentDefinitions(t *testing.T) {
	cfg := config.Default()
	runtime := &claudeRuntimeStub{}
	api := newParityAPI(t, &cfg, func(o *Options) { o.ClaudeRuntime = runtime })

	response := serveManagement(api, http.MethodPut, "/api/subagent-models", `{"models":["gpt-5.6-sol","gpt-5.5"]}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if runtime.synced != 1 {
		t.Fatalf("agent definitions synced %d times, want 1", runtime.synced)
	}
}

// A combo rename only invalidates the generated files when it actually rewrote an
// agent-facing reference. The oracle gates on that migration, not on the rename itself, so a
// rename nothing points at must not trigger a directory rewrite.
func TestComboRenameSyncsOnlyWhenItMigratesAnAgentReference(t *testing.T) {
	cfg := config.Default()
	cfg.Providers["openai"] = config.ProviderConfig{Adapter: "openai-responses", Models: []string{"gpt-5.6-sol"}}
	runtime := &claudeRuntimeStub{}
	api := newParityAPI(t, &cfg, func(o *Options) { o.ClaudeRuntime = runtime })

	combo := `{"strategy":"failover","targets":[{"provider":"openai","model":"gpt-5.6-sol"}]}`
	if create := serveManagement(api, http.MethodPut, "/api/combos", `{"id":"alpha","combo":`+combo+`}`); create.Code != http.StatusOK {
		t.Fatalf("create status=%d body=%s", create.Code, create.Body.String())
	}
	if runtime.synced != 0 {
		t.Fatalf("a plain combo create must not resync: %d", runtime.synced)
	}

	// Nothing references the combo yet, so this rename changes no agent-facing reference.
	if rename := serveManagement(api, http.MethodPut, "/api/combos", `{"id":"beta","renameFrom":"alpha","combo":`+combo+`}`); rename.Code != http.StatusOK {
		t.Fatalf("unreferenced rename status=%d body=%s", rename.Code, rename.Body.String())
	}
	if runtime.synced != 0 {
		t.Fatalf("a rename nothing points at must not resync: %d", runtime.synced)
	}

	// Point the roster at the combo, then rename it: now the generated files name a dead id.
	if put := serveManagement(api, http.MethodPut, "/api/subagent-models", `{"models":["combo/beta"]}`); put.Code != http.StatusOK {
		t.Fatalf("roster status=%d body=%s", put.Code, put.Body.String())
	}
	beforeRename := runtime.synced
	if rename := serveManagement(api, http.MethodPut, "/api/combos", `{"id":"gamma","renameFrom":"beta","combo":`+combo+`}`); rename.Code != http.StatusOK {
		t.Fatalf("referenced rename status=%d body=%s", rename.Code, rename.Body.String())
	}
	if runtime.synced != beforeRename+1 {
		t.Fatalf("a rename that migrated the roster synced %d times (was %d)", runtime.synced, beforeRename)
	}
}

// Most servers and every management test are assembled without a Claude runtime, so the
// sync has to be a no-op rather than a nil dereference.
func TestRosterChangeWithoutAClaudeRuntimeDoesNotPanic(t *testing.T) {
	cfg := config.Default()
	api := newParityAPI(t, &cfg)
	response := serveManagement(api, http.MethodPut, "/api/subagent-models", `{"models":["gpt-5.6-sol"]}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}
