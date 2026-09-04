package management

import (
	"context"
	"strings"
	"sync"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/providers"
)

// ProviderQuotaPayload is the authenticated upstream payload returned by the
// runtime composition. Tokens never cross this boundary.
type ProviderQuotaPayload struct {
	Provider          string
	Label             string
	Source            string
	Value             any
	ReverseEngineered bool
}

type ProviderQuotaPayloadSource interface {
	FetchProviderQuotaPayloads(context.Context) ([]ProviderQuotaPayload, error)
	CacheKey() string
}

// ParsedProviderQuotaBackend is the canonical management projection for raw
// provider quota payloads. It shares the providers parser and last-good cache
// across every /api/provider-quotas request.
type ParsedProviderQuotaBackend struct {
	Source  ProviderQuotaPayloadSource
	Tracker *providers.QuotaTracker
	Now     func() time.Time
	mu      sync.Mutex
}

func (b *ParsedProviderQuotaBackend) ProviderQuotas(ctx context.Context, force bool) (ProviderQuotaResponse, error) {
	now := time.Now().UTC()
	if b.Now != nil {
		now = b.Now().UTC()
	}
	b.mu.Lock()
	if b.Tracker == nil {
		b.Tracker = providers.NewQuotaTracker()
	}
	tracker := b.Tracker
	b.mu.Unlock()
	key := "provider-quotas"
	if b.Source != nil && strings.TrimSpace(b.Source.CacheKey()) != "" {
		key = b.Source.CacheKey()
	}
	if !force {
		if cached, ok := tracker.Get(key, now); ok {
			return managementQuotaResponse(cached), nil
		}
	}
	if b.Source == nil {
		return ProviderQuotaResponse{GeneratedAt: now.UnixMilli(), Reports: []ProviderQuotaReport{}}, nil
	}
	payloads, err := b.Source.FetchProviderQuotaPayloads(ctx)
	if err != nil {
		return ProviderQuotaResponse{}, err
	}
	reports := make([]providers.ProviderQuotaReport, 0, len(payloads))
	for _, payload := range payloads {
		quota, ok := parseProviderQuotaPayload(payload.Provider, payload.Value, now)
		if !ok {
			continue
		}
		reports = append(reports, providers.ProviderQuotaReport{
			Provider: payload.Provider, Label: payload.Label, Source: payload.Source,
			Quota: quota, UpdatedAt: now, ReverseEngineered: payload.ReverseEngineered,
		})
	}
	return managementQuotaResponse(tracker.Commit(key, reports, now)), nil
}

func parseProviderQuotaPayload(provider string, value any, now time.Time) (providers.ProviderQuota, bool) {
	switch strings.ToLower(strings.TrimSpace(provider)) {
	case "anthropic", "anthropic-apikey":
		return providers.ParseClaudeQuotaPayload(value, now)
	case "kimi", "kimi-code":
		return providers.ParseKimiQuotaPayload(value, now)
	case "google-antigravity":
		return providers.ParseAntigravityQuotaPayload(value, now)
	default:
		return providers.ParseQuotaPayload(value, now)
	}
}

func managementQuotaResponse(value providers.ProviderQuotaResponse) ProviderQuotaResponse {
	result := ProviderQuotaResponse{GeneratedAt: value.GeneratedAt.UnixMilli(), Reports: make([]ProviderQuotaReport, 0, len(value.Reports))}
	for _, report := range value.Reports {
		result.Reports = append(result.Reports, ProviderQuotaReport{
			Provider: report.Provider, Label: report.Label, Source: report.Source,
			Quota: managementQuota(report.Quota), UpdatedAt: report.UpdatedAt.UnixMilli(), ReverseEngineered: report.ReverseEngineered,
		})
	}
	return result
}

func managementQuota(value providers.ProviderQuota) ProviderQuota {
	result := ProviderQuota{
		FiveHourPercent: value.FiveHourPercent, WeeklyPercent: value.WeeklyPercent, MonthlyPercent: value.MonthlyPercent,
		FiveHourResetAt: millisPointer(value.FiveHourResetAt), WeeklyResetAt: millisPointer(value.WeeklyResetAt),
		MonthlyResetAt: millisPointer(value.MonthlyResetAt), UpdatedAt: value.UpdatedAt.UnixMilli(),
	}
	for _, window := range value.CustomWindows {
		result.CustomWindows = append(result.CustomWindows, ProviderQuotaWindow{Label: window.Label, Percent: window.Percent, ResetAt: millisPointer(window.ResetAt)})
	}
	return result
}

func millisPointer(value time.Time) *int64 {
	if value.IsZero() {
		return nil
	}
	millis := value.UnixMilli()
	return &millis
}
