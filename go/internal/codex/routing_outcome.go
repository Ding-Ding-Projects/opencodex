package codex

import (
	"time"

	"github.com/lidge-jun/opencodex-go/internal/oauth"
)

func cooldownOnly(health UpstreamHealth) UpstreamHealth {
	return UpstreamHealth{
		CooldownUntil: health.CooldownUntil, CooldownSince: health.CooldownSince,
		CooldownSource: health.CooldownSource, CooldownGeneration: health.CooldownGeneration,
		ProbeLeaseID: health.ProbeLeaseID, ProbeLeaseGeneration: health.ProbeLeaseGeneration,
		LastProbeAt: health.LastProbeAt,
	}
}

// ResetCodexRoutingForManualSelection discards transient routing evidence
// without bypassing a real quota cooldown or its probe state.
func (r *Router) ResetCodexRoutingForManualSelection(accountID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	clear(r.threadAccounts)
	// A manual selection is the operator speaking, so the automatic cursor is
	// dropped rather than left to shadow the choice on the very next request.
	r.runtimeActive = ""
	// Seed the ring too: without this, round-robin would hand the next unbound
	// session to whichever account the ring happened to be pointing at, and the
	// operator's pick would appear to have been ignored.
	r.rotation.SeedRotationAccount(oauth.PoolKeyCodex, accountID)
	current, exists := r.health[accountID]
	if !exists {
		return
	}
	preserved := cooldownOnly(current)
	if preserved == (UpstreamHealth{}) {
		delete(r.health, accountID)
		return
	}
	r.health[accountID] = preserved
}

func (r *Router) RecordCodexUpstreamOutcome(config *RoutingConfig, accountID string, outcome any, meta CodexUpstreamOutcomeMeta) {
	if accountID == "" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	now := meta.Now
	if now.IsZero() {
		now = time.Now()
	}
	nowMillis := now.UnixMilli()
	class := ClassifyCodexUpstreamOutcome(outcome)
	current, exists := r.health[accountID]

	if class == OutcomeClassSuccess {
		cooldown := r.cooldownUntilLocked(accountID, nowMillis)
		if cooldown != 0 && probeMayClearCooldown(current, exists, meta.ProbeLeaseID) {
			delete(r.health, accountID)
			return
		}
		base := current
		if ownsProbeLease(current, exists, meta.ProbeLeaseID) {
			base = releaseProbeLease(current, nowMillis)
		}
		if failoverThresholdOrDefault(config.UpstreamFailoverThreshold) > 0 && exists && current.ConsecutiveFailures >= 2 {
			base.ConsecutiveSuccesses = current.ConsecutiveSuccesses + 1
			if base.ConsecutiveSuccesses < 2 {
				r.health[accountID] = base
				return
			}
		}
		if cooldown != 0 {
			r.health[accountID] = cooldownOnly(base)
		} else {
			delete(r.health, accountID)
		}
		return
	}
	if class == OutcomeClassCaller {
		if ownsProbeLease(current, exists, meta.ProbeLeaseID) {
			r.health[accountID] = releaseProbeLease(current, nowMillis)
		}
		return
	}

	status, _ := numericStatus(outcome)
	if class == OutcomeClassCredential {
		r.health[accountID] = UpstreamHealth{ConsecutiveFailures: 1, LastFailureStatus: status, LastFailureAt: nowMillis}
		r.reauth[accountID] = struct{}{}
		r.clearThreadAccountMapForAccountLocked(accountID)
		return
	}
	if class == OutcomeClassQuota {
		until, source := ComputeQuotaCooldown(meta)
		next := UpstreamHealth{
			LastFailureStatus: status, LastFailureAt: nowMillis, CooldownUntil: until.UnixMilli(),
			CooldownSince: nowMillis, CooldownSource: source, CooldownGeneration: current.CooldownGeneration + 1,
		}
		if ownsProbeLease(current, exists, meta.ProbeLeaseID) {
			next.LastProbeAt = nowMillis
		} else {
			next.ProbeLeaseID = current.ProbeLeaseID
			next.ProbeLeaseGeneration = current.ProbeLeaseGeneration
			next.LastProbeAt = current.LastProbeAt
		}
		r.health[accountID] = next
		r.clearThreadAccountMapForAccountLocked(accountID)
		// A rate-limited account must not keep the sticky hold for the rest of
		// its budget, so the failure is noted before anything is chosen.
		r.rotation.NoteRotationFailure(oauth.PoolKeyCodex, accountID)
		// Compared against the EFFECTIVE active: under a non-quota strategy the
		// serving account lives in the runtime cursor, so testing the persisted
		// field alone would skip the replacement exactly when rotation is on.
		if r.effectiveActiveLocked(config) == accountID {
			if fallback := r.pickAlternateLocked(config, accountID, nowMillis); fallback != "" {
				r.promoteActiveLocked(config, fallback)
			}
		}
		return
	}

	// Unknown terminals follow the TypeScript transient path conservatively.
	base := current
	if ownsProbeLease(current, exists, meta.ProbeLeaseID) {
		base = releaseProbeLease(current, nowMillis)
	}
	stale := current.LastFailureAt > 0 && nowMillis-current.LastFailureAt > CodexFailureWindow.Milliseconds()
	failures := current.ConsecutiveFailures + 1
	if stale {
		failures = 1
	}
	failoverThreshold := failoverThresholdOrDefault(config.UpstreamFailoverThreshold)
	failoverReady := failoverThreshold > 0 && failures >= failoverThreshold
	escalationIndex := min(max(failures-failoverThreshold, 0), len(transientSoftAvoidEscalation)-1)
	escalation := transientSoftAvoidEscalation[escalationIndex]
	next := cooldownOnly(base)
	next.ConsecutiveFailures = failures
	next.LastFailureStatus = status
	next.LastFailureAt = nowMillis
	if failoverReady {
		next.SoftAvoidUntil = max(r.softAvoidUntilLocked(accountID, nowMillis), nowMillis+escalation.Milliseconds())
	}
	r.health[accountID] = next
	if failoverReady && meta.ThreadID != "" {
		if bound, ok := r.threadAccounts[meta.ThreadID]; ok && bound.accountID == accountID {
			delete(r.threadAccounts, meta.ThreadID)
		}
	}
	if r.shouldFailoverLocked(config, accountID, nowMillis) {
		r.clearThreadAccountMapForAccountLocked(accountID)
	}
	// Effective, not persisted: after a non-quota promotion the serving account
	// is the runtime cursor, and comparing the persisted field would silently
	// skip failover for the account that is actually taking the failures.
	if r.effectiveActiveLocked(config) == accountID {
		r.applyFailureFailoverLocked(config, accountID, nowMillis)
	}
}
