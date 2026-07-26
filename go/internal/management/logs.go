package management

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/config"
	ocxlib "github.com/lidge-jun/opencodex-go/internal/lib"
	"github.com/lidge-jun/opencodex-go/internal/storage"
	"github.com/lidge-jun/opencodex-go/internal/types"
	"github.com/lidge-jun/opencodex-go/internal/usage"
)

type RequestLogEntry struct {
	RequestID     string       `json:"requestId"`
	Timestamp     int64        `json:"timestamp"`
	Provider      string       `json:"provider"`
	Model         string       `json:"model"`
	Status        int          `json:"status"`
	DurationMS    int64        `json:"durationMs"`
	FirstOutputMS *int64       `json:"firstOutputMs,omitempty"`
	ErrorCode     string       `json:"errorCode,omitempty"`
	UpstreamError string       `json:"upstreamError,omitempty"`
	UsageStatus   usage.Status `json:"usageStatus"`
	Usage         *types.Usage `json:"usage,omitempty"`
	TotalTokens   *int         `json:"totalTokens,omitempty"`
}

type RequestLog struct {
	mu       sync.RWMutex
	entries  []RequestLogEntry
	capacity int
	sequence atomic.Uint64
	usage    *usage.Log
}
type RequestAttempt struct {
	RequestID     string
	Provider      string
	Model         string
	StartedAt     time.Time
	FirstOutputMS *int64
}

func NewRequestLog(capacity int) *RequestLog {
	if capacity <= 0 {
		capacity = 200
	}
	return &RequestLog{capacity: capacity, entries: make([]RequestLogEntry, 0, capacity)}
}
func (l *RequestLog) SetUsageLog(log *usage.Log) { l.mu.Lock(); l.usage = log; l.mu.Unlock() }
func (l *RequestLog) Begin(provider, model string) RequestAttempt {
	now := time.Now()
	seq := l.sequence.Add(1) % 1_000_000
	return RequestAttempt{RequestID: fmt.Sprintf("ocx-%s-%x", strconv.FormatInt(now.UnixMilli(), 36), seq), Provider: provider, Model: model, StartedAt: now}
}
func (a *RequestAttempt) MarkFirstOutput(now time.Time) {
	if a.FirstOutputMS == nil {
		value := max(int64(0), now.Sub(a.StartedAt).Milliseconds())
		a.FirstOutputMS = &value
	}
}
func (l *RequestLog) Finish(attempt RequestAttempt, status int, value *types.Usage, upstreamError string) RequestLogEntry {
	usageStatus := usage.StatusUnreported
	var total *int
	if value != nil {
		usageStatus = usage.StatusReported
		if value.Estimated {
			usageStatus = usage.StatusEstimated
		}
		n := usage.CanonicalTotal(*value)
		total = &n
	}
	entry := RequestLogEntry{RequestID: attempt.RequestID, Timestamp: attempt.StartedAt.UnixMilli(), Provider: attempt.Provider, Model: attempt.Model, Status: status, DurationMS: time.Since(attempt.StartedAt).Milliseconds(), FirstOutputMS: attempt.FirstOutputMS, ErrorCode: httpErrorCode(status), UpstreamError: config.RedactString(upstreamError), UsageStatus: usageStatus, Usage: value, TotalTokens: total}
	l.Add(entry)
	return entry
}

// Record adapts terminal bridge usage into the in-memory request log and
// forwards the complete record to the attached JSONL usage recorder.
func (l *RequestLog) Record(ctx context.Context, record *types.UsageRecord) error {
	if record == nil {
		return errors.New("usage record is required")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	total := usage.CanonicalTotal(record.Usage)
	status := usage.StatusReported
	if record.Usage.Estimated {
		status = usage.StatusEstimated
	}
	value := record.Usage
	l.add(RequestLogEntry{
		RequestID: record.RequestID, Timestamp: record.StartedAt.UnixMilli(),
		Provider: record.Provider, Model: record.Model, Status: outcomeStatus(record.Status),
		DurationMS: record.Duration.Milliseconds(), UsageStatus: status,
		Usage: &value, TotalTokens: &total,
	}, false)
	l.mu.RLock()
	persist := l.usage
	l.mu.RUnlock()
	if persist != nil {
		return persist.Append(usage.Entry{
			RequestID: record.RequestID, Timestamp: record.StartedAt.UnixMilli(), ThreadID: record.ThreadID,
			Provider: record.Provider, Model: record.Model, ResolvedModel: record.Model,
			Status: outcomeStatus(record.Status), DurationMS: record.Duration.Milliseconds(),
			UsageStatus: status, Usage: &value, TotalTokens: &total,
		})
	}
	return nil
}

func outcomeStatus(status types.OutcomeStatus) int {
	switch status {
	case types.OutcomeSuccess:
		return http.StatusOK
	case types.OutcomeAuthError:
		return http.StatusUnauthorized
	case types.OutcomeRateLimited:
		return http.StatusTooManyRequests
	case types.OutcomeCancelled:
		return 499
	default:
		return http.StatusBadGateway
	}
}
func (l *RequestLog) Add(entry RequestLogEntry) {
	l.add(entry, true)
}

func (l *RequestLog) add(entry RequestLogEntry, persistEntry bool) {
	entry.UpstreamError = config.RedactString(entry.UpstreamError)
	l.mu.Lock()
	l.entries = append(l.entries, entry)
	if len(l.entries) > l.capacity {
		copy(l.entries, l.entries[len(l.entries)-l.capacity:])
		l.entries = l.entries[:l.capacity]
	}
	persist := l.usage
	l.mu.Unlock()
	if persistEntry && persist != nil {
		_ = persist.Append(usage.Entry{RequestID: entry.RequestID, Timestamp: entry.Timestamp, Provider: entry.Provider, Model: entry.Model, Status: entry.Status, DurationMS: entry.DurationMS, FirstOutputMS: entry.FirstOutputMS, UsageStatus: entry.UsageStatus, Usage: entry.Usage, TotalTokens: entry.TotalTokens, ErrorCode: entry.ErrorCode, UpstreamError: entry.UpstreamError})
	}
}
func (l *RequestLog) Entries(provider, status string, tail int) []RequestLogEntry {
	l.mu.RLock()
	defer l.mu.RUnlock()
	out := make([]RequestLogEntry, 0, len(l.entries))
	for _, entry := range l.entries {
		if provider != "" && entry.Provider != provider {
			continue
		}
		if status != "" && !matchesStatus(entry.Status, status) {
			continue
		}
		out = append(out, entry)
	}
	if tail > 0 && len(out) > tail {
		out = out[len(out)-tail:]
	}
	return out
}
func (l *RequestLog) Clear() { l.mu.Lock(); l.entries = l.entries[:0]; l.mu.Unlock() }
func (l *RequestLog) Hydrate(entries []usage.Entry) {
	l.mu.Lock()
	defer l.mu.Unlock()
	start := max(0, len(entries)-l.capacity)
	for _, entry := range entries[start:] {
		l.entries = append(l.entries, RequestLogEntry{RequestID: entry.RequestID, Timestamp: entry.Timestamp, Provider: entry.Provider, Model: entry.Model, Status: entry.Status, DurationMS: entry.DurationMS, FirstOutputMS: entry.FirstOutputMS, ErrorCode: entry.ErrorCode, UpstreamError: entry.UpstreamError, UsageStatus: entry.UsageStatus, Usage: entry.Usage, TotalTokens: entry.TotalTokens})
	}
}

func (a *API) handleLogs(w http.ResponseWriter, r *http.Request) bool {
	switch r.Method + " " + r.URL.Path {
	case "GET /api/logs":
		if a.advancedRequestLogs != nil {
			writeJSON(w, http.StatusOK, a.advancedRequestLogs.QueryRequestLogs(r.URL.Query()))
			return true
		}
		tail, _ := strconv.Atoi(r.URL.Query().Get("tail"))
		entries := a.requestLogs.Entries(strings.TrimSpace(r.URL.Query().Get("provider")), strings.TrimSpace(r.URL.Query().Get("status")), min(max(tail, 0), 200))
		rows := make([]map[string]any, 0, len(entries))
		for _, entry := range entries {
			rows = append(rows, metricDTO(entry))
		}
		writeJSON(w, http.StatusOK, rows)
		return true
	case "GET /api/debug":
		writeJSON(w, http.StatusOK, debugSettingsDTO(ocxlib.GetDebugSettings()))
		return true
	case "PUT /api/debug":
		var body struct {
			Debug     *bool `json:"debug,omitempty"`
			Usage     *bool `json:"usage,omitempty"`
			Injection *bool `json:"injection,omitempty"`
			Claude    *bool `json:"claude,omitempty"`
			Reset     any   `json:"reset,omitempty"`
		}
		if !decodeJSON(w, r, &body) {
			return true
		}
		var view ocxlib.DebugSettingsView
		switch reset := body.Reset.(type) {
		case bool:
			if reset {
				view = ocxlib.ClearDebugSettings()
			}
		case string:
			flag := ocxlib.DebugFlag(reset)
			if reset == "provider" {
				flag = ocxlib.DebugProvider
			}
			if flag != ocxlib.DebugProvider && flag != ocxlib.DebugUsage && flag != ocxlib.DebugInjection && flag != ocxlib.DebugClaude {
				writeError(w, http.StatusBadRequest, "provide debug/usage/injection/claude booleans or reset:true")
				return true
			}
			view = ocxlib.ClearDebugSetting(flag)
		}
		values := map[ocxlib.DebugFlag]bool{}
		for flag, value := range map[ocxlib.DebugFlag]*bool{ocxlib.DebugProvider: body.Debug, ocxlib.DebugUsage: body.Usage, ocxlib.DebugInjection: body.Injection, ocxlib.DebugClaude: body.Claude} {
			if value != nil {
				values[flag] = *value
			}
		}
		if len(values) > 0 {
			view = ocxlib.SetDebugSettings(values)
		}
		validReset := false
		if reset, ok := body.Reset.(bool); ok && reset {
			validReset = true
		}
		if reset, ok := body.Reset.(string); ok && reset != "" {
			validReset = true
		}
		if !validReset && len(values) == 0 {
			writeError(w, http.StatusBadRequest, "provide debug/usage/injection/claude booleans or reset:true")
			return true
		}
		if body.Claude != nil && a.claudeDebug != nil {
			a.claudeDebug.SetEnabled(*body.Claude)
		}
		if reset, ok := body.Reset.(string); ok && (reset == "claude") && a.claudeDebug != nil {
			a.claudeDebug.SetEnabled(ocxlib.IsClaudeDebugEnabled())
		}
		if reset, ok := body.Reset.(bool); ok && reset && a.claudeDebug != nil {
			a.claudeDebug.SetEnabled(ocxlib.IsClaudeDebugEnabled())
		}
		writeJSON(w, http.StatusOK, debugSettingsDTO(view))
		return true
	case "GET /api/debug/logs":
		after, limit := debugLogQuery(r)
		writeJSON(w, http.StatusOK, a.providerDebug.Entries(uint64(after), limit))
		return true
	case "GET /api/debug/injection-logs":
		after, limit := debugLogQuery(r)
		writeJSON(w, http.StatusOK, a.injectionDebug.Entries(uint64(after), limit))
		return true
	case "GET /api/claude/inbound-debug":
		entries := []any{}
		enabled := ocxlib.IsClaudeDebugEnabled()
		if a.claudeDebug != nil {
			enabled = a.claudeDebug.Enabled()
			values := a.claudeDebug.Entries()
			entries = make([]any, len(values))
			for i := range values {
				entries[i] = values[i]
			}
		}
		writeJSON(w, http.StatusOK, orderedJSONObject{{name: "enabled", value: enabled}, {name: "entries", value: entries}})
		return true
	case "GET /api/debug/usage-logs":
		if a.debugLog == nil {
			writeJSON(w, http.StatusOK, []any{})
			return true
		}
		after, _ := strconv.Atoi(r.URL.Query().Get("after"))
		limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		entries, err := a.debugLog.Entries(after, limit)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "usage diagnostics could not be read")
			return true
		}
		writeJSON(w, http.StatusOK, entries)
		return true
	case "GET /api/usage":
		window := usage.ParseRange(r.URL.Query().Get("range"))
		surface := usage.ParseSurface(r.URL.Query().Get("surface"))
		if a.usageLog == nil {
			writeJSON(w, http.StatusOK, usage.Summarize(nil, window, time.Now(), surface))
			return true
		}
		entries, err := a.usageLog.ReadAll()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "usage log could not be read")
			return true
		}
		writeJSON(w, http.StatusOK, usageSummaryResponse(usage.Summarize(entries, window, time.Now(), surface), entries))
		return true
	case "GET /api/storage":
		home := a.storageHome
		if home == "" {
			writeError(w, http.StatusNotImplemented, "Codex storage home is not configured")
			return true
		}
		report, err := storage.Scan(home)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "storage scan failed")
			return true
		}
		writeJSON(w, http.StatusOK, report)
		return true
	}
	return false
}

type usageModelResponse struct {
	Provider          string  `json:"provider"`
	Model             string  `json:"model"`
	ResolvedModel     string  `json:"resolvedModel,omitempty"`
	Requests          int     `json:"requests"`
	AttemptCount      int     `json:"attemptCount"`
	MeasuredRequests  int     `json:"measuredRequests"`
	ReportedRequests  int     `json:"reportedRequests"`
	EstimatedRequests int     `json:"estimatedRequests"`
	TotalTokens       int     `json:"totalTokens"`
	InputTokens       int     `json:"inputTokens"`
	OutputTokens      int     `json:"outputTokens"`
	ShareRatio        float64 `json:"shareRatio"`
	EstimatedCostUSD  float64 `json:"estimatedCostUsd,omitempty"`
}

type usageSummaryResponseDTO struct {
	Range       usage.Range             `json:"range"`
	Surface     string                  `json:"surface"`
	Since       *int64                  `json:"since"`
	GeneratedAt int64                   `json:"generatedAt"`
	Summary     usage.SummaryTotals     `json:"summary"`
	Days        []usage.Day             `json:"days"`
	Models      []usageModelResponse    `json:"models"`
	Providers   []usage.ProviderSummary `json:"providers"`
}

func usageSummaryResponse(summary usage.Summary, entries []usage.Entry) usageSummaryResponseDTO {
	resolved := make(map[string]string)
	for _, entry := range entries {
		if entry.ResolvedModel != "" {
			resolved[entry.Provider+"\x00"+entry.Model] = entry.ResolvedModel
		}
	}
	models := make([]usageModelResponse, len(summary.Models))
	for index, model := range summary.Models {
		models[index] = usageModelResponse{
			Provider: model.Provider, Model: model.Model, ResolvedModel: resolved[model.Provider+"\x00"+model.Model],
			Requests: model.Requests, AttemptCount: model.AttemptCount, MeasuredRequests: model.MeasuredRequests,
			ReportedRequests: model.ReportedRequests, EstimatedRequests: model.EstimatedRequests,
			InputTokens: model.InputTokens, OutputTokens: model.OutputTokens, TotalTokens: model.TotalTokens,
			ShareRatio: model.ShareRatio, EstimatedCostUSD: model.EstimatedCostUSD,
		}
	}
	return usageSummaryResponseDTO{
		Range: summary.Range, Surface: summary.Surface, Since: summary.Since, GeneratedAt: summary.GeneratedAt,
		Summary: summary.Summary, Days: summary.Days, Models: models, Providers: summary.Providers,
	}
}

func debugLogQuery(r *http.Request) (int, int) {
	afterRaw := r.URL.Query().Get("after")
	if afterRaw == "" {
		afterRaw = r.URL.Query().Get("since")
	}
	after, _ := strconv.Atoi(afterRaw)
	if after < 0 {
		after = 0
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 {
		limit = 500
	}
	if limit > 2000 {
		limit = 2000
	}
	return after, limit
}

func debugSettingsDTO(view ocxlib.DebugSettingsView) orderedJSONObject {
	overrides, environment := orderedJSONObject{}, orderedJSONObject{}
	for _, flag := range []ocxlib.DebugFlag{ocxlib.DebugProvider, ocxlib.DebugUsage, ocxlib.DebugInjection, ocxlib.DebugClaude} {
		if value, ok := view.RuntimeOverride[flag]; ok {
			overrides = append(overrides, orderedJSONField{name: string(flag), value: value})
		}
		environment = append(environment, orderedJSONField{name: string(flag), value: view.Env[flag]})
	}
	return orderedJSONObject{{name: "enabled", value: view.Enabled}, {name: "usage", value: view.Usage}, {name: "injection", value: view.Injection}, {name: "claude", value: view.Claude}, {name: "runtimeOverride", value: overrides}, {name: "env", value: environment}}
}

func matchesStatus(status int, filter string) bool {
	filter = strings.ToLower(filter)
	if len(filter) == 3 && filter[1:] == "xx" {
		want := int(filter[0] - '0')
		return status/100 == want
	}
	return strconv.Itoa(status) == filter
}
func httpErrorCode(status int) string {
	switch {
	case status >= 200 && status < 400:
		return ""
	case status == 400 || status == 409:
		return "invalid_request_error"
	case status == 401:
		return "invalid_api_key"
	case status == 403:
		return "permission_denied"
	case status == 429:
		return "rate_limit_exceeded"
	case status == 499:
		return "client_closed_request"
	case status == 503:
		return "server_is_overloaded"
	case status >= 500:
		return "upstream_server_error"
	default:
		return fmt.Sprintf("http_%d", status)
	}
}

var _ types.UsageRecorder = (*RequestLog)(nil)
