package codex

import "time"

func thresholdOrDefault(value *float64) float64 {
	if value == nil {
		return 80
	}
	return *value
}

func failoverThresholdOrDefault(value *int) int {
	if value == nil {
		return 3
	}
	return *value
}

func (r *Router) hasConfiguredPoolAccountLocked(config *RoutingConfig, accountID string, now int64) bool {
	if accountID == MainCodexAccountID {
		return r.isUsableLocked(config, accountID, now)
	}
	for _, account := range config.CodexAccounts {
		if !account.IsMain && account.ID == accountID {
			return true
		}
	}
	return false
}

func (r *Router) pickLowerUsageLocked(config *RoutingConfig, active string, activeUsage float64, now int64) string {
	best, bestUsage := active, activeUsage
	for _, accountID := range r.eligibleAccountsLocked(config, active, now) {
		quota, ok := r.quotas[accountID]
		var pointer *AccountQuota
		if ok {
			pointer = &quota
		}
		usage := ComputeCodexUsageScore(pointer, r.accountPlanLocked(config, accountID))
		if usage < bestUsage {
			best, bestUsage = accountID, usage
		}
	}
	return best
}

func (r *Router) applyQuotaAutoSwitchLocked(config *RoutingConfig, active string, now int64) string {
	threshold := thresholdOrDefault(config.AutoSwitchThreshold)
	if threshold <= 0 {
		return active
	}
	quota, ok := r.quotas[active]
	var pointer *AccountQuota
	if ok {
		pointer = &quota
	}
	usage := ComputeCodexUsageScore(pointer, r.accountPlanLocked(config, active))
	if usage < threshold {
		return active
	}
	if best := r.pickLowerUsageLocked(config, active, usage, now); best != active {
		r.setActiveLocked(config, best)
		return best
	}
	if usage >= CodexUnknownUsageScore {
		for _, accountID := range r.eligibleAccountsLocked(config, active, now) {
			candidate, found := r.quotas[accountID]
			var candidatePointer *AccountQuota
			if found {
				candidatePointer = &candidate
			}
			if ComputeCodexUsageScore(candidatePointer, r.accountPlanLocked(config, accountID)) >= CodexUnknownUsageScore {
				r.setActiveLocked(config, accountID)
				return accountID
			}
		}
	}
	return active
}

func (r *Router) shouldFailoverLocked(config *RoutingConfig, accountID string, now int64) bool {
	threshold := failoverThresholdOrDefault(config.UpstreamFailoverThreshold)
	if threshold <= 0 {
		return false
	}
	health, ok := r.health[accountID]
	if !ok || health.LastFailureAt > 0 && now-health.LastFailureAt > CodexFailureWindow.Milliseconds() {
		return false
	}
	return health.ConsecutiveFailures >= threshold
}

func (r *Router) applyFailureFailoverLocked(config *RoutingConfig, active string, now int64) string {
	if !r.shouldFailoverLocked(config, active, now) {
		return active
	}
	if best := r.pickLowestUsageLocked(config, active, now); best != "" {
		r.setActiveLocked(config, best)
		return best
	}
	return active
}

func (r *Router) ResolveCodexAccountForThread(threadID string, config *RoutingConfig, now time.Time) string {
	resolution := r.ResolveCodexAccountForThreadDetailed(threadID, config, now)
	if resolution.Status == ThreadSelected {
		return resolution.AccountID
	}
	return ""
}

// PreviewCodexAccountForRequest mirrors account selection without mutating the
// active account, affinity map, persisted config, or quota probe state.
func (r *Router) PreviewCodexAccountForRequest(threadID string, config *RoutingConfig, now time.Time) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	nowMillis := now.UnixMilli()
	if threadID != "" {
		if entry, found := r.threadAccounts[threadID]; found &&
			nowMillis-entry.lastUsedAt <= CodexThreadAffinityIdleTTL.Milliseconds() &&
			r.generationLiveLocked(entry.accountID, entry.generation) &&
			r.selectableLocked(config, entry.accountID, nowMillis) &&
			!r.shouldFailoverLocked(config, entry.accountID, nowMillis) {
			threshold := thresholdOrDefault(config.AutoSwitchThreshold)
			if threshold > 0 {
				quota, ok := r.quotas[entry.accountID]
				var quotaPointer *AccountQuota
				if ok {
					quotaPointer = &quota
				}
				usage := ComputeCodexUsageScore(quotaPointer, r.accountPlanLocked(config, entry.accountID))
				if usage >= threshold {
					if best := r.pickLowerUsageLocked(config, entry.accountID, usage, nowMillis); best != entry.accountID {
						return best
					}
				}
			}
			return entry.accountID
		}
	}
	active := config.ActiveCodexAccountID
	if active == "" {
		return r.pickLowestUsageLocked(config, "", nowMillis)
	}
	if !r.selectableLocked(config, active, nowMillis) {
		if fallback := r.pickLowestUsageLocked(config, active, nowMillis); fallback != "" {
			active = fallback
		} else if r.hasConfiguredPoolAccountLocked(config, active, nowMillis) {
			return active
		} else {
			return ""
		}
	}
	threshold := thresholdOrDefault(config.AutoSwitchThreshold)
	if threshold > 0 {
		quota, ok := r.quotas[active]
		var quotaPointer *AccountQuota
		if ok {
			quotaPointer = &quota
		}
		usage := ComputeCodexUsageScore(quotaPointer, r.accountPlanLocked(config, active))
		if usage >= threshold {
			active = r.pickLowerUsageLocked(config, active, usage, nowMillis)
		}
	}
	if r.shouldFailoverLocked(config, active, nowMillis) {
		if best := r.pickLowestUsageLocked(config, active, nowMillis); best != "" {
			active = best
		}
	}
	if !r.isUsableLocked(config, active, nowMillis) || r.cooldownUntilLocked(active, nowMillis) != 0 {
		if r.hasConfiguredPoolAccountLocked(config, active, nowMillis) {
			return active
		}
		return ""
	}
	return active
}

func (r *Router) ResolveCodexAccountForThreadDetailed(threadID string, config *RoutingConfig, now time.Time) CodexThreadResolution {
	r.mu.Lock()
	defer r.mu.Unlock()
	nowMillis := now.UnixMilli()
	if threadID != "" {
		if entry, found := r.threadAccounts[threadID]; found {
			if nowMillis-entry.lastUsedAt > CodexThreadAffinityIdleTTL.Milliseconds() {
				delete(r.threadAccounts, threadID)
				return CodexThreadResolution{Status: ThreadExpired, AccountID: entry.accountID}
			}
			if r.generationLiveLocked(entry.accountID, entry.generation) &&
				r.selectableLocked(config, entry.accountID, nowMillis) &&
				!r.shouldFailoverLocked(config, entry.accountID, nowMillis) {
				entry.lastUsedAt = nowMillis
				if nowMillis-entry.lastReevalAt >= CodexThreadAffinityReevalInterval.Milliseconds() {
					entry.lastReevalAt = nowMillis
					if threshold := thresholdOrDefault(config.AutoSwitchThreshold); threshold > 0 {
						quota, ok := r.quotas[entry.accountID]
						var pointer *AccountQuota
						if ok {
							pointer = &quota
						}
						usage := ComputeCodexUsageScore(pointer, r.accountPlanLocked(config, entry.accountID))
						if usage >= threshold {
							if best := r.pickLowerUsageLocked(config, entry.accountID, usage, nowMillis); best != entry.accountID {
								r.setActiveLocked(config, best)
								r.bindThreadLocked(threadID, best, nowMillis)
								return CodexThreadResolution{Status: ThreadSelected, AccountID: best}
							}
						}
					}
				}
				r.threadAccounts[threadID] = entry
				return CodexThreadResolution{Status: ThreadSelected, AccountID: entry.accountID}
			}
			delete(r.threadAccounts, threadID)
		}
	}

	active := config.ActiveCodexAccountID
	if active == "" {
		active = r.pickLowestUsageLocked(config, "", nowMillis)
		if active == "" {
			return CodexThreadResolution{Status: ThreadNone}
		}
		r.setActiveLocked(config, active)
	}
	if !r.selectableLocked(config, active, nowMillis) {
		if fallback := r.pickLowestUsageLocked(config, active, nowMillis); fallback != "" {
			r.setActiveLocked(config, fallback)
			active = fallback
		} else if r.hasConfiguredPoolAccountLocked(config, active, nowMillis) {
			return CodexThreadResolution{Status: ThreadSelected, AccountID: active}
		} else {
			return CodexThreadResolution{Status: ThreadNone}
		}
	}
	active = r.applyQuotaAutoSwitchLocked(config, active, nowMillis)
	active = r.applyFailureFailoverLocked(config, active, nowMillis)
	if !r.isUsableLocked(config, active, nowMillis) || r.cooldownUntilLocked(active, nowMillis) != 0 {
		if r.hasConfiguredPoolAccountLocked(config, active, nowMillis) {
			return CodexThreadResolution{Status: ThreadSelected, AccountID: active}
		}
		return CodexThreadResolution{Status: ThreadNone}
	}
	if threadID != "" {
		r.bindThreadLocked(threadID, active, nowMillis)
	}
	return CodexThreadResolution{Status: ThreadSelected, AccountID: active}
}

func (r *Router) FormatCodexProviderForLog(providerName, accountID string, config *RoutingConfig) string {
	if accountID == "" || accountID == MainCodexAccountID {
		return providerName
	}
	for _, account := range config.CodexAccounts {
		if !account.IsMain && account.ID == accountID {
			return providerName + "-" + CodexAccountLogLabel(account)
		}
	}
	return providerName
}
