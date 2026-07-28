package oauth

// Opt-in Anthropic OAuth account pool, ported from src/oauth/anthropic-routing.ts.
//
// Deliberately narrower than the Codex pool: no mid-session quota rotation, no
// soft-avoid ladder, no probe leases. Anthropic OAuth is ToS-sensitive, so the
// pool only decides which already-authorized account serves a new session.
//
// Default OFF. When the pool is disabled this returns the stored active account
// and applies no other judgement at all, which is what makes enabling it a
// deliberate act rather than a behaviour that creeps in.

import (
	"math"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/config"
)

const (
	anthropicPoolProvider    = "anthropic"
	anthropicAffinityIdleTTL = 24 * time.Hour
	anthropicMaxAffinity     = 2000
	anthropicDefaultCooldown = time.Minute
	anthropicMaxCooldown     = 15 * time.Minute
	anthropicUnknownUsage    = 100.0
	anthropicTokenSkew       = time.Minute
)

// Selection reasons. These are reported to management and logs, so the strings
// are part of the contract rather than debug text.
const (
	AnthropicReasonPoolDisabled = "pool-disabled"
	AnthropicReasonAffinity     = "affinity"
	AnthropicReasonActive       = "active"
	AnthropicReasonLowestUsage  = "lowest-usage"
	AnthropicReasonOnlyEligible = "only-eligible"
	AnthropicReasonRoundRobin   = "round-robin"
	AnthropicReasonFillFirst    = "fill-first"
	AnthropicReasonNone         = "none"
	AnthropicReasonAllCooled    = "all-cooled"
)

// AnthropicSelection is one resolution: which account, and why.
type AnthropicSelection struct {
	AccountID string
	Reason    string
}

type anthropicAffinity struct {
	accountID  string
	lastUsedAt time.Time
}

type anthropicCooldown struct {
	until  time.Time
	source string
}

// AnthropicPool owns the process-local routing state for the opt-in pool.
//
// Affinity is intentionally not persisted: a restart is a good moment to
// rebalance, and a stale binding to an account that has since been revoked is
// worse than an extra rotation.
type AnthropicPool struct {
	store    *CredentialStore
	quota    *AnthropicQuotaCache
	rotation *RotationRegistry

	mu        sync.Mutex
	affinity  map[string]anthropicAffinity
	cooldowns map[string]anthropicCooldown
	nowFunc   func() time.Time
}

func NewAnthropicPool(store *CredentialStore) *AnthropicPool {
	return &AnthropicPool{
		store: store, quota: NewAnthropicQuotaCache(), rotation: NewRotationRegistry(),
		affinity: map[string]anthropicAffinity{}, cooldowns: map[string]anthropicCooldown{},
	}
}

// Quota exposes the cache so callers can refresh it out of band. Selection
// itself only ever reads it.
func (p *AnthropicPool) Quota() *AnthropicQuotaCache { return p.quota }

func (p *AnthropicPool) now() time.Time {
	if p.nowFunc != nil {
		return p.nowFunc()
	}
	return time.Now()
}

// usageScoreLocked mirrors the oracle: a known percentage clamped to 0..100,
// and 100 when nothing is known. Unknown scoring as the maximum is what stops
// an unprobed account from looking like the emptiest one.
func (p *AnthropicPool) usageScore(accountID string) float64 {
	quota, found := p.quota.Lookup(accountID)
	if !found || quota.FiveHourPercent == nil || math.IsNaN(*quota.FiveHourPercent) || math.IsInf(*quota.FiveHourPercent, 0) {
		return anthropicUnknownUsage
	}
	return math.Max(0, math.Min(100, *quota.FiveHourPercent))
}

func (p *AnthropicPool) hasKnownUsage(accountID string) bool {
	quota, found := p.quota.Lookup(accountID)
	return found && quota.FiveHourPercent != nil &&
		!math.IsNaN(*quota.FiveHourPercent) && !math.IsInf(*quota.FiveHourPercent, 0)
}

func (p *AnthropicPool) cooledLocked(accountID string, now time.Time) bool {
	entry, found := p.cooldowns[accountID]
	if !found {
		return false
	}
	if !entry.until.After(now) {
		delete(p.cooldowns, accountID)
		return false
	}
	return true
}

// credentialUsableLocked refuses a background local-cli slot whose access token
// has already expired.
//
// This is an identity-adoption guard, not a freshness optimization: refreshing
// such a slot would adopt whichever account the local CLI is currently logged
// into, which may not be the account the caller believes it is using. A
// local-cli slot is only refreshable when it is the store's ACTIVE account.
func (p *AnthropicPool) credentialUsable(set ProviderAccountSet, account ProviderAccount, now time.Time) bool {
	if account.Credential.Source != SourceLocalCLI {
		return true
	}
	if set.ActiveAccountID == account.ID {
		return true
	}
	return account.Credential.Expires > now.Add(anthropicTokenSkew).UnixMilli()
}

func (p *AnthropicPool) eligibleLocked(set ProviderAccountSet, now time.Time) []string {
	eligible := make([]string, 0, len(set.Accounts))
	for _, account := range set.Accounts {
		if account.NeedsReauth {
			continue
		}
		if p.cooledLocked(account.ID, now) {
			continue
		}
		if !p.credentialUsable(set, account, now) {
			continue
		}
		eligible = append(eligible, account.ID)
	}
	return eligible
}

func (p *AnthropicPool) accountUsableLocked(set ProviderAccountSet, accountID string, now time.Time) bool {
	if accountID == "" {
		return false
	}
	for _, account := range set.Accounts {
		if account.ID != accountID {
			continue
		}
		return !account.NeedsReauth && !p.cooledLocked(accountID, now) && p.credentialUsable(set, account, now)
	}
	return false
}

func (p *AnthropicPool) pickLowestUsageLocked(eligible []string, excludeID string) string {
	best, bestScore := "", math.Inf(1)
	for _, id := range eligible {
		if id == excludeID {
			continue
		}
		if score := p.usageScore(id); score < bestScore {
			best, bestScore = id, score
		}
	}
	return best
}

// pickNextFillFirstLocked walks SORTED account ids from afterID, wrapping.
//
// Sorted rather than store order: the walk has to be stable across restarts and
// across accounts being added, or "the next one" would mean something different
// on every process.
func (p *AnthropicPool) pickNextFillFirstLocked(set ProviderAccountSet, afterID string, eligible []string, threshold int) string {
	if len(eligible) == 0 {
		return ""
	}
	ordered := append([]string(nil), eligible...)
	sort.Strings(ordered)
	stable := make([]string, 0, len(set.Accounts))
	for _, account := range set.Accounts {
		stable = append(stable, account.ID)
	}
	sort.Strings(stable)

	underThreshold := func(id string) bool {
		if threshold <= 0 {
			return true
		}
		if !p.hasKnownUsage(id) {
			return true
		}
		return p.usageScore(id) < float64(threshold)
	}

	start := -1
	for index, id := range stable {
		if id == afterID {
			start = index
			break
		}
	}
	if start < 0 {
		for _, id := range ordered {
			if underThreshold(id) {
				return id
			}
		}
		return ordered[0]
	}
	fallback := ""
	for step := 1; step <= len(stable); step++ {
		candidate := stable[(start+step)%len(stable)]
		if !containsAccountID(eligible, candidate) {
			continue
		}
		if fallback == "" {
			fallback = candidate
		}
		if underThreshold(candidate) {
			return candidate
		}
	}
	if fallback != "" {
		return fallback
	}
	return ordered[0]
}

func containsAccountID(ids []string, wanted string) bool {
	for _, id := range ids {
		if id == wanted {
			return true
		}
	}
	return false
}

func (p *AnthropicPool) pruneAffinityLocked(now time.Time) {
	for key, entry := range p.affinity {
		if now.Sub(entry.lastUsedAt) > anthropicAffinityIdleTTL {
			delete(p.affinity, key)
		}
	}
	for len(p.affinity) > anthropicMaxAffinity {
		oldestKey, oldest := "", time.Time{}
		for key, entry := range p.affinity {
			if oldestKey == "" || entry.lastUsedAt.Before(oldest) {
				oldestKey, oldest = key, entry.lastUsedAt
			}
		}
		delete(p.affinity, oldestKey)
	}
}

// Resolve decides which account serves this session.
//
// The order matters and mirrors the oracle exactly: disabled short-circuit,
// then session affinity, then the keyless hold, then the strategy pick, then
// the quota path. Moving the strategy pick earlier would rotate bound sessions;
// moving it later would make it unreachable whenever an active account exists.
func (p *AnthropicPool) Resolve(sessionKey string, pool config.NormalizedAnthropicPool, now time.Time) AnthropicSelection {
	set, found, err := p.store.GetAccountSet(anthropicPoolProvider)
	if err != nil || !found || len(set.Accounts) == 0 {
		return AnthropicSelection{Reason: AnthropicReasonNone}
	}

	p.mu.Lock()
	defer p.mu.Unlock()
	p.pruneAffinityLocked(now)

	if !pool.Enabled {
		return AnthropicSelection{AccountID: set.ActiveAccountID, Reason: AnthropicReasonPoolDisabled}
	}

	key := strings.TrimSpace(sessionKey)
	if key != "" {
		if entry, bound := p.affinity[key]; bound && now.Sub(entry.lastUsedAt) <= anthropicAffinityIdleTTL {
			if p.accountUsableLocked(set, entry.accountID, now) {
				entry.lastUsedAt = now
				p.affinity[key] = entry
				return AnthropicSelection{AccountID: entry.accountID, Reason: AnthropicReasonAffinity}
			}
			delete(p.affinity, key)
		}
	}

	// No session identity (Desktop turns without a sticky key): hold the current
	// active rather than treating every turn as a brand new session, which would
	// rotate the account mid-conversation.
	if key == "" && pool.Strategy != config.AccountPoolStrategyQuota {
		if p.accountUsableLocked(set, set.ActiveAccountID, now) {
			return AnthropicSelection{AccountID: set.ActiveAccountID, Reason: AnthropicReasonActive}
		}
	}

	eligible := p.eligibleLocked(set, now)

	if picked, reason := p.pickByStrategyLocked(set, eligible, pool, now); picked != "" {
		// Deliberately NOT promoted to the store's active account here: the
		// token may still fail validation, and promoting first would leave the
		// pool pointing at an account that never served anything.
		if key != "" {
			p.affinity[key] = anthropicAffinity{accountID: picked, lastUsedAt: now}
			p.pruneAffinityLocked(now)
		}
		return AnthropicSelection{AccountID: picked, Reason: reason}
	}

	activeOK := p.accountUsableLocked(set, set.ActiveAccountID, now)
	accountID, reason := "", AnthropicReasonNone
	switch {
	case pool.AutoSwitchThreshold > 0:
		// Unknown usage must NOT force a switch away from a healthy active.
		if activeOK && (!p.hasKnownUsage(set.ActiveAccountID) ||
			p.usageScore(set.ActiveAccountID) < float64(pool.AutoSwitchThreshold)) {
			accountID, reason = set.ActiveAccountID, AnthropicReasonActive
		} else if picked := p.pickLowestUsageLocked(eligible, ""); picked != "" {
			accountID = picked
			reason = AnthropicReasonLowestUsage
			if activeOK && picked == set.ActiveAccountID {
				reason = AnthropicReasonActive
			}
		} else if activeOK {
			accountID, reason = set.ActiveAccountID, AnthropicReasonActive
		}
	case activeOK:
		accountID, reason = set.ActiveAccountID, AnthropicReasonActive
	default:
		if picked := p.pickLowestUsageLocked(eligible, set.ActiveAccountID); picked != "" {
			accountID, reason = picked, AnthropicReasonOnlyEligible
		}
	}

	if accountID == "" {
		// "all-cooled" and "none" are different operator situations: one waits,
		// the other needs a login.
		for _, account := range set.Accounts {
			if p.cooledLocked(account.ID, now) {
				return AnthropicSelection{Reason: AnthropicReasonAllCooled}
			}
		}
		return AnthropicSelection{Reason: AnthropicReasonNone}
	}
	if key != "" {
		p.affinity[key] = anthropicAffinity{accountID: accountID, lastUsedAt: now}
		p.pruneAffinityLocked(now)
	}
	return AnthropicSelection{AccountID: accountID, Reason: reason}
}

func (p *AnthropicPool) pickByStrategyLocked(
	set ProviderAccountSet, eligible []string, pool config.NormalizedAnthropicPool, now time.Time,
) (string, string) {
	switch pool.Strategy {
	case config.AccountPoolStrategyRoundRobin:
		picked, ok := p.rotation.PickRoundRobinAccount(PoolKeyAnthropic, eligible, pool.StickyLimit)
		if !ok || picked == "" {
			return "", ""
		}
		p.rotation.NoteRotationSuccess(PoolKeyAnthropic, picked, pool.StickyLimit)
		return picked, AnthropicReasonRoundRobin
	case config.AccountPoolStrategyFillFirst:
		if len(eligible) == 0 {
			return "", ""
		}
		active := set.ActiveAccountID
		if active != "" && containsAccountID(eligible, active) &&
			(pool.AutoSwitchThreshold <= 0 || !p.hasKnownUsage(active) ||
				p.usageScore(active) < float64(pool.AutoSwitchThreshold)) {
			return active, AnthropicReasonFillFirst
		}
		if picked := p.pickNextFillFirstLocked(set, active, eligible, pool.AutoSwitchThreshold); picked != "" {
			return picked, AnthropicReasonFillFirst
		}
	}
	return "", ""
}

// NoteFailure cools an account and drops its bindings.
//
// Both the affinity entries and the sticky hold go: a rate-limited account that
// kept either one would keep receiving the very sessions it just rejected.
func (p *AnthropicPool) NoteFailure(accountID, retryAfter string, now time.Time) {
	if accountID == "" {
		return
	}
	delay := ParseAnthropicRetryAfter(retryAfter, now)
	if delay <= 0 {
		delay = anthropicDefaultCooldown
	}
	source := "default"
	if strings.TrimSpace(retryAfter) != "" && ParseAnthropicRetryAfter(retryAfter, now) > 0 {
		source = "retry-after"
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.cooldowns[accountID] = anthropicCooldown{until: now.Add(delay), source: source}
	for key, entry := range p.affinity {
		if entry.accountID == accountID {
			delete(p.affinity, key)
		}
	}
	p.rotation.NoteRotationFailure(PoolKeyAnthropic, accountID)
}

// CooldownUntil reports a live cooldown, expiring a stale one on read.
func (p *AnthropicPool) CooldownUntil(accountID string, now time.Time) (time.Time, string, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	entry, found := p.cooldowns[accountID]
	if !found {
		return time.Time{}, "", false
	}
	if !entry.until.After(now) {
		delete(p.cooldowns, accountID)
		return time.Time{}, "", false
	}
	return entry.until, entry.source, true
}

// ResetForManualSelection clears routing state after an operator picks an
// account, and seeds the ring so the choice is honoured on the next session.
func (p *AnthropicPool) ResetForManualSelection(accountID string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	clear(p.affinity)
	delete(p.cooldowns, accountID)
	p.rotation.SeedRotationAccount(PoolKeyAnthropic, accountID)
}

// Clear drops all pool state, for logout and tests.
func (p *AnthropicPool) Clear() {
	p.mu.Lock()
	defer p.mu.Unlock()
	clear(p.affinity)
	clear(p.cooldowns)
}

var anthropicRetryAfterSeconds = regexp.MustCompile(`^\d+(?:\.\d+)?$`)

// ParseAnthropicRetryAfter reads both Retry-After forms.
//
// Seconds are rounded UP and clamped to at least 1ms, so a fractional value
// cannot collapse to no cooldown at all. Both forms cap at fifteen minutes:
// an upstream asking for hours would otherwise remove the account from the pool
// far longer than the operator ever agreed to.
func ParseAnthropicRetryAfter(raw string, now time.Time) time.Duration {
	text := strings.TrimSpace(raw)
	if text == "" {
		return 0
	}
	if anthropicRetryAfterSeconds.MatchString(text) {
		seconds, err := strconv.ParseFloat(text, 64)
		if err != nil || math.IsNaN(seconds) || math.IsInf(seconds, 0) || seconds <= 0 {
			return 0
		}
		delay := time.Duration(math.Ceil(seconds*1000)) * time.Millisecond
		if delay < time.Millisecond {
			delay = time.Millisecond
		}
		if delay > anthropicMaxCooldown {
			delay = anthropicMaxCooldown
		}
		return delay
	}
	timestamp, err := http.ParseTime(text)
	if err != nil {
		return 0
	}
	delay := timestamp.Sub(now)
	if delay <= 0 {
		return 0
	}
	if delay > anthropicMaxCooldown {
		delay = anthropicMaxCooldown
	}
	return delay
}
