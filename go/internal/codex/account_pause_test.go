package codex

import (
	"testing"
	"time"
)

// Pausing is administrative: the account keeps its credential and its health, it just stops
// being chosen. It therefore has to outrank every runtime signal, including a clean cooldown
// and a healthy usable state (oracle: src/codex/account-pause.ts).
func TestPausedAccountIsNeverSelectable(t *testing.T) {
	router, config, _ := newRoutingFixture(t,
		CodexAccount{ID: "acct-1", Email: "a@example.com"},
		CodexAccount{ID: "acct-2", Email: "b@example.com"},
	)
	now := time.Now().UnixMilli()

	eligible := router.eligibleAccountsLocked(config, "", now)
	if len(eligible) < 2 {
		t.Fatalf("baseline eligible = %v, want both pool accounts", eligible)
	}

	config.PausedCodexAccountIDs = []string{"acct-1"}
	if IsCodexAccountPaused(config, "acct-1") != true || IsCodexAccountPaused(config, "acct-2") {
		t.Fatal("pause lookup does not match the configured set")
	}
	after := router.eligibleAccountsLocked(config, "", now)
	for _, id := range after {
		if id == "acct-1" {
			t.Fatalf("paused account remained eligible: %v", after)
		}
	}
	if len(after) != len(eligible)-1 {
		t.Fatalf("eligible = %v, want exactly the paused one removed from %v", after, eligible)
	}
}
