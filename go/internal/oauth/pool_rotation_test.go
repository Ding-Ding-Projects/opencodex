package oauth

import (
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/config"
)

// Every expectation below was captured by RUNNING src/codex/pool-rotation.ts,
// not by reading it. Regenerate with:
//
//	bun -e 'const m = await import("./src/codex/pool-rotation.ts"); ...'
//
// The sequences are the contract: a rotation that merely "looks round-robin"
// but drifts by one is a different account receiving a session.
func TestRotationMatchesTypeScriptOracle(t *testing.T) {
	ids := []string{"a", "b", "c"}

	t.Run("limit 1 rotates every pick", func(t *testing.T) {
		registry := NewRotationRegistry()
		got := make([]string, 0, 7)
		for i := 0; i < 7; i++ {
			picked, _ := registry.PickRoundRobinAccount("p", ids, 1)
			got = append(got, picked)
		}
		// oracle: a,b,c,a,b,c,a
		if strings.Join(got, ",") != "a,b,c,a,b,c,a" {
			t.Fatalf("picks = %v, oracle returns a,b,c,a,b,c,a", got)
		}
	})

	t.Run("limit 3 holds an account for three successful binds", func(t *testing.T) {
		registry := NewRotationRegistry()
		got := make([]string, 0, 7)
		for i := 0; i < 7; i++ {
			picked, _ := registry.PickRoundRobinAccount("p", ids, 3)
			got = append(got, picked)
			registry.NoteRotationSuccess("p", picked, 3)
		}
		// oracle: a,a,a,b,b,b,c
		if strings.Join(got, ",") != "a,a,a,b,b,b,c" {
			t.Fatalf("picks = %v, oracle returns a,a,a,b,b,b,c", got)
		}
	})

	t.Run("a failure releases the hold immediately", func(t *testing.T) {
		registry := NewRotationRegistry()
		first, _ := registry.PickRoundRobinAccount("p", ids, 3)
		registry.NoteRotationFailure("p", first)
		got := []string{first}
		for i := 0; i < 4; i++ {
			picked, _ := registry.PickRoundRobinAccount("p", ids, 3)
			got = append(got, picked)
		}
		// oracle: a,b,b,b,b -- the failure drops `a`, then `b` is held.
		if strings.Join(got, ",") != "a,b,b,b,b" {
			t.Fatalf("picks = %v, oracle returns a,b,b,b,b", got)
		}
	})

	t.Run("peek does not advance the ring", func(t *testing.T) {
		registry := NewRotationRegistry()
		firstPeek, _ := registry.PeekRoundRobinAccount("p", ids, 1)
		secondPeek, _ := registry.PeekRoundRobinAccount("p", ids, 1)
		picked, _ := registry.PickRoundRobinAccount("p", ids, 1)
		if firstPeek != "a" || secondPeek != "a" || picked != "a" {
			t.Fatalf("peek/peek/pick = %s/%s/%s, oracle returns a/a/a", firstPeek, secondPeek, picked)
		}
	})

	t.Run("an ineligible sticky holder is dropped", func(t *testing.T) {
		// The load-bearing case: a cooled-down or reauth-pending account must
		// not keep receiving sessions just because it was held.
		registry := NewRotationRegistry()
		registry.SeedRotationAccount("p", "b")
		picked, _ := registry.PickRoundRobinAccount("p", []string{"a", "c"}, 5)
		if picked != "a" {
			t.Fatalf("picked = %q, oracle returns a when the held account is no longer eligible", picked)
		}
	})

	t.Run("seed forces the next pick", func(t *testing.T) {
		registry := NewRotationRegistry()
		registry.SeedRotationAccount("p", "c")
		first, _ := registry.PickRoundRobinAccount("p", ids, 5)
		second, _ := registry.PickRoundRobinAccount("p", ids, 5)
		if first != "c" || second != "c" {
			t.Fatalf("picks = %s,%s; oracle returns c,c", first, second)
		}
	})

	t.Run("empty eligibility selects nothing", func(t *testing.T) {
		registry := NewRotationRegistry()
		if _, ok := registry.PickRoundRobinAccount("p", nil, 1); ok {
			t.Fatal("an empty pool must not select an account")
		}
	})

	t.Run("pools are independent", func(t *testing.T) {
		registry := NewRotationRegistry()
		firstCodex, _ := registry.PickRoundRobinAccount(PoolKeyCodex, ids, 1)
		firstAnthropic, _ := registry.PickRoundRobinAccount(PoolKeyAnthropic, ids, 1)
		if firstCodex != "a" || firstAnthropic != "a" {
			t.Fatalf("pools shared a ring: codex=%s anthropic=%s", firstCodex, firstAnthropic)
		}
	})
}

// Normalize is lenient (config reads), Parse is strict (management writes).
// Conflating them either rejects a loadable config or silently stores something
// the user did not ask for.
func TestAccountPoolNormalizeAndParseMatchTheOracle(t *testing.T) {
	if got := config.NormalizedAccountPoolStrategy("rr"); got != "quota" {
		t.Fatalf("normalize(rr) = %q, oracle returns quota", got)
	}
	if got := config.NormalizedAccountPoolStrategy("fill-first"); got != "fill-first" {
		t.Fatalf("normalize(fill-first) = %q", got)
	}
	for _, testCase := range []struct {
		raw  int
		want int
	}{{0, 1}, {101, 1}, {7, 7}} {
		value := testCase.raw
		if got := config.NormalizedAccountPoolStickyLimit(&value); got != testCase.want {
			t.Fatalf("normalize(%d) = %d, oracle returns %d", testCase.raw, got, testCase.want)
		}
	}
	if _, ok := config.ParseAccountPoolStrategy("rr"); ok {
		t.Fatal("parse(rr) must fail; the oracle returns null")
	}
	if _, ok := config.ParseAccountPoolStickyLimit(0); ok {
		t.Fatal("parse(0) must fail; the oracle returns null")
	}
	if got, ok := config.ParseAccountPoolStickyLimit(100); !ok || got != 100 {
		t.Fatalf("parse(100) = %d,%v; the oracle accepts 100", got, ok)
	}
}

// An absent threshold means 80; an explicit 0 means "never auto-switch" and
// must survive. Collapsing them would silently re-enable switching for a user
// who turned it off.
func TestNormalizeAnthropicPoolKeepsAnExplicitZeroThreshold(t *testing.T) {
	if resolved := config.NormalizeAnthropicPool(nil); resolved.Enabled || resolved.AutoSwitchThreshold != 80 ||
		resolved.Strategy != "quota" || resolved.StickyLimit != 1 {
		t.Fatalf("nil pool = %#v", resolved)
	}
	zero := 0
	enabled := true
	resolved := config.NormalizeAnthropicPool(&config.AnthropicAccountPoolConfig{
		Enabled: &enabled, AutoSwitchThreshold: &zero,
	})
	if !resolved.Enabled || resolved.AutoSwitchThreshold != 0 {
		t.Fatalf("explicit zero threshold did not survive: %#v", resolved)
	}
}
