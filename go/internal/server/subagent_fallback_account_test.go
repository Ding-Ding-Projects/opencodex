package server

import (
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/codex"
	appconfig "github.com/lidge-jun/opencodex-go/internal/config"
)

// Under a rotation strategy the account that is actually serving lives in the
// router's runtime cursor, not in the persisted config. Assessing the persisted
// one lets subagent fallback judge an exhausted account while a healthy one is
// in use, and skip a native route that was available.
func TestSubagentFallbackPrefersTheEffectiveAccount(t *testing.T) {
	config := appconfig.Default()
	config.ActiveCodexAccountID = "persisted"

	fallback := &responseSubagentFallback{config: &config}
	if got := fallback.activeAccountID(&config); got != "persisted" {
		t.Fatalf("without a router = %q, want the persisted account", got)
	}

	fallback.effectiveAccount = func() string { return "rotating" }
	if got := fallback.activeAccountID(&config); got != "rotating" {
		t.Fatalf("with a cursor = %q, want the rotating account", got)
	}

	// An empty cursor means rotation is not in charge, so the persisted
	// selection stands rather than collapsing to the main account.
	fallback.effectiveAccount = func() string { return "" }
	if got := fallback.activeAccountID(&config); got != "persisted" {
		t.Fatalf("with an empty cursor = %q, want the persisted account", got)
	}
}

// withEffectiveAccount must tolerate a nil router: not every embedding builds
// the Codex pool, and forcing callers to pass one would break them.
func TestSubagentFallbackAcceptsANilRouter(t *testing.T) {
	config := appconfig.Default()
	fallback := (&responseSubagentFallback{config: &config}).withEffectiveAccount(nil)
	if fallback.effectiveAccount != nil {
		t.Fatal("a nil router installed a hook")
	}
	fallback = fallback.withEffectiveAccount(codex.NewRouter(nil, nil))
	if fallback.effectiveAccount == nil {
		t.Fatal("a real router did not install the hook")
	}
	if got := fallback.effectiveAccount(); got != "" {
		t.Fatalf("a fresh router reports %q, want no cursor", got)
	}
}
