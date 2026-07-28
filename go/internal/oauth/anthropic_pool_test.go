package oauth

// Differential against src/oauth/anthropic-routing.ts. Every expectation was
// captured by RUNNING the oracle, and one of them had to be re-measured: the
// first fill-first reading looked like a two-step jump because account ids are
// random while fill-first walks SORTED order, so the seed order is not the walk
// order. These tests pin by sorted order for the same reason.

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sort"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/config"
)

func anthropicPoolFixture(t *testing.T, ids ...string) (*AnthropicPool, ProviderAccountSet) {
	t.Helper()
	store := NewCredentialStore(filepath.Join(t.TempDir(), "auth.json"))
	ctx := context.Background()
	for _, id := range ids {
		credential := OAuthCredentials{
			Access: "access-" + id, Refresh: "refresh-" + id,
			Expires: time.Now().Add(time.Hour).UnixMilli(), AccountID: id, Email: id + "@example.test",
		}
		if err := store.SaveCredential(ctx, anthropicPoolProvider, credential); err != nil {
			t.Fatal(err)
		}
	}
	set, found, err := store.GetAccountSet(anthropicPoolProvider)
	if err != nil || !found {
		t.Fatalf("GetAccountSet() = (%v, %v)", found, err)
	}
	return NewAnthropicPool(store), set
}

func accountIDFor(t *testing.T, set ProviderAccountSet, upstreamID string) string {
	t.Helper()
	for _, account := range set.Accounts {
		if account.Credential.AccountID == upstreamID {
			return account.ID
		}
	}
	t.Fatalf("no account for %q", upstreamID)
	return ""
}

func activate(t *testing.T, pool *AnthropicPool, accountID string) ProviderAccountSet {
	t.Helper()
	if _, err := pool.store.SetActiveAccount(context.Background(), anthropicPoolProvider, accountID); err != nil {
		t.Fatal(err)
	}
	set, _, err := pool.store.GetAccountSet(anthropicPoolProvider)
	if err != nil {
		t.Fatal(err)
	}
	return set
}

func poolConfig(enabled bool, threshold int, strategy string, stickyLimit int) config.NormalizedAnthropicPool {
	return config.NormalizedAnthropicPool{
		Enabled: enabled, AutoSwitchThreshold: threshold, Strategy: strategy, StickyLimit: stickyLimit,
	}
}

func setUsage(pool *AnthropicPool, accountID string, percent float64) {
	pool.quota.mu.Lock()
	defer pool.quota.mu.Unlock()
	value := percent
	pool.quota.entries[accountID] = accountQuotaEntry{
		quota: AccountQuota{FiveHourPercent: &value, UpdatedAt: time.Now()}, fetchedAt: time.Now(),
	}
}

// Oracle W1: a disabled pool returns the stored active and applies no other
// judgement, which is what keeps enabling it a deliberate act.
func TestAnthropicPoolDisabledReturnsTheStoredActive(t *testing.T) {
	now := time.Now()
	pool, set := anthropicPoolFixture(t, "a", "b", "c")
	active := accountIDFor(t, set, "a")
	activate(t, pool, active)

	got := pool.Resolve("sess-1", poolConfig(false, 80, "quota", 1), now)
	if got.AccountID != active || got.Reason != AnthropicReasonPoolDisabled {
		t.Fatalf("disabled = %#v, oracle returns the active account with reason pool-disabled", got)
	}
}

// Oracle W2: round-robin with NO session key holds the active account. Desktop
// sends turns without a sticky key, and rotating those would swap accounts
// mid-conversation.
func TestAnthropicPoolWithoutASessionKeyHoldsTheActive(t *testing.T) {
	now := time.Now()
	pool, set := anthropicPoolFixture(t, "a", "b", "c")
	active := accountIDFor(t, set, "a")
	activate(t, pool, active)

	for index := 0; index < 3; index++ {
		got := pool.Resolve("", poolConfig(true, 80, "round-robin", 1), now)
		if got.AccountID != active || got.Reason != AnthropicReasonActive {
			t.Fatalf("keyless resolve %d = %#v, oracle holds the active with reason active", index, got)
		}
	}
}

// Oracle W3: distinct session keys DO rotate, and the store's active account is
// left alone because the token may still fail validation.
func TestAnthropicPoolRotatesAcrossDistinctSessionKeys(t *testing.T) {
	now := time.Now()
	pool, set := anthropicPoolFixture(t, "a", "b", "c")
	active := accountIDFor(t, set, "a")
	set = activate(t, pool, active)

	seen := map[string]struct{}{}
	for index := 1; index <= 4; index++ {
		got := pool.Resolve(string(rune('0'+index)), poolConfig(true, 80, "round-robin", 1), now)
		if got.Reason != AnthropicReasonRoundRobin {
			t.Fatalf("resolve %d reason = %q, oracle returns round-robin", index, got.Reason)
		}
		seen[got.AccountID] = struct{}{}
		// Checked after EVERY resolve, not just at the end: the ring returns to
		// the starting account on the fourth call, so a final-state assertion
		// would pass even if every pick had promoted.
		after, _, _ := pool.store.GetAccountSet(anthropicPoolProvider)
		if after.ActiveAccountID != set.ActiveAccountID {
			t.Fatalf("resolve %d moved the store active to %q; the strategy pick must not promote", index, after.ActiveAccountID)
		}
	}
	if len(seen) != 3 {
		t.Fatalf("four keys touched %d accounts, oracle cycles through all three", len(seen))
	}
}

// Oracle W4: the same session key sticks through affinity, which is a stronger
// and separate mechanism from the round-robin sticky budget.
func TestAnthropicPoolKeepsOneSessionKeyOnOneAccount(t *testing.T) {
	now := time.Now()
	pool, set := anthropicPoolFixture(t, "a", "b", "c")
	activate(t, pool, accountIDFor(t, set, "a"))

	first := pool.Resolve("same", poolConfig(true, 80, "round-robin", 1), now)
	if first.Reason != AnthropicReasonRoundRobin {
		t.Fatalf("first reason = %q, oracle returns round-robin", first.Reason)
	}
	for index := 0; index < 2; index++ {
		got := pool.Resolve("same", poolConfig(true, 80, "round-robin", 1), now)
		if got.AccountID != first.AccountID || got.Reason != AnthropicReasonAffinity {
			t.Fatalf("repeat %d = %#v, oracle returns the same account with reason affinity", index, got)
		}
	}
}

// Oracle W5: quota picks the lowest known usage.
func TestAnthropicPoolQuotaPicksTheLowestUsage(t *testing.T) {
	now := time.Now()
	pool, set := anthropicPoolFixture(t, "a", "b", "c")
	a, b := accountIDFor(t, set, "a"), accountIDFor(t, set, "b")
	activate(t, pool, a)
	setUsage(pool, a, 95)
	setUsage(pool, b, 10)

	got := pool.Resolve("s1", poolConfig(true, 80, "quota", 1), now)
	if got.AccountID != b || got.Reason != AnthropicReasonLowestUsage {
		t.Fatalf("quota = %#v, oracle returns the 10%% account with reason lowest-usage", got)
	}
}

// Oracle W6: all-unknown usage keeps the active. An unprobed account must not
// look drained enough to force a move.
func TestAnthropicPoolUnknownUsageKeepsTheActive(t *testing.T) {
	now := time.Now()
	pool, set := anthropicPoolFixture(t, "a", "b", "c")
	active := accountIDFor(t, set, "a")
	activate(t, pool, active)

	got := pool.Resolve("s1", poolConfig(true, 80, "quota", 1), now)
	if got.AccountID != active || got.Reason != AnthropicReasonActive {
		t.Fatalf("unknown usage = %#v, oracle keeps the active", got)
	}
}

// Oracle W7: threshold 0 disables quota switching entirely, so a 99%% active
// still serves while a 1%% account sits idle. That is the documented meaning of
// zero, not a bug.
func TestAnthropicPoolThresholdZeroKeepsTheActive(t *testing.T) {
	now := time.Now()
	pool, set := anthropicPoolFixture(t, "a", "b", "c")
	active, b := accountIDFor(t, set, "a"), accountIDFor(t, set, "b")
	activate(t, pool, active)
	setUsage(pool, active, 99)
	setUsage(pool, b, 1)

	got := pool.Resolve("s1", poolConfig(true, 0, "quota", 1), now)
	if got.AccountID != active || got.Reason != AnthropicReasonActive {
		t.Fatalf("threshold 0 = %#v, oracle keeps the active", got)
	}
}

// Oracle W8: fill-first advances exactly one place in SORTED id order when the
// active is drained. Pinned by sorted order because the ids are random.
func TestAnthropicPoolFillFirstAdvancesOneSortedStep(t *testing.T) {
	now := time.Now()
	pool, set := anthropicPoolFixture(t, "a", "b", "c")
	sorted := make([]string, 0, len(set.Accounts))
	for _, account := range set.Accounts {
		sorted = append(sorted, account.ID)
	}
	sort.Strings(sorted)
	activate(t, pool, sorted[0])
	setUsage(pool, sorted[0], 95)

	got := pool.Resolve("s1", poolConfig(true, 80, "fill-first", 1), now)
	if got.AccountID != sorted[1] || got.Reason != AnthropicReasonFillFirst {
		t.Fatalf("fill-first = %#v, oracle advances to sorted index 1 with reason fill-first", got)
	}
}

// Oracle W9: no accounts is reason "none" rather than an error, so the caller
// can tell "log in" apart from "wait".

// The pool has to be REACHABLE, not merely correct. An earlier version of this
// work was complete and inert: nothing constructed the pool or routed
// Anthropic through it, so enabling the opt-in changed nothing at all.
func TestAuthResolverRoutesAnthropicThroughThePool(t *testing.T) {
	now := time.Now()
	pool, set := anthropicPoolFixture(t, "a", "b", "c")
	active := accountIDFor(t, set, "a")
	activate(t, pool, active)

	enabled := poolConfig(true, 80, "round-robin", 1)
	resolver := NewAuthResolver(pool.store, map[string]ProviderAuthConfig{
		anthropicPoolProvider: {Mode: AuthModeOAuth},
	}, nil)
	resolver.Anthropic = pool
	resolver.SetAnthropicPoolConfig(enabled)

	seen := map[string]struct{}{}
	for index := 1; index <= 4; index++ {
		account, err := resolver.selectAccount(context.Background(), anthropicPoolProvider, string(rune('0'+index)), false)
		if err != nil {
			t.Fatalf("selectAccount %d: %v", index, err)
		}
		seen[account.ID] = struct{}{}
	}
	if len(seen) != 3 {
		t.Fatalf("the resolver served %d distinct accounts, want the pool's full rotation of 3", len(seen))
	}

	// With the opt-in OFF the resolver must fall back to the stored active,
	// which is what makes enabling the pool a deliberate choice.
	disabled := poolConfig(false, 80, "round-robin", 1)
	resolver.SetAnthropicPoolConfig(disabled)
	for index := 0; index < 3; index++ {
		account, err := resolver.selectAccount(context.Background(), anthropicPoolProvider, "k", false)
		if err != nil {
			t.Fatalf("disabled selectAccount: %v", err)
		}
		if account.ID != active {
			t.Fatalf("disabled pool served %q, want the stored active %q", account.ID, active)
		}
	}
	_ = now
}

func TestAnthropicPoolWithNoAccountsReportsNone(t *testing.T) {
	store := NewCredentialStore(filepath.Join(t.TempDir(), "auth.json"))
	pool := NewAnthropicPool(store)
	got := pool.Resolve("s1", poolConfig(true, 80, "quota", 1), time.Now())
	if got.AccountID != "" || got.Reason != AnthropicReasonNone {
		t.Fatalf("empty store = %#v, oracle returns null with reason none", got)
	}
}

// Every eligible account cooled is reported as all-cooled, which is a different
// operator situation from having no accounts at all.
func TestAnthropicPoolReportsAllCooled(t *testing.T) {
	now := time.Now()
	pool, set := anthropicPoolFixture(t, "a", "b", "c")
	activate(t, pool, accountIDFor(t, set, "a"))
	for _, account := range set.Accounts {
		pool.NoteFailure(account.ID, "60", now)
	}
	got := pool.Resolve("s1", poolConfig(true, 80, "quota", 1), now)
	if got.AccountID != "" || got.Reason != AnthropicReasonAllCooled {
		t.Fatalf("all cooled = %#v, oracle returns null with reason all-cooled", got)
	}
}

// The identity-adoption guard: a background local-cli slot whose access token
// has expired is not eligible, because refreshing it would adopt whichever
// account the local CLI is currently logged into.
func TestAnthropicPoolRefusesAnExpiredBackgroundLocalCLISlot(t *testing.T) {
	now := time.Now()
	pool, set := anthropicPoolFixture(t, "a", "b")
	active, other := accountIDFor(t, set, "a"), accountIDFor(t, set, "b")
	set = activate(t, pool, active)

	for index := range set.Accounts {
		if set.Accounts[index].ID == other {
			set.Accounts[index].Credential.Source = SourceLocalCLI
			set.Accounts[index].Credential.Expires = now.Add(-time.Hour).UnixMilli()
		}
	}
	if pool.credentialUsable(set, accountByID(set, other), now) {
		t.Fatal("an expired background local-cli slot was treated as usable")
	}
	// The SAME slot is usable when it is the active account, because then a
	// refresh cannot adopt a different identity.
	set.ActiveAccountID = other
	if !pool.credentialUsable(set, accountByID(set, other), now) {
		t.Fatal("an expired local-cli slot that IS the active account was refused")
	}
}

func accountByID(set ProviderAccountSet, accountID string) ProviderAccount {
	for _, account := range set.Accounts {
		if account.ID == accountID {
			return account
		}
	}
	return ProviderAccount{}
}

// Retry-After parsing, both forms. Seconds round UP so a fractional value
// cannot collapse to no cooldown, and both forms cap at fifteen minutes so an
// upstream cannot remove an account from the pool for hours.

// The selection path must never make a network call. Quota is read from the
// cache synchronously; probing inside selection would put an upstream round
// trip on every request and, worse, let a rate-limited usage endpoint stall
// routing entirely.
func TestAnthropicPoolSelectionNeverProbes(t *testing.T) {
	now := time.Now()
	pool, set := anthropicPoolFixture(t, "a", "b", "c")
	activate(t, pool, accountIDFor(t, set, "a"))

	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		calls++
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"five_hour":{"utilization":42}}`))
	}))
	t.Cleanup(upstream.Close)
	// The probe URL is a constant, so the TRANSPORT is redirected rather than
	// the address. Counting a server the probe could never reach would prove
	// nothing, which is exactly what an earlier version of this test did.
	pool.quota.Client = &http.Client{Transport: rewriteTransport{target: upstream.URL}}

	for index := 1; index <= 6; index++ {
		pool.Resolve(string(rune('0'+index)), poolConfig(true, 80, "round-robin", 1), now)
		pool.Resolve("", poolConfig(true, 80, "fill-first", 1), now)
		pool.Resolve("q", poolConfig(true, 80, "quota", 1), now)
	}
	if calls != 0 {
		t.Fatalf("selection made %d upstream calls, want 0", calls)
	}
}

func TestParseAnthropicRetryAfterMatchesTheOracle(t *testing.T) {
	now := time.Date(2026, 7, 29, 0, 0, 0, 0, time.UTC)
	for _, testCase := range []struct {
		raw  string
		want time.Duration
	}{
		{raw: "3", want: 3 * time.Second},
		{raw: "0.5", want: 500 * time.Millisecond},
		{raw: "0", want: 0},
		{raw: "", want: 0},
		{raw: "soon", want: 0},
		{raw: "100000", want: anthropicMaxCooldown},
		{raw: now.Add(30 * time.Second).Format(http.TimeFormat), want: 30 * time.Second},
		{raw: now.Add(-time.Hour).Format(http.TimeFormat), want: 0},
		{raw: now.Add(time.Hour).Format(http.TimeFormat), want: anthropicMaxCooldown},
		// ISO 8601 is accepted by the oracle's Date.parse but NOT by
		// http.ParseTime, which only knows the three HTTP date formats. Measured
		// against the oracle: "2026-07-29T00:00:30Z" is 30s and
		// "...T00:00:30.500Z" is 30.5s from this instant.
		{raw: "2026-07-29T00:00:30Z", want: 30 * time.Second},
		{raw: "2026-07-29T00:00:30.500Z", want: 30500 * time.Millisecond},
		{raw: "2026-13-45", want: 0},
	} {
		if got := ParseAnthropicRetryAfter(testCase.raw, now); got != testCase.want {
			t.Fatalf("ParseAnthropicRetryAfter(%q) = %v, want %v", testCase.raw, got, testCase.want)
		}
	}
}
