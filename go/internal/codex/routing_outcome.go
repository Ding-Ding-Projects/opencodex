package codex

import "time"

func cooldownOnly(health UpstreamHealth) UpstreamHealth {
	return UpstreamHealth{
		CooldownUntil: health.CooldownUntil, CooldownSince: health.CooldownSince,
		CooldownSource: health.CooldownSource, CooldownGeneration: health.CooldownGeneration,
		ProbeLeaseID: health.ProbeLeaseID, ProbeLeaseGeneration: health.ProbeLeaseGeneration,
		LastProbeAt: health.LastProbeAt,
	}
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
		if config.ActiveCodexAccountID == accountID {
			if fallback := r.pickLowestUsageLocked(config, accountID, nowMillis); fallback != "" {
				r.setActiveLocked(config, fallback)
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
	escalation := transientSoftAvoidEscalation[min(failures, len(transientSoftAvoidEscalation))-1]
	next := cooldownOnly(base)
	next.ConsecutiveFailures = failures
	next.LastFailureStatus = status
	next.LastFailureAt = nowMillis
	failoverEnabled := failoverThresholdOrDefault(config.UpstreamFailoverThreshold) > 0
	if failoverEnabled {
		next.SoftAvoidUntil = max(r.softAvoidUntilLocked(accountID, nowMillis), nowMillis+escalation.Milliseconds())
	}
	r.health[accountID] = next
	if failoverEnabled && meta.ThreadID != "" {
		if bound, ok := r.threadAccounts[meta.ThreadID]; ok && bound.accountID == accountID {
			delete(r.threadAccounts, meta.ThreadID)
		}
	}
	if r.shouldFailoverLocked(config, accountID, nowMillis) {
		r.clearThreadAccountMapForAccountLocked(accountID)
	}
	if config.ActiveCodexAccountID == accountID {
		r.applyFailureFailoverLocked(config, accountID, nowMillis)
	}
}
