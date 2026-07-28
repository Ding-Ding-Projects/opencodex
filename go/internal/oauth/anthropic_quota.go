package oauth

// Per-account Anthropic 5-hour quota cache, ported from the per-account half of
// src/providers/quota.ts.
//
// Anthropic reports usage per CREDENTIAL, so every logged-in account is probed
// with its own bearer. registry.QuotaFetcher cannot serve this: its cache is
// keyed by PROVIDER, so it can only ever represent one account of a pool.
//
// THE SELECTION PATH NEVER CALLS THIS OVER HTTP. Rotation reads the cache
// synchronously; a network round trip inside account selection would put an
// unbounded upstream latency on the front of every new session, and a slow or
// rate-limited usage endpoint would stall requests that have nothing to do
// with quota.

import (
	"context"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"sync"
	"time"
)

// AnthropicUsageEndpoint is the per-credential usage probe.
const AnthropicUsageEndpoint = "https://api.anthropic.com/api/oauth/usage"

// accountQuotaTTL is deliberately LONGER than the provider-level TTL: this path
// multiplies by account count, and Anthropic rate-limits the usage endpoint
// (observed 429 under repeated probing).
const accountQuotaTTL = 10 * time.Minute

// AccountQuota is one account's cached usage.
type AccountQuota struct {
	// FiveHourPercent is 0..100, or nil when never successfully probed.
	FiveHourPercent *float64
	FiveHourResetAt *time.Time
	UpdatedAt       time.Time
	// Unavailable marks the LAST probe as failed. The percent may still hold
	// the last good reading, which is the point: a transient 429 should not
	// make a healthy account look unknown and shuffle every session.
	Unavailable bool
}

// Known reports whether a usable percentage is present.
func (q AccountQuota) Known() bool {
	return q.FiveHourPercent != nil && !math.IsNaN(*q.FiveHourPercent)
}

type accountQuotaEntry struct {
	quota     AccountQuota
	fetchedAt time.Time
}

// AnthropicQuotaCache holds per-account usage with in-flight de-duplication.
type AnthropicQuotaCache struct {
	Client *http.Client
	TTL    time.Duration
	// Now is injectable so TTL behavior is testable without sleeping.
	Now func() time.Time

	mu       sync.Mutex
	entries  map[string]accountQuotaEntry
	inflight map[string]chan struct{}
}

func NewAnthropicQuotaCache() *AnthropicQuotaCache {
	return &AnthropicQuotaCache{entries: map[string]accountQuotaEntry{}, inflight: map[string]chan struct{}{}}
}

func (c *AnthropicQuotaCache) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}

func (c *AnthropicQuotaCache) ttl() time.Duration {
	if c.TTL > 0 {
		return c.TTL
	}
	return accountQuotaTTL
}

// Lookup reads the cache WITHOUT any network access. This is the only function
// the selection path may call.
func (c *AnthropicQuotaCache) Lookup(accountID string) (AccountQuota, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, found := c.entries[accountID]
	if !found {
		return AccountQuota{}, false
	}
	return entry.quota, true
}

// UsageScore is the rotation score for an account: a known percentage clamped
// to 0..100, or 100 when unknown.
//
// Unknown scoring as 100 is what keeps an unprobed account from looking like
// the emptiest one and attracting every new session.
func (c *AnthropicQuotaCache) UsageScore(accountID string) float64 {
	quota, found := c.Lookup(accountID)
	if !found || !quota.Known() {
		return 100
	}
	return math.Max(0, math.Min(100, *quota.FiveHourPercent))
}

// Refresh probes the account unless a fresh entry exists.
//
// Concurrent callers for the same account JOIN the in-flight probe rather than
// issuing their own: N dashboard pollers must cost one upstream call, not N,
// against an endpoint that rate-limits.
func (c *AnthropicQuotaCache) Refresh(ctx context.Context, accountID, bearer string, force bool) AccountQuota {
	for {
		c.mu.Lock()
		entry, found := c.entries[accountID]
		if !force && found && c.now().Sub(entry.fetchedAt) < c.ttl() {
			c.mu.Unlock()
			return entry.quota
		}
		if wait, running := c.inflight[accountID]; running {
			c.mu.Unlock()
			select {
			case <-wait:
				// The winner stored a result; re-read it rather than probing.
				force = false
				continue
			case <-ctx.Done():
				return entry.quota
			}
		}
		done := make(chan struct{})
		c.inflight[accountID] = done
		previous := entry.quota
		c.mu.Unlock()

		quota, err := c.probe(ctx, bearer)
		c.mu.Lock()
		if err != nil {
			// PRESERVE the last good reading and mark it stale. Advancing the
			// timestamp negative-caches the failure so a broken account does
			// not get re-probed on every poll.
			previous.Unavailable = true
			previous.UpdatedAt = c.now()
			quota = previous
		}
		if c.entries == nil {
			c.entries = map[string]accountQuotaEntry{}
		}
		c.entries[accountID] = accountQuotaEntry{quota: quota, fetchedAt: c.now()}
		delete(c.inflight, accountID)
		c.mu.Unlock()
		close(done)
		return quota
	}
}

func (c *AnthropicQuotaCache) probe(ctx context.Context, bearer string) (AccountQuota, error) {
	client := c.Client
	if client == nil {
		client = http.DefaultClient
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, AnthropicUsageEndpoint, nil)
	if err != nil {
		return AccountQuota{}, err
	}
	request.Header.Set("Authorization", "Bearer "+bearer)
	request.Header.Set("anthropic-beta", "claude-code-20250219,oauth-2025-04-20")
	response, err := client.Do(request)
	if err != nil {
		return AccountQuota{}, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return AccountQuota{}, &QuotaProbeError{Status: response.StatusCode}
	}
	raw, err := io.ReadAll(response.Body)
	if err != nil {
		return AccountQuota{}, err
	}
	var body struct {
		FiveHour *struct {
			Utilization *float64 `json:"utilization"`
			ResetsAt    any      `json:"resets_at"`
		} `json:"five_hour"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return AccountQuota{}, err
	}
	quota := AccountQuota{UpdatedAt: c.now()}
	if body.FiveHour != nil {
		if percent := normalizeQuotaPercent(body.FiveHour.Utilization); percent != nil {
			quota.FiveHourPercent = percent
		}
		if resetAt := normalizeQuotaResetAt(body.FiveHour.ResetsAt); resetAt != nil {
			quota.FiveHourResetAt = resetAt
		}
	}
	return quota, nil
}

// QuotaProbeError reports a non-2xx usage response.
type QuotaProbeError struct{ Status int }

func (e *QuotaProbeError) Error() string {
	return "anthropic usage probe failed with status " + http.StatusText(e.Status)
}

// normalizeQuotaPercent clamps to 0..100.
//
// Anthropic reports utilization as a fraction in some responses and as a
// percentage in others, so a value in 0..1 is scaled. A non-finite value is
// dropped rather than clamped: NaN would otherwise become 0 and make a drained
// account look empty.
func normalizeQuotaPercent(raw *float64) *float64 {
	if raw == nil || math.IsNaN(*raw) || math.IsInf(*raw, 0) {
		return nil
	}
	value := *raw
	if value > 0 && value <= 1 {
		value *= 100
	}
	value = math.Max(0, math.Min(100, value))
	return &value
}

// normalizeQuotaResetAt accepts epoch seconds, epoch milliseconds, or an
// RFC 3339 string, which are the three shapes this endpoint has been observed
// to return.
func normalizeQuotaResetAt(raw any) *time.Time {
	switch value := raw.(type) {
	case float64:
		if math.IsNaN(value) || math.IsInf(value, 0) || value <= 0 {
			return nil
		}
		// Seconds and milliseconds are told apart by magnitude: anything below
		// 10^11 cannot be a plausible millisecond timestamp.
		if value < 1e11 {
			parsed := time.Unix(int64(value), 0).UTC()
			return &parsed
		}
		parsed := time.UnixMilli(int64(value)).UTC()
		return &parsed
	case string:
		parsed, err := time.Parse(time.RFC3339, value)
		if err != nil {
			return nil
		}
		parsed = parsed.UTC()
		return &parsed
	}
	return nil
}
