package providers

import (
	"encoding/json"
	"math"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	QuotaCacheTTL       = 5 * time.Minute
	LastGoodQuotaMaxAge = 30 * time.Minute
)

type ProviderQuotaWindow struct {
	Label   string
	Percent float64
	ResetAt time.Time
}
type ProviderQuota struct {
	FiveHourPercent, WeeklyPercent, MonthlyPercent *float64
	FiveHourResetAt, WeeklyResetAt, MonthlyResetAt time.Time
	CustomWindows                                  []ProviderQuotaWindow
	UpdatedAt                                      time.Time
}
type ProviderQuotaReport struct {
	Provider, Label, Source string
	Quota                   ProviderQuota
	UpdatedAt               time.Time
	ReverseEngineered       bool
}
type ProviderQuotaResponse struct {
	GeneratedAt time.Time
	Reports     []ProviderQuotaReport
}

func finiteNumber(value any) (float64, bool) {
	switch v := value.(type) {
	case float64:
		return v, !math.IsNaN(v) && !math.IsInf(v, 0)
	case float32:
		return float64(v), true
	case int:
		return float64(v), true
	case int64:
		return float64(v), true
	case json.Number:
		n, e := v.Float64()
		return n, e == nil
	case string:
		n, e := strconv.ParseFloat(strings.TrimSpace(v), 64)
		return n, e == nil && strings.TrimSpace(v) != ""
	}
	return 0, false
}
func normalizePercent(value any) (float64, bool) {
	n, ok := finiteNumber(value)
	if !ok {
		return 0, false
	}
	if n < 0 {
		n = 0
	}
	if n > 100 {
		n = 100
	}
	return n, true
}
func record(value any) (map[string]any, bool) { r, ok := value.(map[string]any); return r, ok }
func NormalizeResetAt(value any) (time.Time, bool) {
	if n, ok := finiteNumber(value); ok {
		if n < 10_000_000_000 {
			n *= 1000
		}
		return time.UnixMilli(int64(n)), true
	}
	if s, ok := value.(string); ok {
		t, err := time.Parse(time.RFC3339, strings.TrimSpace(s))
		return t, err == nil
	}
	return time.Time{}, false
}
func quotaResetAt(row map[string]any) (time.Time, bool) {
	for _, k := range []string{"resetTime", "resetAt", "reset_time", "reset_at", "resets_at", "billingCycleEnd"} {
		if t, ok := NormalizeResetAt(row[k]); ok {
			return t, true
		}
	}
	return time.Time{}, false
}
func quotaRow(value any, fallback map[string]any) (ProviderQuotaWindow, bool) {
	row, ok := record(value)
	if !ok {
		return ProviderQuotaWindow{}, false
	}
	reset, hasReset := quotaResetAt(row)
	if !hasReset && fallback != nil {
		reset, hasReset = quotaResetAt(fallback)
	}
	limit, lok := finiteNumber(row["limit"])
	if lok && limit > 0 {
		used, uok := finiteNumber(row["used"])
		if !uok {
			if remaining, ok := finiteNumber(row["remaining"]); ok {
				used, uok = limit-remaining, true
			}
		}
		if uok {
			p, _ := normalizePercent(used / limit * 100)
			return ProviderQuotaWindow{Percent: p, ResetAt: reset}, true
		}
	}
	for _, k := range []string{"utilization", "percent", "usedPercent", "used_percent", "usage_percentage"} {
		if p, ok := normalizePercent(row[k]); ok {
			return ProviderQuotaWindow{Percent: p, ResetAt: reset}, true
		}
	}
	if remaining, ok := finiteNumber(row["remainingFraction"]); ok {
		p, _ := normalizePercent((1 - remaining) * 100)
		return ProviderQuotaWindow{Percent: p, ResetAt: reset}, true
	}
	return ProviderQuotaWindow{}, false
}

// ParseQuotaPayload recognizes the normalized TS quota shapes without performing network I/O.
func ParseQuotaPayload(value any, now time.Time) (ProviderQuota, bool) {
	root, ok := record(value)
	if !ok {
		return ProviderQuota{}, false
	}
	q := ProviderQuota{UpdatedAt: now}
	for _, candidate := range []struct {
		keys  []string
		dst   **float64
		reset *time.Time
		label string
	}{{[]string{"five_hour", "fiveHour", "five_hour_percent"}, &q.FiveHourPercent, &q.FiveHourResetAt, "5h"}, {[]string{"seven_day", "weekly", "weekly_percent"}, &q.WeeklyPercent, &q.WeeklyResetAt, "Weekly"}, {[]string{"monthly", "monthly_percent"}, &q.MonthlyPercent, &q.MonthlyResetAt, "Monthly"}} {
		for _, k := range candidate.keys {
			if raw, exists := root[k]; exists {
				w, found := quotaRow(raw, root)
				if found {
					p := w.Percent
					*candidate.dst = &p
					*candidate.reset = w.ResetAt
				}
				break
			}
		}
	}
	if q.FiveHourPercent == nil && q.WeeklyPercent == nil && q.MonthlyPercent == nil {
		if config, ok := record(root["config"]); ok {
			limit, lok := nestedNumber(config["monthlyLimit"])
			used, uok := nestedNumber(config["used"])
			if lok && uok && limit > 0 {
				p, _ := normalizePercent(used / limit * 100)
				q.MonthlyPercent = &p
				q.MonthlyResetAt, _ = NormalizeResetAt(config["billingPeriodEnd"])
			}
		}
	}
	return q, hasQuotaRows(q)
}
func nestedNumber(v any) (float64, bool) {
	if r, ok := record(v); ok {
		return finiteNumber(r["val"])
	}
	return finiteNumber(v)
}
func hasQuotaRows(q ProviderQuota) bool {
	return q.FiveHourPercent != nil || q.WeeklyPercent != nil || q.MonthlyPercent != nil || len(q.CustomWindows) > 0
}

func ParseClaudeQuotaPayload(value any, now time.Time) (ProviderQuota, bool) {
	root, ok := record(value)
	if !ok {
		return ProviderQuota{}, false
	}
	q := ProviderQuota{UpdatedAt: now}
	if w, ok := quotaRow(root["seven_day"], nil); ok {
		p := w.Percent
		q.WeeklyPercent = &p
		q.WeeklyResetAt = w.ResetAt
	}
	for _, c := range []struct{ key, label string }{{"five_hour", "5h"}, {"seven_day_opus", "Opus"}, {"seven_day_sonnet", "Sonnet"}} {
		if w, ok := quotaRow(root[c.key], nil); ok {
			w.Label = c.label
			q.CustomWindows = append(q.CustomWindows, w)
		}
	}
	return q, hasQuotaRows(q)
}
func ParseKimiQuotaPayload(value any, now time.Time) (ProviderQuota, bool) {
	body, ok := record(value)
	if !ok {
		return ProviderQuota{}, false
	}
	if nested, nok := record(body["data"]); nok && !usableKimi(body) && usableKimi(nested) {
		body = nested
	}
	q := ProviderQuota{UpdatedAt: now}
	if w, ok := quotaRow(body["usage"], nil); ok {
		p := w.Percent
		q.WeeklyPercent = &p
		q.WeeklyResetAt = w.ResetAt
	}
	if w, ok := quotaRow(body["totalQuota"], nil); ok {
		w.Label = "Total subscription credits"
		q.CustomWindows = append(q.CustomWindows, w)
	}
	limits, _ := body["limits"].([]any)
	for _, raw := range limits {
		item, ok := record(raw)
		if !ok {
			continue
		}
		detail, _ := record(item["detail"])
		if detail == nil {
			detail = item
		}
		window, _ := record(item["window"])
		label := kimiLabel(item, detail)
		duration, _ := finiteNumber(first(window["duration"], item["duration"], detail["duration"]))
		unit := strings.ToUpper(asString(first(window["timeUnit"], item["timeUnit"], detail["timeUnit"])))
		is5 := (strings.Contains(unit, "MINUTE") && duration == 300) || (strings.Contains(unit, "HOUR") && duration == 5) || strings.Contains(label, "5h") || strings.Contains(label, "5 hour")
		isWeek := (strings.Contains(unit, "DAY") && duration == 7) || (strings.Contains(unit, "HOUR") && duration == 168) || strings.Contains(label, "weekly") || strings.Contains(label, "7 day")
		if is5 && q.FiveHourPercent == nil {
			if w, ok := quotaRow(detail, window); ok {
				p := w.Percent
				q.FiveHourPercent = &p
				q.FiveHourResetAt = w.ResetAt
			}
		}
		if isWeek && q.WeeklyPercent == nil {
			if w, ok := quotaRow(detail, window); ok {
				p := w.Percent
				q.WeeklyPercent = &p
				q.WeeklyResetAt = w.ResetAt
			}
		}
	}
	return q, hasQuotaRows(q)
}

// ParseAntigravityQuotaPayload groups model quota rows into the two dashboard
// families used by the TS implementation (Gemini and Claude/GPT-OSS).
func ParseAntigravityQuotaPayload(value any, now time.Time) (ProviderQuota, bool) {
	root, ok := record(value)
	if !ok {
		return ProviderQuota{}, false
	}
	models, ok := record(root["models"])
	if !ok {
		return ProviderQuota{}, false
	}
	windows := map[string]ProviderQuotaWindow{}
	for modelID, raw := range models {
		model, ok := record(raw)
		if !ok {
			continue
		}
		var entries []map[string]any
		if one, ok := record(model["quotaInfo"]); ok {
			entries = append(entries, one)
		}
		if many, ok := model["quotaInfo"].([]any); ok {
			for _, item := range many {
				if row, ok := record(item); ok {
					entries = append(entries, row)
				}
			}
		}
		if many, ok := model["quotaInfos"].([]any); ok {
			for _, item := range many {
				if row, ok := record(item); ok {
					entries = append(entries, row)
				}
			}
		}
		for _, info := range entries {
			haystack := strings.ToLower(modelID + " " + asString(model["displayName"]) + " " + asString(info["tier"]))
			label := ""
			if strings.Contains(haystack, "gemini") {
				label = "Gem"
			} else if strings.Contains(haystack, "claude") || strings.Contains(haystack, "opus") || strings.Contains(haystack, "sonnet") || strings.Contains(haystack, "gpt-oss") || strings.Contains(haystack, "gpt_oss") {
				label = "Cla"
			}
			if label == "" {
				continue
			}
			if _, exists := windows[label]; exists {
				continue
			}
			remaining, ok := finiteNumber(info["remainingFraction"])
			if !ok {
				if percentage, found := finiteNumber(info["remainingPercentage"]); found {
					remaining, ok = percentage, true
				}
			}
			if !ok {
				continue
			}
			percent, _ := normalizePercent(100 - remaining*100)
			reset, _ := NormalizeResetAt(info["resetTime"])
			windows[label] = ProviderQuotaWindow{Label: label, Percent: percent, ResetAt: reset}
		}
	}
	q := ProviderQuota{UpdatedAt: now}
	for _, label := range []string{"Gem", "Cla"} {
		if window, ok := windows[label]; ok {
			q.CustomWindows = append(q.CustomWindows, window)
		}
	}
	return q, hasQuotaRows(q)
}
func usableKimi(r map[string]any) bool {
	return r["usage"] != nil || r["limits"] != nil || r["totalQuota"] != nil
}
func kimiLabel(a, b map[string]any) string {
	var parts []string
	for _, v := range []any{a["name"], a["title"], a["scope"], b["name"], b["title"]} {
		if s, ok := v.(string); ok {
			parts = append(parts, s)
		}
	}
	return strings.ToLower(strings.Join(parts, " "))
}
func first(vs ...any) any {
	for _, v := range vs {
		if v != nil {
			return v
		}
	}
	return nil
}
func asString(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

type QuotaTracker struct {
	mu          sync.Mutex
	TTL, MaxAge time.Duration
	cached      ProviderQuotaResponse
	cachedAt    time.Time
	key         string
}

func NewQuotaTracker() *QuotaTracker {
	return &QuotaTracker{TTL: QuotaCacheTTL, MaxAge: LastGoodQuotaMaxAge}
}
func (t *QuotaTracker) Get(key string, now time.Time) (ProviderQuotaResponse, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if key != t.key || t.cachedAt.IsZero() || now.Sub(t.cachedAt) >= t.TTL {
		return ProviderQuotaResponse{}, false
	}
	for _, r := range t.cached.Reports {
		if now.Sub(r.UpdatedAt) >= t.MaxAge {
			return ProviderQuotaResponse{}, false
		}
	}
	return cloneQuotaResponse(t.cached), true
}
func (t *QuotaTracker) Commit(key string, fresh []ProviderQuotaReport, now time.Time) ProviderQuotaResponse {
	t.mu.Lock()
	defer t.mu.Unlock()
	by := map[string]ProviderQuotaReport{}
	if key == t.key {
		for _, r := range t.cached.Reports {
			if now.Sub(r.UpdatedAt) < t.MaxAge {
				by[r.Provider] = r
			}
		}
	}
	for _, r := range fresh {
		by[r.Provider] = r
	}
	reports := make([]ProviderQuotaReport, 0, len(by))
	for _, r := range by {
		reports = append(reports, r)
	}
	sort.Slice(reports, func(i, j int) bool { return reports[i].Provider < reports[j].Provider })
	t.key, t.cachedAt, t.cached = key, now, ProviderQuotaResponse{GeneratedAt: now, Reports: reports}
	return cloneQuotaResponse(t.cached)
}
func (t *QuotaTracker) Clear() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.key = ""
	t.cachedAt = time.Time{}
	t.cached = ProviderQuotaResponse{}
}
func cloneQuotaResponse(in ProviderQuotaResponse) ProviderQuotaResponse {
	out := in
	out.Reports = append([]ProviderQuotaReport(nil), in.Reports...)
	for i := range out.Reports {
		out.Reports[i].Quota.CustomWindows = append([]ProviderQuotaWindow(nil), out.Reports[i].Quota.CustomWindows...)
	}
	return out
}
