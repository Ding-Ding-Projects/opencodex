package management

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/providers"
)

type productionQuotaPayloadSource struct {
	calls int
}

func (*productionQuotaPayloadSource) CacheKey() string { return "accounts:v1" }
func (s *productionQuotaPayloadSource) FetchProviderQuotaPayloads(context.Context) ([]ProviderQuotaPayload, error) {
	s.calls++
	return []ProviderQuotaPayload{
		{Provider: "anthropic", Label: "Anthropic", Source: "anthropic:oauth-usage", Value: map[string]any{
			"five_hour": map[string]any{"utilization": 25.0, "reset_at": "2026-07-26T12:00:00Z"},
			"seven_day": map[string]any{"utilization": 60.0},
		}},
		{Provider: "kimi", Label: "Kimi", Source: "kimi:usages", Value: map[string]any{"data": map[string]any{
			"usage":  map[string]any{"used": 40.0, "limit": 100.0},
			"limits": []any{map[string]any{"name": "5 hour", "detail": map[string]any{"used": 1.0, "limit": 4.0}}},
		}}},
	}, nil
}

func TestProductionProviderQuotaRouteUsesCanonicalParsersAndCache(t *testing.T) {
	source := &productionQuotaPayloadSource{}
	now := time.Date(2026, 7, 26, 10, 0, 0, 0, time.UTC)
	backend := &ParsedProviderQuotaBackend{Source: source, Tracker: providers.NewQuotaTracker(), Now: func() time.Time { return now }}
	cfg := config.Default()
	api := newParityAPI(t, &cfg, func(options *Options) { options.ProviderQuotas = backend })

	fresh := serveManagement(api, http.MethodGet, "/api/provider-quotas?refresh=1", "")
	for _, want := range []string{`"provider":"anthropic"`, `"fiveHourPercent":25`, `"weeklyPercent":60`, `"provider":"kimi"`, `"fiveHourPercent":25`, `"weeklyPercent":40`, `"resetAt":1785067200000`} {
		if fresh.Code != http.StatusOK || !strings.Contains(fresh.Body.String(), want) {
			t.Fatalf("fresh quota missing %s: %d %s", want, fresh.Code, fresh.Body.String())
		}
	}
	cached := serveManagement(api, http.MethodGet, "/api/provider-quotas", "")
	if cached.Code != http.StatusOK || cached.Body.String() != fresh.Body.String() || source.calls != 1 {
		t.Fatalf("cached=%d %s calls=%d fresh=%s", cached.Code, cached.Body.String(), source.calls, fresh.Body.String())
	}
}
