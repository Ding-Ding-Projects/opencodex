package codex

import (
	"math"
	"strings"
	"sync"
	"time"
)

const (
	CodexUnknownUsageScore            = 100.0
	CodexFailureWindow                = 5 * time.Minute
	CodexTransientSoftAvoid           = 30 * time.Second
	CodexThreadAffinityIdleTTL        = 24 * time.Hour
	CodexThreadAffinityMaxEntries     = 2048
	CodexThreadAffinityReevalInterval = time.Minute
)

type CodexAccount struct {
	ID               string `json:"id"`
	Email            string `json:"email"`
	Alias            string `json:"alias,omitempty"`
	Plan             string `json:"plan,omitempty"`
	ChatGPTAccountID string `json:"chatgptAccountId,omitempty"`
	LogLabel         string `json:"logLabel,omitempty"`
	IsMain           bool   `json:"isMain"`
}

type RoutingConfig struct {
	CodexAccounts             []CodexAccount `json:"codexAccounts,omitempty"`
	ActiveCodexAccountID      string         `json:"activeCodexAccountId,omitempty"`
	AutoSwitchThreshold       *float64       `json:"autoSwitchThreshold,omitempty"`
	UpstreamFailoverThreshold *int           `json:"upstreamFailoverThreshold,omitempty"`
}

type AccountQuota struct {
	WeeklyPercent  *float64
	MonthlyPercent *float64
}

type CodexThreadResolutionStatus string

const (
	ThreadSelected CodexThreadResolutionStatus = "selected"
	ThreadNone     CodexThreadResolutionStatus = "none"
	ThreadExpired  CodexThreadResolutionStatus = "expired"
)

type CodexThreadResolution struct {
	Status    CodexThreadResolutionStatus
	AccountID string
}

type threadAffinityEntry struct {
	accountID    string
	generation   int64
	createdAt    int64
	lastUsedAt   int64
	lastReevalAt int64
}

// Router owns in-memory health, quota, reauth, and thread-affinity state.
type Router struct {
	mu             sync.Mutex
	store          *AccountStore
	mainToken      func() (MainAccountToken, bool)
	saveConfig     func(*RoutingConfig) error
	threadAccounts map[string]threadAffinityEntry
	health         map[string]UpstreamHealth
	quotas         map[string]AccountQuota
	reauth         map[string]struct{}
	mainPlan       string
}

func NewRouter(store *AccountStore, mainToken func() (MainAccountToken, bool), saveConfig func(*RoutingConfig) error) *Router {
	return &Router{
		store: store, mainToken: mainToken, saveConfig: saveConfig,
		threadAccounts: make(map[string]threadAffinityEntry),
		health:         make(map[string]UpstreamHealth), quotas: make(map[string]AccountQuota),
		reauth: make(map[string]struct{}),
	}
}

func (r *Router) SetAccountQuota(accountID string, quota AccountQuota) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.quotas[accountID] = quota
}

func (r *Router) ClearAccountQuota(accountID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.quotas, accountID)
}

func (r *Router) SetMainAccountPlan(plan string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.mainPlan = plan
}

func (r *Router) MarkAccountNeedsReauth(accountID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.reauth[accountID] = struct{}{}
}

func (r *Router) ClearAccountNeedsReauth(accountID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.reauth, accountID)
}

func (r *Router) AccountNeedsReauth(accountID string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	_, found := r.reauth[accountID]
	return found
}

func (r *Router) ClearThreadAccountMap() {
	r.mu.Lock()
	defer r.mu.Unlock()
	clear(r.threadAccounts)
}

func (r *Router) ClearThreadAccountMapForAccount(accountID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.clearThreadAccountMapForAccountLocked(accountID)
}

func (r *Router) clearThreadAccountMapForAccountLocked(accountID string) {
	for threadID, entry := range r.threadAccounts {
		if entry.accountID == accountID {
			delete(r.threadAccounts, threadID)
		}
	}
}

func ComputeCodexUsageScore(quota *AccountQuota, plan string) float64 {
	if quota == nil {
		return CodexUnknownUsageScore
	}
	if normalized := normalizePlan(plan); normalized == "go" || normalized == "free" {
		if quota.MonthlyPercent != nil && finite(*quota.MonthlyPercent) {
			return *quota.MonthlyPercent
		}
		return CodexUnknownUsageScore
	}
	best := math.Inf(-1)
	for _, value := range []*float64{quota.WeeklyPercent, quota.MonthlyPercent} {
		if value != nil && finite(*value) && *value > best {
			best = *value
		}
	}
	if math.IsInf(best, -1) {
		return CodexUnknownUsageScore
	}
	return best
}

func normalizePlan(plan string) string {
	return strings.ToLower(strings.TrimSpace(plan))
}

func finite(value float64) bool { return !math.IsNaN(value) && !math.IsInf(value, 0) }

func (r *Router) isUsableLocked(config *RoutingConfig, accountID string, now int64) bool {
	_, needsReauth := r.reauth[accountID]
	if accountID == MainCodexAccountID {
		if needsReauth || r.mainToken == nil {
			return false
		}
		token, ok := r.mainToken()
		return ok && token.Live(time.UnixMilli(now))
	}
	configured := false
	for _, account := range config.CodexAccounts {
		if !account.IsMain && account.ID == accountID {
			configured = true
			break
		}
	}
	if !configured || needsReauth || r.store == nil {
		return false
	}
	_, live, err := r.store.GetCredential(accountID)
	return err == nil && live
}

func (r *Router) generationLiveLocked(accountID string, generation int64) bool {
	if accountID == MainCodexAccountID {
		return generation == 0
	}
	return r.store != nil && r.store.IsGenerationLive(accountID, generation)
}

func (r *Router) accountPlanLocked(config *RoutingConfig, accountID string) string {
	if accountID == MainCodexAccountID {
		return r.mainPlan
	}
	for _, account := range config.CodexAccounts {
		if !account.IsMain && account.ID == accountID {
			return account.Plan
		}
	}
	return ""
}

func (r *Router) selectableLocked(config *RoutingConfig, accountID string, now int64) bool {
	return r.cooldownUntilLocked(accountID, now) == 0 && r.softAvoidUntilLocked(accountID, now) == 0 && r.isUsableLocked(config, accountID, now)
}

func (r *Router) eligibleAccountsLocked(config *RoutingConfig, excludeID string, now int64) []string {
	ids := make([]string, 0, len(config.CodexAccounts)+1)
	if excludeID != MainCodexAccountID && r.selectableLocked(config, MainCodexAccountID, now) {
		ids = append(ids, MainCodexAccountID)
	}
	for _, account := range config.CodexAccounts {
		if !account.IsMain && account.ID != excludeID && r.selectableLocked(config, account.ID, now) {
			ids = append(ids, account.ID)
		}
	}
	return ids
}

func (r *Router) pickLowestUsageLocked(config *RoutingConfig, excludeID string, now int64) string {
	best, bestUsage := "", math.Inf(1)
	for _, accountID := range r.eligibleAccountsLocked(config, excludeID, now) {
		quota, ok := r.quotas[accountID]
		var quotaPointer *AccountQuota
		if ok {
			quotaPointer = &quota
		}
		usage := ComputeCodexUsageScore(quotaPointer, r.accountPlanLocked(config, accountID))
		if usage < bestUsage {
			best, bestUsage = accountID, usage
		}
	}
	return best
}

func (r *Router) PickLowestUsageCodexAccount(config *RoutingConfig, excludeID string, now time.Time) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.pickLowestUsageLocked(config, excludeID, now.UnixMilli())
}

func (r *Router) setActiveLocked(config *RoutingConfig, accountID string) {
	if config.ActiveCodexAccountID == accountID {
		return
	}
	config.ActiveCodexAccountID = accountID
	if r.saveConfig != nil {
		_ = r.saveConfig(config)
	}
}

func (r *Router) bindThreadLocked(threadID, accountID string, now int64) {
	generation := int64(0)
	if accountID != MainCodexAccountID {
		record, ok, err := r.store.ReadRecord(accountID)
		if err != nil || !ok || record.Credential == nil || record.DeletedAt != nil {
			return
		}
		generation = record.Generation
	}
	r.pruneExpiredLocked(now)
	previous := r.threadAccounts[threadID]
	createdAt := previous.createdAt
	if createdAt == 0 {
		createdAt = now
	}
	r.threadAccounts[threadID] = threadAffinityEntry{accountID, generation, createdAt, now, now}
	r.pruneLRULocked()
}

func (r *Router) pruneExpiredLocked(now int64) {
	for threadID, entry := range r.threadAccounts {
		if now-entry.lastUsedAt > CodexThreadAffinityIdleTTL.Milliseconds() {
			delete(r.threadAccounts, threadID)
		}
	}
}

func (r *Router) pruneLRULocked() {
	for len(r.threadAccounts) > CodexThreadAffinityMaxEntries {
		oldestID, oldestAt := "", int64(math.MaxInt64)
		for threadID, entry := range r.threadAccounts {
			if entry.lastUsedAt < oldestAt {
				oldestID, oldestAt = threadID, entry.lastUsedAt
			}
		}
		if oldestID == "" {
			return
		}
		delete(r.threadAccounts, oldestID)
	}
}
