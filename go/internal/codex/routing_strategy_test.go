package codex

// Differential against src/codex/routing.ts. Every expectation here was
// captured by RUNNING the oracle through a throwaway bun harness, not by
// reading it: the first attempt measured fill-first wrong because
// updateAccountQuota takes positional numbers rather than an object, and the
// disagreement only surfaced because the sequences were executed.

import (
	"testing"
	"time"
)

func threeAccountStrategyFixture(t *testing.T, strategy string, stickyLimit int) (*Router, *RoutingConfig) {
	t.Helper()
	router, config, _ := newRoutingFixture(t,
		CodexAccount{ID: "a"}, CodexAccount{ID: "b"}, CodexAccount{ID: "c"})
	config.ActiveCodexAccountID = "a"
	config.AutoSwitchThreshold = floatPointer(80)
	config.AccountPoolStrategy = strategy
	config.AccountPoolStickyLimit = intPointer(stickyLimit)
	return router, config
}

func resolveSequence(router *Router, config *RoutingConfig, now time.Time, count int) []string {
	out := make([]string, 0, count)
	for index := 0; index < count; index++ {
		out = append(out, router.ResolveCodexAccountForThread("", config, now))
	}
	return out
}

func assertSequence(t *testing.T, label string, got, want []string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("%s length = %d, want %d (%v)", label, len(got), len(want), got)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("%s = %v, oracle returns %v", label, got, want)
		}
	}
}

// Oracle M1: a,b,c,a,b with sticky 1 — no account is held, so the ring
// advances on every new session.
func TestRoundRobinSequenceMatchesTheOracle(t *testing.T) {
	now := time.UnixMilli(1_700_000_000_000)
	router, config := threeAccountStrategyFixture(t, "round-robin", 1)
	assertSequence(t, "rr sticky 1", resolveSequence(router, config, now, 5),
		[]string{"a", "b", "c", "a", "b"})
}

// Oracle M2: a,a,a,b,b,b,c — stickyLimit counts BINDS, and the hold is released
// on the Nth success rather than after it.
func TestRoundRobinStickyLimitMatchesTheOracle(t *testing.T) {
	now := time.UnixMilli(1_700_000_000_000)
	router, config := threeAccountStrategyFixture(t, "round-robin", 3)
	assertSequence(t, "rr sticky 3", resolveSequence(router, config, now, 7),
		[]string{"a", "a", "a", "b", "b", "b", "c"})
}

// Oracle M3: three previews all report a, and the following resolves are still
// a,b,c. A dashboard refresh must not be able to reshuffle live rotation.
func TestRoundRobinPreviewDoesNotAdvanceTheRing(t *testing.T) {
	now := time.UnixMilli(1_700_000_000_000)
	router, config := threeAccountStrategyFixture(t, "round-robin", 1)
	for index := 0; index < 3; index++ {
		if got := router.PreviewCodexAccountForRequest("", config, now); got != "a" {
			t.Fatalf("preview %d = %q, oracle returns a", index, got)
		}
	}
	assertSequence(t, "rr after previews", resolveSequence(router, config, now, 3),
		[]string{"a", "b", "c"})
}

// Oracle M7: the ring advances to c while config.activeCodexAccountId stays a.
// Rotation is a runtime cursor, and persisting it would let an unrelated config
// save freeze one transient step as the operator's choice.
func TestRoundRobinDoesNotPersistTheActiveAccount(t *testing.T) {
	now := time.UnixMilli(1_700_000_000_000)
	router, config := threeAccountStrategyFixture(t, "round-robin", 1)
	assertSequence(t, "rr picks", resolveSequence(router, config, now, 3),
		[]string{"a", "b", "c"})
	if config.ActiveCodexAccountID != "a" {
		t.Fatalf("config active = %q, oracle leaves it at a", config.ActiveCodexAccountID)
	}
}

// Oracle M4: with a drained the next pick is b, and with a and b both drained
// it is c. Fill-first walks stable order; it is not a lowest-usage failover.
func TestFillFirstAdvancesPastDrainedAccounts(t *testing.T) {
	now := time.UnixMilli(1_700_000_000_000)
	router, config := threeAccountStrategyFixture(t, "fill-first", 1)
	router.SetAccountQuota("a", AccountQuota{WeeklyPercent: floatPointer(90), MonthlyPercent: floatPointer(90)})
	if got := router.ResolveCodexAccountForThread("", config, now); got != "b" {
		t.Fatalf("a drained = %q, oracle returns b", got)
	}
	router.SetAccountQuota("b", AccountQuota{WeeklyPercent: floatPointer(95), MonthlyPercent: floatPointer(95)})
	if got := router.ResolveCodexAccountForThread("", config, now); got != "c" {
		t.Fatalf("a+b drained = %q, oracle returns c", got)
	}
	if config.ActiveCodexAccountID != "a" {
		t.Fatalf("config active = %q, oracle leaves it at a", config.ActiveCodexAccountID)
	}
}

// Oracle M5: all-unknown keeps a. An unprobed account must not look drained.
func TestFillFirstKeepsTheActiveAccountWhenUsageIsUnknown(t *testing.T) {
	now := time.UnixMilli(1_700_000_000_000)
	router, config := threeAccountStrategyFixture(t, "fill-first", 1)
	assertSequence(t, "fill-first unknown", resolveSequence(router, config, now, 3),
		[]string{"a", "a", "a"})
}

// Oracle M8: with no active cursor fill-first prefers the under-threshold
// account rather than simply taking the alphabetically first one.
func TestFillFirstWithoutACursorPrefersAnUnderThresholdAccount(t *testing.T) {
	now := time.UnixMilli(1_700_000_000_000)
	router, config := threeAccountStrategyFixture(t, "fill-first", 1)
	config.ActiveCodexAccountID = ""
	router.SetAccountQuota("a", AccountQuota{WeeklyPercent: floatPointer(99), MonthlyPercent: floatPointer(99)})
	router.SetAccountQuota("b", AccountQuota{WeeklyPercent: floatPointer(5), MonthlyPercent: floatPointer(5)})
	if got := router.ResolveCodexAccountForThread("", config, now); got != "b" {
		t.Fatalf("no cursor = %q, oracle returns b", got)
	}
}

// Oracle M6c/M6d, the pair that isolates strategy from quota. Same setup, same
// drained holder, same strictly cooler alternative: quota rebinds the thread
// and persists the move, round-robin leaves it alone because rotation is a
// new-session decision.
func TestBoundThreadReevaluationIsQuotaOnly(t *testing.T) {
	now := time.UnixMilli(1_700_000_000_000)
	later := now.Add(2 * CodexThreadAffinityReevalInterval)

	quotaRouter, quotaConfig := threeAccountStrategyFixture(t, "quota", 1)
	if got := quotaRouter.ResolveCodexAccountForThread("t1", quotaConfig, now); got != "a" {
		t.Fatalf("quota first = %q", got)
	}
	quotaRouter.SetAccountQuota("a", AccountQuota{WeeklyPercent: floatPointer(99), MonthlyPercent: floatPointer(99)})
	quotaRouter.SetAccountQuota("b", AccountQuota{WeeklyPercent: floatPointer(5), MonthlyPercent: floatPointer(5)})
	quotaRouter.SetAccountQuota("c", AccountQuota{WeeklyPercent: floatPointer(5), MonthlyPercent: floatPointer(5)})
	if got := quotaRouter.ResolveCodexAccountForThread("t1", quotaConfig, later); got != "b" {
		t.Fatalf("quota after = %q, oracle rebinds to b", got)
	}
	if quotaConfig.ActiveCodexAccountID != "b" {
		t.Fatalf("quota config active = %q, oracle persists b", quotaConfig.ActiveCodexAccountID)
	}

	rrRouter, rrConfig := threeAccountStrategyFixture(t, "round-robin", 1)
	if got := rrRouter.ResolveCodexAccountForThread("t1", rrConfig, now); got != "a" {
		t.Fatalf("rr first = %q", got)
	}
	rrRouter.SetAccountQuota("a", AccountQuota{WeeklyPercent: floatPointer(99), MonthlyPercent: floatPointer(99)})
	rrRouter.SetAccountQuota("b", AccountQuota{WeeklyPercent: floatPointer(5), MonthlyPercent: floatPointer(5)})
	rrRouter.SetAccountQuota("c", AccountQuota{WeeklyPercent: floatPointer(5), MonthlyPercent: floatPointer(5)})
	if got := rrRouter.ResolveCodexAccountForThread("t1", rrConfig, later); got != "a" {
		t.Fatalf("rr after = %q, oracle keeps the affined a", got)
	}
	if rrConfig.ActiveCodexAccountID != "a" {
		t.Fatalf("rr config active = %q, oracle leaves it at a", rrConfig.ActiveCodexAccountID)
	}
}

// A strategy value that never round-trips through management must not disable
// selection: reading normalizes, so a hand-edited typo falls back to quota
// rather than hiding every configured account.
func TestUnknownStrategyNormalizesToQuota(t *testing.T) {
	now := time.UnixMilli(1_700_000_000_000)
	router, config := threeAccountStrategyFixture(t, "rr", 1)
	assertSequence(t, "typo strategy", resolveSequence(router, config, now, 3),
		[]string{"a", "a", "a"})
}

// PickAlternateCodexAccount is what same-request failover will call. Quota
// takes the coolest remaining account; fill-first advances stable order.
func TestPickAlternateFollowsTheStrategy(t *testing.T) {
	nowMillis := time.UnixMilli(1_700_000_000_000).UnixMilli()

	quotaRouter, quotaConfig := threeAccountStrategyFixture(t, "quota", 1)
	quotaRouter.SetAccountQuota("b", AccountQuota{WeeklyPercent: floatPointer(70), MonthlyPercent: floatPointer(70)})
	quotaRouter.SetAccountQuota("c", AccountQuota{WeeklyPercent: floatPointer(10), MonthlyPercent: floatPointer(10)})
	if got := quotaRouter.PickAlternateCodexAccount(quotaConfig, "a", nowMillis); got != "c" {
		t.Fatalf("quota alternate = %q, want the coolest account c", got)
	}

	fillRouter, fillConfig := threeAccountStrategyFixture(t, "fill-first", 1)
	fillRouter.SetAccountQuota("b", AccountQuota{WeeklyPercent: floatPointer(70), MonthlyPercent: floatPointer(70)})
	fillRouter.SetAccountQuota("c", AccountQuota{WeeklyPercent: floatPointer(10), MonthlyPercent: floatPointer(10)})
	if got := fillRouter.PickAlternateCodexAccount(fillConfig, "a", nowMillis); got != "b" {
		t.Fatalf("fill-first alternate = %q, want the next in stable order b", got)
	}
}
