package codex

// Strategy-aware new-session selection, ported from src/codex/routing.ts.
//
// The rotation engine and the quota cache existed before this file and were
// reachable from nothing: selection always fell through to lowest-usage, so a
// configured `round-robin` behaved exactly like `quota`. A setting that is
// accepted, normalized, and then ignored is worse than an unimplemented one,
// which is why the wiring is its own unit.

import (
	"sort"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/oauth"
)

const quotaStrategy = config.AccountPoolStrategyQuota

func (r *Router) strategyLocked(routing *RoutingConfig) string {
	return config.NormalizedAccountPoolStrategy(routing.AccountPoolStrategy)
}

func (r *Router) stickyLimitLocked(routing *RoutingConfig) int {
	return config.NormalizedAccountPoolStickyLimit(routing.AccountPoolStickyLimit)
}

// underFillFirstThresholdLocked reports whether an account may keep serving.
//
// Unknown usage counts as under threshold. Treating it as drained would make a
// never-probed account trigger a move, which is the opposite of what fill-first
// is for.
func (r *Router) underFillFirstThresholdLocked(routing *RoutingConfig, accountID string) bool {
	threshold := thresholdOrDefault(routing.AutoSwitchThreshold)
	if threshold <= 0 {
		return true
	}
	usage := r.usageForLocked(routing, accountID)
	if isUnknownUsage(usage) {
		return true
	}
	return usage < threshold
}

func (r *Router) usageForLocked(routing *RoutingConfig, accountID string) float64 {
	quota, ok := r.quotas[accountID]
	var pointer *AccountQuota
	if ok {
		pointer = &quota
	}
	return ComputeCodexUsageScore(pointer, r.accountPlanLocked(routing, accountID))
}

// stableConfiguredIDsLocked is the wrap-around ring fill-first walks.
//
// It is the CONFIGURED set sorted by id, not the eligible set: the cursor has
// to be locatable even when the account it points at has become ineligible,
// otherwise a cooled-down active would restart the walk from the beginning.
func (r *Router) stableConfiguredIDsLocked(routing *RoutingConfig, afterID string, now int64) []string {
	ids := make([]string, 0, len(routing.CodexAccounts)+1)
	if r.isUsableLocked(routing, MainCodexAccountID, now) || afterID == MainCodexAccountID {
		ids = append(ids, MainCodexAccountID)
	}
	seen := map[string]struct{}{}
	for _, id := range ids {
		seen[id] = struct{}{}
	}
	for _, account := range routing.CodexAccounts {
		if account.IsMain {
			continue
		}
		if _, duplicate := seen[account.ID]; duplicate {
			continue
		}
		seen[account.ID] = struct{}{}
		ids = append(ids, account.ID)
	}
	sort.Strings(ids)
	return ids
}

func containsID(ids []string, wanted string) bool {
	for _, id := range ids {
		if id == wanted {
			return true
		}
	}
	return false
}

// pickNextFillFirstLocked advances to the next eligible id after afterID.
//
// Successors already at or above threshold are SKIPPED when a cooler one
// exists, but the first eligible successor is still returned when every
// candidate is drained: refusing to pick would strand the request even though
// usable credentials remain.
func (r *Router) pickNextFillFirstLocked(routing *RoutingConfig, afterID string, eligible []string, now int64) string {
	if len(eligible) == 0 {
		return ""
	}
	ordered := append([]string(nil), eligible...)
	sort.Strings(ordered)
	if afterID == "" {
		for _, id := range ordered {
			if r.underFillFirstThresholdLocked(routing, id) {
				return id
			}
		}
		return ordered[0]
	}
	stable := r.stableConfiguredIDsLocked(routing, afterID, now)
	start := -1
	for index, id := range stable {
		if id == afterID {
			start = index
			break
		}
	}
	if start < 0 {
		for _, id := range ordered {
			if r.underFillFirstThresholdLocked(routing, id) {
				return id
			}
		}
		return ordered[0]
	}
	fallback := ""
	for step := 1; step <= len(stable); step++ {
		candidate := stable[(start+step)%len(stable)]
		if !containsID(eligible, candidate) {
			continue
		}
		if fallback == "" {
			fallback = candidate
		}
		if r.underFillFirstThresholdLocked(routing, candidate) {
			return candidate
		}
	}
	if fallback != "" {
		return fallback
	}
	return ordered[0]
}

func (r *Router) pickFillFirstLocked(routing *RoutingConfig, now int64) string {
	eligible := r.eligibleAccountsLocked(routing, "", now)
	if len(eligible) == 0 {
		return ""
	}
	active := r.effectiveActiveLocked(routing)
	if active != "" && containsID(eligible, active) && r.underFillFirstThresholdLocked(routing, active) {
		return active
	}
	return r.pickNextFillFirstLocked(routing, active, eligible, now)
}

// pickUnboundStrategyLocked is the new-session pick for the non-quota
// strategies, and returns "" for quota so the caller keeps its existing path.
//
// commit separates the live resolve from the preview: a preview peeks, so ring
// weights, the sticky holder, and the success counter are all left alone. A
// dashboard refresh must not be able to reshuffle who serves the next request.
func (r *Router) pickUnboundStrategyLocked(routing *RoutingConfig, threadID string, now int64, commit bool) string {
	switch r.strategyLocked(routing) {
	case config.AccountPoolStrategyRoundRobin:
		eligible := r.eligibleAccountsLocked(routing, "", now)
		limit := r.stickyLimitLocked(routing)
		if !commit {
			picked, _ := r.rotation.PeekRoundRobinAccount(oauth.PoolKeyCodex, eligible, limit)
			return picked
		}
		picked, ok := r.rotation.PickRoundRobinAccount(oauth.PoolKeyCodex, eligible, limit)
		if !ok || picked == "" {
			return ""
		}
		r.rememberActiveLocked(picked)
		if threadID != "" {
			r.bindThreadLocked(threadID, picked, now)
		}
		// Only round-robin counts successes: stickiness is a property of the
		// ring, and fill-first has no ring to hold.
		r.rotation.NoteRotationSuccess(oauth.PoolKeyCodex, picked, limit)
		return picked
	case config.AccountPoolStrategyFillFirst:
		picked := r.pickFillFirstLocked(routing, now)
		if picked == "" {
			return ""
		}
		if commit {
			r.rememberActiveLocked(picked)
			if threadID != "" {
				r.bindThreadLocked(threadID, picked, now)
			}
		}
		return picked
	}
	return ""
}

// PickAlternateCodexAccount is the strategy-aware replacement after an account
// has been excluded, used by same-request failover and active promotion.
//
// Quota keeps lowest-usage, fill-first advances the stable order, and
// round-robin takes the next ring pick. The caller is expected to have noted
// the failure first, so the failing account no longer holds the sticky slot.
func (r *Router) PickAlternateCodexAccount(routing *RoutingConfig, excludeID string, now int64) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.pickAlternateLocked(routing, excludeID, now)
}

func (r *Router) pickAlternateLocked(routing *RoutingConfig, excludeID string, now int64) string {
	switch r.strategyLocked(routing) {
	case config.AccountPoolStrategyRoundRobin:
		eligible := r.eligibleAccountsLocked(routing, excludeID, now)
		picked, _ := r.rotation.PickRoundRobinAccount(oauth.PoolKeyCodex, eligible, r.stickyLimitLocked(routing))
		return picked
	case config.AccountPoolStrategyFillFirst:
		eligible := r.eligibleAccountsLocked(routing, excludeID, now)
		return r.pickNextFillFirstLocked(routing, excludeID, eligible, now)
	}
	return r.pickLowestUsageLocked(routing, excludeID, now)
}

// promoteActiveLocked persists only under quota.
//
// Round-robin and fill-first promote into the runtime cursor instead, so a
// failover step does not end up recorded on disk as an operator choice.
func (r *Router) promoteActiveLocked(routing *RoutingConfig, accountID string) {
	if r.strategyLocked(routing) == quotaStrategy {
		r.setActiveLocked(routing, accountID)
		return
	}
	r.rememberActiveLocked(accountID)
}

// SeedRotationAccount forces the next pick onto accountID for a manual
// selection, matching seedPoolRotationAccount on the oracle side.
func (r *Router) SeedRotationAccount(accountID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.rotation.SeedRotationAccount(oauth.PoolKeyCodex, accountID)
}

// NoteRotationFailure drops the sticky hold so a failing account stops
// receiving new sessions for the rest of its budget.
func (r *Router) NoteRotationFailure(accountID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.rotation.NoteRotationFailure(oauth.PoolKeyCodex, accountID)
}
