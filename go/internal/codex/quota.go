package codex

import (
	"math"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

const monthlyWindowMinSeconds = 28 * 24 * 60 * 60

// StoredAccountQuota mirrors the quota snapshot retained by the TypeScript runtime.
// Reset timestamps use the upstream numeric representation (normally Unix seconds).
type StoredAccountQuota struct {
	WeeklyPercent  *float64 `json:"weeklyPercent,omitempty"`
	MonthlyPercent *float64 `json:"monthlyPercent,omitempty"`
	WeeklyResetAt  *float64 `json:"weeklyResetAt,omitempty"`
	MonthlyResetAt *float64 `json:"monthlyResetAt,omitempty"`
	ResetCredits   *int     `json:"resetCredits,omitempty"`
	UpdatedAt      int64    `json:"updatedAt"`
}

type UsageWindow struct {
	UsedPercent       any `json:"used_percent,omitempty"`
	ResetAt           any `json:"reset_at,omitempty"`
	LimitWindowSecond any `json:"limit_window_seconds,omitempty"`
}

type UsageRateLimit struct {
	PrimaryWindow   *UsageWindow `json:"primary_window,omitempty"`
	SecondaryWindow *UsageWindow `json:"secondary_window,omitempty"`
	TertiaryWindow  *UsageWindow `json:"tertiary_window,omitempty"`
}

type UsageResetCredits struct {
	AvailableCount int `json:"available_count"`
}

type WhamUsageResponse struct {
	Email                 *string            `json:"email,omitempty"`
	PlanType              *string            `json:"plan_type,omitempty"`
	RateLimit             *UsageRateLimit    `json:"rate_limit,omitempty"`
	RateLimitResetCredits *UsageResetCredits `json:"rate_limit_reset_credits,omitempty"`
}

// QuotaStore is concurrency-safe because response processing and account probes
// may update quota snapshots concurrently.
type QuotaStore struct {
	mu      sync.RWMutex
	quotas  map[string]StoredAccountQuota
	nowUnix func() int64
}

func NewQuotaStore() *QuotaStore {
	return &QuotaStore{quotas: make(map[string]StoredAccountQuota), nowUnix: func() int64 { return time.Now().UnixMilli() }}
}

func NormalizeUsagePercent(value any) (*float64, bool) {
	number, ok := numericValue(value)
	if !ok {
		return nil, false
	}
	number = min(100, max(0, number))
	return quotaFloatPointer(number), true
}

func normalizeResetAt(value any) (*float64, bool) {
	number, ok := numericValue(value)
	if !ok || number < 0 {
		return nil, false
	}
	return quotaFloatPointer(number), true
}

func numericValue(value any) (float64, bool) {
	var number float64
	switch typed := value.(type) {
	case float64:
		number = typed
	case float32:
		number = float64(typed)
	case int:
		number = float64(typed)
	case int64:
		number = float64(typed)
	case jsonNumber:
		parsed, err := strconv.ParseFloat(string(typed), 64)
		if err != nil {
			return 0, false
		}
		number = parsed
	case string:
		if strings.TrimSpace(typed) == "" {
			return 0, false
		}
		parsed, err := strconv.ParseFloat(strings.TrimSpace(typed), 64)
		if err != nil {
			return 0, false
		}
		number = parsed
	default:
		return 0, false
	}
	return number, !math.IsNaN(number) && !math.IsInf(number, 0)
}

// jsonNumber is accepted without importing encoding/json solely for its alias.
type jsonNumber string

func isExplicitMonthlyWindow(window *UsageWindow) bool {
	if window == nil {
		return false
	}
	seconds, ok := numericValue(window.LimitWindowSecond)
	return ok && seconds >= monthlyWindowMinSeconds
}

func isExplicitMonthlyWindowMinutes(value any) bool {
	minutes, ok := numericValue(value)
	return ok && minutes >= monthlyWindowMinSeconds/60
}

func quotaHasWeekly(quota StoredAccountQuota) bool {
	return quota.WeeklyPercent != nil || quota.WeeklyResetAt != nil
}

func quotaHasMonthly(quota StoredAccountQuota) bool {
	return quota.MonthlyPercent != nil || quota.MonthlyResetAt != nil
}

func quotaHasKnownUsage(quota StoredAccountQuota) bool {
	return quota.WeeklyPercent != nil || quota.MonthlyPercent != nil
}

// SetParsed applies snapshot replacement semantics. Credits-only snapshots retain
// both usage windows; monthly-only snapshots intentionally clear stale weekly data.
func (s *QuotaStore) SetParsed(accountID string, parsed *StoredAccountQuota) {
	if parsed == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	existing := s.quotas[accountID]
	next := StoredAccountQuota{UpdatedAt: s.nowUnix()}
	creditsOnly := parsed.ResetCredits != nil && !quotaHasWeekly(*parsed) && !quotaHasMonthly(*parsed)
	if creditsOnly {
		next.WeeklyPercent = cloneFloat(existing.WeeklyPercent)
		next.WeeklyResetAt = cloneFloat(existing.WeeklyResetAt)
		next.MonthlyPercent = cloneFloat(existing.MonthlyPercent)
		next.MonthlyResetAt = cloneFloat(existing.MonthlyResetAt)
		next.ResetCredits = cloneInt(parsed.ResetCredits)
		s.quotas[accountID] = next
		return
	}
	if quotaHasWeekly(*parsed) {
		next.WeeklyPercent = cloneFloat(parsed.WeeklyPercent)
		next.WeeklyResetAt = cloneFloat(parsed.WeeklyResetAt)
	} else if !quotaHasMonthly(*parsed) {
		next.WeeklyPercent = cloneFloat(existing.WeeklyPercent)
		next.WeeklyResetAt = cloneFloat(existing.WeeklyResetAt)
	}
	if quotaHasMonthly(*parsed) {
		next.MonthlyPercent = cloneFloat(parsed.MonthlyPercent)
		next.MonthlyResetAt = cloneFloat(parsed.MonthlyResetAt)
	} else if quotaHasWeekly(*parsed) {
		next.MonthlyPercent = cloneFloat(existing.MonthlyPercent)
		next.MonthlyResetAt = cloneFloat(existing.MonthlyResetAt)
	}
	if parsed.ResetCredits != nil {
		next.ResetCredits = cloneInt(parsed.ResetCredits)
	} else {
		next.ResetCredits = cloneInt(existing.ResetCredits)
	}
	s.quotas[accountID] = next
}

func ParseUpstreamQuotaHeaders(headers http.Header) *StoredAccountQuota {
	primaryRaw := headerValue(headers, "x-codex-primary-used-percent")
	secondaryRaw := headerValue(headers, "x-codex-secondary-used-percent")
	tertiaryRaw := headerValue(headers, "x-codex-tertiary-used-percent")
	primary, primaryOK := NormalizeUsagePercent(primaryRaw)
	secondary, secondaryOK := NormalizeUsagePercent(secondaryRaw)
	tertiary, tertiaryOK := NormalizeUsagePercent(tertiaryRaw)
	primaryReset, primaryResetOK := normalizeResetAt(headerValue(headers, "x-codex-primary-reset-at"))
	secondaryReset, secondaryResetOK := normalizeResetAt(headerValue(headers, "x-codex-secondary-reset-at"))
	tertiaryReset, tertiaryResetOK := normalizeResetAt(headerValue(headers, "x-codex-tertiary-reset-at"))
	quota := &StoredAccountQuota{}
	primaryMonthly := primaryRaw != nil && isExplicitMonthlyWindowMinutes(headerValue(headers, "x-codex-primary-window-minutes"))
	if primaryMonthly {
		if primaryOK {
			quota.MonthlyPercent = primary
			if primaryResetOK {
				quota.MonthlyResetAt = primaryReset
			}
		}
		if secondaryOK {
			quota.WeeklyPercent = secondary
			if secondaryResetOK {
				quota.WeeklyResetAt = secondaryReset
			}
		}
	} else if primaryOK || secondaryOK {
		if primaryOK {
			quota.WeeklyPercent = primary
			if primaryResetOK {
				quota.WeeklyResetAt = primaryReset
			}
		} else {
			quota.WeeklyPercent = secondary
			if secondaryResetOK {
				quota.WeeklyResetAt = secondaryReset
			}
		}
	}
	if tertiaryOK && quota.MonthlyPercent == nil {
		quota.MonthlyPercent = tertiary
		if tertiaryResetOK {
			quota.MonthlyResetAt = tertiaryReset
		}
	}
	if !quotaHasKnownUsage(*quota) {
		return nil
	}
	return quota
}

// ApplyUpstreamHeaders is the integration seam for the server response path.
// It returns false when the response contained no recognized usage snapshot.
func (s *QuotaStore) ApplyUpstreamHeaders(accountID string, headers http.Header) bool {
	quota := ParseUpstreamQuotaHeaders(headers)
	if quota == nil {
		return false
	}
	s.SetParsed(accountID, quota)
	return true
}

func headerValue(headers http.Header, key string) any {
	values, ok := headers[http.CanonicalHeaderKey(key)]
	if !ok || len(values) == 0 {
		return nil
	}
	return values[0]
}

func ParseUsageQuota(data WhamUsageResponse) *StoredAccountQuota {
	quota := &StoredAccountQuota{}
	if data.RateLimitResetCredits != nil {
		quota.ResetCredits = quotaIntPointer(data.RateLimitResetCredits.AvailableCount)
	}
	if data.RateLimit == nil {
		if quota.ResetCredits != nil {
			return quota
		}
		return nil
	}
	primary := data.RateLimit.PrimaryWindow
	secondary := data.RateLimit.SecondaryWindow
	tertiary := data.RateLimit.TertiaryWindow
	primaryPercent, primaryOK := windowPercent(primary)
	secondaryPercent, secondaryOK := windowPercent(secondary)
	tertiaryPercent, tertiaryOK := windowPercent(tertiary)
	primaryReset, primaryResetOK := windowReset(primary)
	secondaryReset, secondaryResetOK := windowReset(secondary)
	tertiaryReset, tertiaryResetOK := windowReset(tertiary)
	primaryMonthly := isExplicitMonthlyWindow(primary)
	plan := ""
	if data.PlanType != nil {
		plan = strings.ToLower(strings.TrimSpace(*data.PlanType))
	}
	monthlyOnly := plan == "go" || plan == "free"
	if !monthlyOnly {
		if primaryMonthly && secondaryOK {
			quota.WeeklyPercent = secondaryPercent
			if secondaryResetOK {
				quota.WeeklyResetAt = secondaryReset
			}
		} else if primaryOK {
			quota.WeeklyPercent = primaryPercent
			if primaryResetOK {
				quota.WeeklyResetAt = primaryReset
			}
		} else if secondaryOK {
			quota.WeeklyPercent = secondaryPercent
			if secondaryResetOK {
				quota.WeeklyResetAt = secondaryReset
			}
		}
	}
	if primaryMonthly && primaryOK {
		quota.MonthlyPercent = primaryPercent
		if primaryResetOK {
			quota.MonthlyResetAt = primaryReset
		}
	} else if tertiaryOK {
		quota.MonthlyPercent = tertiaryPercent
		if tertiaryResetOK {
			quota.MonthlyResetAt = tertiaryReset
		}
	}
	if !quotaHasKnownUsage(*quota) && quota.ResetCredits == nil {
		return nil
	}
	return quota
}

func windowPercent(window *UsageWindow) (*float64, bool) {
	if window == nil {
		return nil, false
	}
	return NormalizeUsagePercent(window.UsedPercent)
}

func windowReset(window *UsageWindow) (*float64, bool) {
	if window == nil {
		return nil, false
	}
	return normalizeResetAt(window.ResetAt)
}

func (s *QuotaStore) Update(accountID string, weekly, weeklyReset, monthly, monthlyReset any, resetCredits *int) {
	s.mu.RLock()
	existing := s.quotas[accountID]
	s.mu.RUnlock()
	weeklyValue, weeklyOK := NormalizeUsagePercent(weekly)
	monthlyValue, monthlyOK := NormalizeUsagePercent(monthly)
	if !weeklyOK && !monthlyOK && resetCredits == nil {
		return
	}
	next := cloneStoredQuota(existing)
	if weeklyOK {
		next.WeeklyPercent = weeklyValue
		if value, ok := normalizeResetAt(weeklyReset); ok {
			next.WeeklyResetAt = value
		}
	}
	if monthlyOK {
		next.MonthlyPercent = monthlyValue
		if value, ok := normalizeResetAt(monthlyReset); ok {
			next.MonthlyResetAt = value
		}
	}
	if resetCredits != nil {
		next.ResetCredits = cloneInt(resetCredits)
	}
	next.UpdatedAt = s.nowUnix()
	s.mu.Lock()
	s.quotas[accountID] = next
	s.mu.Unlock()
}

func (s *QuotaStore) Get(accountID string) (StoredAccountQuota, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	quota, ok := s.quotas[accountID]
	return cloneStoredQuota(quota), ok
}

func (s *QuotaStore) List() map[string]StoredAccountQuota {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := make(map[string]StoredAccountQuota, len(s.quotas))
	for id, quota := range s.quotas {
		result[id] = cloneStoredQuota(quota)
	}
	return result
}

func (s *QuotaStore) Clear(accountID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if accountID == "" {
		clear(s.quotas)
	} else {
		delete(s.quotas, accountID)
	}
}

func cloneStoredQuota(value StoredAccountQuota) StoredAccountQuota {
	value.WeeklyPercent = cloneFloat(value.WeeklyPercent)
	value.MonthlyPercent = cloneFloat(value.MonthlyPercent)
	value.WeeklyResetAt = cloneFloat(value.WeeklyResetAt)
	value.MonthlyResetAt = cloneFloat(value.MonthlyResetAt)
	value.ResetCredits = cloneInt(value.ResetCredits)
	return value
}

func cloneFloat(value *float64) *float64 {
	if value == nil {
		return nil
	}
	return quotaFloatPointer(*value)
}
func cloneInt(value *int) *int {
	if value == nil {
		return nil
	}
	return quotaIntPointer(*value)
}
func quotaFloatPointer(value float64) *float64 { return &value }
func quotaIntPointer(value int) *int           { return &value }
