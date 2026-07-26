package codex

import (
	"testing"
	"time"
)

func floatPointer(value float64) *float64 { return &value }
func intPointer(value int) *int           { return &value }

func newRoutingFixture(t *testing.T, accounts ...CodexAccount) (*Router, *RoutingConfig, *AccountStore) {
	t.Helper()
	store := NewAccountStore(t.TempDir() + "/codex-accounts.json")
	for _, account := range accounts {
		if account.ID == MainCodexAccountID {
			continue
		}
		if err := store.SaveCredential(account.ID, AccountCredentials{"access-" + account.ID, "refresh-" + account.ID, time.Now().Add(time.Hour).UnixMilli(), "chat-" + account.ID}); err != nil {
			t.Fatal(err)
		}
	}
	router := NewRouter(store, func() (MainAccountToken, bool) { return MainAccountToken{}, false }, nil)
	return router, &RoutingConfig{CodexAccounts: accounts}, store
}

func TestComputeCodexUsageScorePlanSemantics(t *testing.T) {
	quota := &AccountQuota{WeeklyPercent: floatPointer(90), MonthlyPercent: floatPointer(20)}
	if got := ComputeCodexUsageScore(quota, "plus"); got != 90 {
		t.Fatalf("plus score = %v", got)
	}
	if got := ComputeCodexUsageScore(quota, " Go "); got != 20 {
		t.Fatalf("go score = %v", got)
	}
	if got := ComputeCodexUsageScore(nil, "plus"); got != CodexUnknownUsageScore {
		t.Fatalf("unknown score = %v", got)
	}
}

func TestQuotaCooldownParsingAndProbeLeaseRecovery(t *testing.T) {
	now := time.UnixMilli(1_700_000_000_000)
	if delay, ok := ParseRetryAfter("0.001", now); !ok || delay != time.Millisecond {
		t.Fatalf("retry-after = %v, %v", delay, ok)
	}
	if delay, ok := ParseRetryAfter("999999", now); !ok || delay != CodexMaxQuotaCooldown {
		t.Fatalf("retry-after clamp = %v, %v", delay, ok)
	}
	reset := now.Add(4 * 24 * time.Hour).UnixMilli()
	if delay, ok := ParseResetCooldown([]any{reset}, now); !ok || delay != CodexMaxResetDerivedCooldown {
		t.Fatalf("reset clamp = %v, %v", delay, ok)
	}

	router, config, _ := newRoutingFixture(t, CodexAccount{ID: "a"})
	config.ActiveCodexAccountID = "a"
	router.RecordCodexUpstreamOutcome(config, "a", 429, CodexUpstreamOutcomeMeta{ResetAt: []any{reset}, Now: now})
	if _, ok := router.TryAcquireCodexQuotaProbeLease("a", now); ok {
		t.Fatal("probe acquired before interval")
	}
	probeAt := now.Add(CodexQuotaProbeInterval)
	lease, ok := router.TryAcquireCodexQuotaProbeLease("a", probeAt)
	if !ok || lease.Generation != 1 {
		t.Fatalf("lease = %#v, %v", lease, ok)
	}
	if _, second := router.TryAcquireCodexQuotaProbeLease("a", probeAt); second {
		t.Fatal("second simultaneous lease acquired")
	}
	router.RecordCodexUpstreamOutcome(config, "a", 200, CodexUpstreamOutcomeMeta{Now: probeAt.Add(time.Second), ProbeLeaseID: lease.ID})
	if _, cooling := router.GetCodexAccountCooldownUntil("a", probeAt.Add(time.Second)); cooling {
		t.Fatal("owning successful probe did not clear cooldown")
	}
}

func TestProbeCannotClearNewerRetryAfterGeneration(t *testing.T) {
	now := time.UnixMilli(1_700_000_000_000)
	router, config, _ := newRoutingFixture(t, CodexAccount{ID: "a"})
	router.RecordCodexUpstreamOutcome(config, "a", 429, CodexUpstreamOutcomeMeta{ResetAt: []any{now.Add(time.Hour).UnixMilli()}, Now: now})
	probeAt := now.Add(CodexQuotaProbeInterval)
	lease, ok := router.TryAcquireCodexQuotaProbeLease("a", probeAt)
	if !ok {
		t.Fatal("probe unavailable")
	}
	router.RecordCodexUpstreamOutcome(config, "a", 429, CodexUpstreamOutcomeMeta{RetryAfter: "7200", Now: probeAt.Add(50 * time.Millisecond)})
	router.RecordCodexUpstreamOutcome(config, "a", 200, CodexUpstreamOutcomeMeta{Now: probeAt.Add(100 * time.Millisecond), ProbeLeaseID: lease.ID})
	health, exists := router.GetCodexUpstreamHealth("a")
	if !exists || health.CooldownSource != CooldownRetryAfter || health.ProbeLeaseID != "" {
		t.Fatalf("new cooldown was altered: %#v", health)
	}
	if _, acquired := router.TryAcquireCodexQuotaProbeLease("a", probeAt.Add(time.Hour)); acquired {
		t.Fatal("retry-after cooldown admitted probe")
	}
}

func TestTransientSoftAvoidEscalationAndRecovery(t *testing.T) {
	now := time.UnixMilli(1_700_000_000_000)
	router, config, _ := newRoutingFixture(t, CodexAccount{ID: "a"}, CodexAccount{ID: "b"})
	config.ActiveCodexAccountID = "a"
	config.UpstreamFailoverThreshold = intPointer(3)
	for index := 0; index < 3; index++ {
		router.RecordCodexUpstreamOutcome(config, "a", 503, CodexUpstreamOutcomeMeta{Now: now.Add(time.Duration(index) * time.Millisecond)})
	}
	health, _ := router.GetCodexUpstreamHealth("a")
	if health.ConsecutiveFailures != 3 || health.SoftAvoidUntil != now.Add(10*time.Minute+2*time.Millisecond).UnixMilli() {
		t.Fatalf("escalated health = %#v", health)
	}
	if config.ActiveCodexAccountID != "b" {
		t.Fatalf("active account did not fail over: %q", config.ActiveCodexAccountID)
	}
	router.RecordCodexUpstreamOutcome(config, "a", 200, CodexUpstreamOutcomeMeta{Now: now.Add(time.Second)})
	health, exists := router.GetCodexUpstreamHealth("a")
	if !exists || health.ConsecutiveSuccesses != 1 {
		t.Fatalf("first recovery terminal = %#v, %v", health, exists)
	}
	router.RecordCodexUpstreamOutcome(config, "a", 200, CodexUpstreamOutcomeMeta{Now: now.Add(2 * time.Second)})
	if _, exists := router.GetCodexUpstreamHealth("a"); exists {
		t.Fatal("second recovery terminal did not clear health")
	}
}

func TestThreadAffinityGenerationTTLAndQuotaReevaluation(t *testing.T) {
	now := time.UnixMilli(1_700_000_000_000)
	router, config, store := newRoutingFixture(t, CodexAccount{ID: "a"}, CodexAccount{ID: "b"})
	config.ActiveCodexAccountID = "a"
	router.SetAccountQuota("a", AccountQuota{WeeklyPercent: floatPointer(10)})
	router.SetAccountQuota("b", AccountQuota{WeeklyPercent: floatPointer(20)})
	if got := router.ResolveCodexAccountForThread("thread", config, now); got != "a" {
		t.Fatalf("initial affinity = %q", got)
	}
	router.SetAccountQuota("a", AccountQuota{WeeklyPercent: floatPointer(90)})
	if got := router.ResolveCodexAccountForThread("thread", config, now.Add(30*time.Second)); got != "a" {
		t.Fatalf("reevaluated too early = %q", got)
	}
	if got := router.ResolveCodexAccountForThread("thread", config, now.Add(CodexThreadAffinityReevalInterval)); got != "b" {
		t.Fatalf("quota reevaluation = %q", got)
	}
	if err := store.SaveCredential("b", AccountCredentials{"new", "new-r", time.Now().Add(time.Hour).UnixMilli(), "chat-b"}); err != nil {
		t.Fatal(err)
	}
	config.ActiveCodexAccountID = "a"
	router.SetAccountQuota("a", AccountQuota{WeeklyPercent: floatPointer(5)})
	if got := router.ResolveCodexAccountForThread("thread", config, now.Add(CodexThreadAffinityReevalInterval+time.Millisecond)); got != "a" {
		t.Fatalf("stale generation affinity = %q", got)
	}
	resolution := router.ResolveCodexAccountForThreadDetailed("thread", config, now.Add(CodexThreadAffinityIdleTTL+2*time.Minute))
	if resolution.Status != ThreadExpired || resolution.AccountID != "a" {
		t.Fatalf("expired resolution = %#v", resolution)
	}
}

func TestCredentialFailureQuarantinesAccount(t *testing.T) {
	now := time.UnixMilli(1_700_000_000_000)
	router, config, _ := newRoutingFixture(t, CodexAccount{ID: "a"}, CodexAccount{ID: "b"})
	config.ActiveCodexAccountID = "a"
	router.SetAccountQuota("a", AccountQuota{WeeklyPercent: floatPointer(10)})
	router.SetAccountQuota("b", AccountQuota{WeeklyPercent: floatPointer(20)})
	if got := router.ResolveCodexAccountForThread("thread", config, now); got != "a" {
		t.Fatal(got)
	}
	router.RecordCodexUpstreamOutcome(config, "a", 401, CodexUpstreamOutcomeMeta{Now: now.Add(time.Second)})
	if !router.AccountNeedsReauth("a") {
		t.Fatal("account was not marked for reauth")
	}
	if got := router.ResolveCodexAccountForThread("thread", config, now.Add(2*time.Second)); got != "b" {
		t.Fatalf("quarantined selection = %q", got)
	}
}

func TestPreviewCodexAccountIsSideEffectFree(t *testing.T) {
	now := time.UnixMilli(1_700_000_000_000)
	saves := 0
	store := NewAccountStore(t.TempDir() + "/codex-accounts.json")
	for _, id := range []string{"a", "b"} {
		if err := store.SaveCredential(id, AccountCredentials{"access-" + id, "refresh-" + id, now.Add(time.Hour).UnixMilli(), "chat-" + id}); err != nil {
			t.Fatal(err)
		}
	}
	router := NewRouter(store, func() (MainAccountToken, bool) { return MainAccountToken{}, false }, func(*RoutingConfig) error { saves++; return nil })
	config := &RoutingConfig{CodexAccounts: []CodexAccount{{ID: "a"}, {ID: "b"}}, ActiveCodexAccountID: "a"}
	router.SetAccountQuota("a", AccountQuota{WeeklyPercent: floatPointer(90)})
	router.SetAccountQuota("b", AccountQuota{WeeklyPercent: floatPointer(10)})
	if got := router.PreviewCodexAccountForRequest("thread", config, now); got != "b" {
		t.Fatalf("preview=%q", got)
	}
	if config.ActiveCodexAccountID != "a" || saves != 0 || len(router.threadAccounts) != 0 {
		t.Fatalf("preview mutated state: active=%q saves=%d affinity=%v", config.ActiveCodexAccountID, saves, router.threadAccounts)
	}
	if got := router.ResolveCodexAccountForThread("thread", config, now); got != "b" {
		t.Fatalf("resolve=%q", got)
	}
	before := router.threadAccounts["thread"]
	router.SetAccountQuota("b", AccountQuota{WeeklyPercent: floatPointer(95)})
	router.SetAccountQuota("a", AccountQuota{WeeklyPercent: floatPointer(5)})
	if got := router.PreviewCodexAccountForRequest("thread", config, now.Add(time.Second)); got != "a" {
		t.Fatalf("affinity preview=%q", got)
	}
	if after := router.threadAccounts["thread"]; after != before {
		t.Fatalf("preview changed affinity: before=%+v after=%+v", before, after)
	}
}
