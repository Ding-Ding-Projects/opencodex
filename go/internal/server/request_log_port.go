package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	ocxlib "github.com/lidge-jun/opencodex-go/internal/lib"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

var requestLogSequence atomic.Uint64

const MaxRequestLogEntries = 200

type RequestLogCloseReason string

const (
	RequestLogTerminal     RequestLogCloseReason = "terminal"
	RequestLogClientCancel RequestLogCloseReason = "client_cancel"
	RequestLogNonStream    RequestLogCloseReason = "non_stream"
	RequestLogBodyStall    RequestLogCloseReason = "body_stall"
	RequestLogBodyOverflow RequestLogCloseReason = "body_overflow"
)

type RequestLogContext struct {
	Model                    string
	Provider                 string
	ProviderAdapter          string
	Surface                  string
	RequestedModel           string
	ComboID                  string
	RequestedEffort          string
	RequestedServiceTier     string
	RequestedSpeedLabel      string
	ConfiguredServiceTier    string
	ConfiguredSpeedLabel     string
	ModelSupportsServiceTier *bool
	ResponseServiceTier      string
	ResolvedModel            string
	FirstOutputMS            *int64
	Usage                    *types.Usage
	UsageLogInputTokens      *int
	Attempts                 []RequestAttemptLog
	ActiveAttempt            *RequestAttemptLog
	ActiveAttemptStartedAt   time.Time
	UpstreamError            string
	TerminalHTTPStatus       int
	Affinity                 string
	TransportPhase           string
	TerminalSource           string
}

// RequestLogEntry deliberately has no request body, response body, header,
// credential, account, or thread fields. This allow-list is the privacy
// boundary for the in-memory diagnostics endpoint.
type RequestLogEntry struct {
	RequestID                string                  `json:"requestId"`
	Timestamp                int64                   `json:"timestamp"`
	Model                    string                  `json:"model"`
	Provider                 string                  `json:"provider"`
	FirstOutputMS            *int64                  `json:"firstOutputMs,omitempty"`
	Surface                  string                  `json:"surface,omitempty"`
	RequestedModel           string                  `json:"requestedModel,omitempty"`
	RequestedEffort          string                  `json:"requestedEffort,omitempty"`
	RequestedServiceTier     string                  `json:"requestedServiceTier,omitempty"`
	RequestedSpeedLabel      string                  `json:"requestedSpeedLabel,omitempty"`
	ConfiguredServiceTier    string                  `json:"configuredServiceTier,omitempty"`
	ConfiguredSpeedLabel     string                  `json:"configuredSpeedLabel,omitempty"`
	ModelSupportsServiceTier *bool                   `json:"modelSupportsServiceTier,omitempty"`
	ResponseServiceTier      string                  `json:"responseServiceTier,omitempty"`
	ResolvedModel            string                  `json:"resolvedModel,omitempty"`
	Status                   int                     `json:"status"`
	DurationMS               int64                   `json:"durationMs"`
	ErrorCode                string                  `json:"errorCode,omitempty"`
	TerminalStatus           ResponsesTerminalStatus `json:"terminalStatus,omitempty"`
	CloseReason              RequestLogCloseReason   `json:"closeReason,omitempty"`
	UpstreamError            string                  `json:"upstreamError,omitempty"`
	UsageStatus              RequestUsageStatus      `json:"usageStatus"`
	Usage                    *types.Usage            `json:"usage,omitempty"`
	TotalTokens              *int                    `json:"totalTokens,omitempty"`
	Attempts                 []RequestAttemptLog     `json:"attempts,omitempty"`
	Affinity                 string                  `json:"affinity,omitempty"`
	TransportPhase           string                  `json:"transportPhase,omitempty"`
	TerminalSource           string                  `json:"terminalSource,omitempty"`
}

type RequestUsageStatus string

const (
	RequestUsageReported    RequestUsageStatus = "reported"
	RequestUsageUnreported  RequestUsageStatus = "unreported"
	RequestUsageUnsupported RequestUsageStatus = "unsupported"
	RequestUsageEstimated   RequestUsageStatus = "estimated"
)

type RequestLogStore struct {
	mu       sync.RWMutex
	capacity int
	entries  []RequestLogEntry
	persist  func(RequestLogEntry) error
}

func NewRequestLogStore(capacity int, persist func(RequestLogEntry) error) *RequestLogStore {
	if capacity <= 0 || capacity > MaxRequestLogEntries {
		capacity = MaxRequestLogEntries
	}
	return &RequestLogStore{capacity: capacity, entries: make([]RequestLogEntry, 0, capacity), persist: persist}
}

// Add sanitizes before either memory or persistence sees the entry. Persistence
// failures are intentionally non-fatal to the serving request.
func (store *RequestLogStore) Add(entry RequestLogEntry) {
	if store == nil {
		return
	}
	entry = sanitizeRequestLogEntry(entry)
	store.mu.Lock()
	if len(store.entries) == store.capacity {
		copy(store.entries, store.entries[1:])
		store.entries[len(store.entries)-1] = entry
	} else {
		store.entries = append(store.entries, entry)
	}
	store.mu.Unlock()
	if store.persist != nil {
		_ = store.persist(cloneRequestLogEntry(entry))
	}
}

func (store *RequestLogStore) Entries() []RequestLogEntry {
	if store == nil {
		return []RequestLogEntry{}
	}
	store.mu.RLock()
	defer store.mu.RUnlock()
	result := make([]RequestLogEntry, len(store.entries))
	for index := range store.entries {
		result[index] = cloneRequestLogEntry(store.entries[index])
	}
	return result
}

func (store *RequestLogStore) Clear() {
	if store == nil {
		return
	}
	store.mu.Lock()
	store.entries = store.entries[:0]
	store.mu.Unlock()
}

func (store *RequestLogStore) QueryRequestLogs(query url.Values) any {
	return FilterRequestLogs(store.Entries(), query)
}

func (store *RequestLogStore) ClearRequestLogs() { store.Clear() }

type requestIDContextKey struct{}

// RequestIDFromContext returns the ingress correlation ID for logs and
// downstream requests. It intentionally contains no account or credential data.
func RequestIDFromContext(ctx context.Context) string {
	value, _ := ctx.Value(requestIDContextKey{}).(string)
	return value
}

func NextRequestLogID(now time.Time) string {
	sequence := requestLogSequence.Add(1) % 1_000_000
	return fmt.Sprintf("ocx-%x-%x", now.UnixMilli(), sequence)
}

func RequestLogErrorCode(status int, upstreamError string) string {
	if status >= 200 && status < 400 {
		return ""
	}
	lower := strings.ToLower(upstreamError)
	if status == 499 || strings.Contains(lower, "client closed") || strings.Contains(lower, "client cancel") {
		return "client_closed_request"
	}
	switch status {
	case 400, 409:
		return "invalid_request_error"
	case 401:
		return "invalid_api_key"
	case 403:
		return "permission_denied"
	case 429:
		return "rate_limit_exceeded"
	case 503:
		return "server_is_overloaded"
	default:
		if status >= 500 {
			return "upstream_server_error"
		}
		return fmt.Sprintf("http_%d", status)
	}
}

// UsageFromResponsesPayload accepts both Responses and Chat Completions token shapes.
func UsageFromResponsesPayload(value any) *types.Usage {
	usage, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	input, inputOK := numberField(usage, "input_tokens")
	output, outputOK := numberField(usage, "output_tokens")
	inputDetails, _ := usage["input_tokens_details"].(map[string]any)
	outputDetails, _ := usage["output_tokens_details"].(map[string]any)
	if !inputOK || !outputOK {
		input, inputOK = numberField(usage, "prompt_tokens")
		output, outputOK = numberField(usage, "completion_tokens")
		inputDetails, _ = usage["prompt_tokens_details"].(map[string]any)
		outputDetails, _ = usage["completion_tokens_details"].(map[string]any)
	}
	if !inputOK || !outputOK {
		return nil
	}
	result := &types.Usage{InputTokens: input, OutputTokens: output}
	result.TotalTokens, _ = numberField(usage, "total_tokens")
	result.CachedInputTokens, _ = numberField(inputDetails, "cached_tokens")
	result.CacheReadInputTokens = result.CachedInputTokens
	result.CacheCreationInputTokens, _ = numberField(inputDetails, "cache_write_tokens")
	result.ReasoningOutputTokens, _ = numberField(outputDetails, "reasoning_tokens")
	return result
}

func numberField(value map[string]any, key string) (int, bool) {
	if value == nil {
		return 0, false
	}
	switch number := value[key].(type) {
	case float64:
		return int(number), true
	case int:
		return number, true
	case json.Number:
		parsed, err := number.Int64()
		return int(parsed), err == nil
	default:
		return 0, false
	}
}

type RequestAttemptLog struct {
	Ordinal            int                `json:"ordinal"`
	Provider           string             `json:"provider"`
	Model              string             `json:"model"`
	Adapter            string             `json:"adapter,omitempty"`
	Status             int                `json:"status"`
	Duration           time.Duration      `json:"-"`
	DurationMS         int64              `json:"durationMs"`
	FirstOutputMS      *int64             `json:"firstOutputMs,omitempty"`
	SendCount          int                `json:"sendCount,omitempty"`
	RecoveryKinds      []string           `json:"recoveryKinds,omitempty"`
	UsageStatus        RequestUsageStatus `json:"usageStatus"`
	Usage              *types.Usage       `json:"usage,omitempty"`
	InputTokenEstimate *int               `json:"-"`
	TotalTokens        *int               `json:"totalTokens,omitempty"`
	ErrorCode          string             `json:"errorCode,omitempty"`
}

func (attempt *RequestAttemptLog) NoteSend(recovery string) {
	attempt.SendCount++
	if recovery == "" {
		return
	}
	for _, existing := range attempt.RecoveryKinds {
		if existing == recovery {
			return
		}
	}
	attempt.RecoveryKinds = append(attempt.RecoveryKinds, recovery)
}

func AggregateAttemptUsage(attempts []RequestAttemptLog) *types.Usage {
	var aggregate *types.Usage
	for _, attempt := range attempts {
		if attempt.Usage == nil {
			continue
		}
		if aggregate == nil {
			aggregate = &types.Usage{}
		}
		aggregate.InputTokens += attempt.Usage.InputTokens
		aggregate.OutputTokens += attempt.Usage.OutputTokens
		aggregate.TotalTokens += canonicalUsageTotal(*attempt.Usage)
		aggregate.CachedInputTokens += attempt.Usage.CachedInputTokens
		aggregate.CacheReadInputTokens += attempt.Usage.CacheReadInputTokens
		aggregate.CacheCreationInputTokens += attempt.Usage.CacheCreationInputTokens
		aggregate.ReasoningOutputTokens += attempt.Usage.ReasoningOutputTokens
		aggregate.Estimated = aggregate.Estimated || attempt.Usage.Estimated
	}
	return aggregate
}

func BeginRequestAttempt(ordinal int, provider, model, adapter string) RequestAttemptLog {
	return RequestAttemptLog{Ordinal: ordinal, Provider: provider, Model: model, Adapter: adapter, UsageStatus: RequestUsageUnreported}
}

func (attempt *RequestAttemptLog) SealIdentity(provider, adapter string) {
	if attempt == nil {
		return
	}
	attempt.Provider = provider
	attempt.Adapter = adapter
}

func (attempt *RequestAttemptLog) NoteSendEstimate(inputTokenEstimate *int, recovery string) {
	if attempt == nil {
		return
	}
	attempt.NoteSend(recovery)
	if inputTokenEstimate != nil && *inputTokenEstimate >= 0 {
		value := *inputTokenEstimate
		attempt.InputTokenEstimate = &value
	}
}

func (attempt *RequestAttemptLog) Finish(status int, duration time.Duration, usage *types.Usage) {
	if attempt == nil {
		return
	}
	attempt.Status = status
	if duration < 0 {
		duration = 0
	}
	attempt.Duration = duration
	attempt.DurationMS = duration.Milliseconds()
	final, usageStatus, total := finalizedRequestUsage(attempt.Adapter, usage, attempt.InputTokenEstimate)
	attempt.Usage, attempt.UsageStatus, attempt.TotalTokens = final, usageStatus, total
	attempt.ErrorCode = RequestLogErrorCode(status, "")
}

func AggregateAttemptUsageStatus(attempts []RequestAttemptLog) (*types.Usage, RequestUsageStatus, *int) {
	status := RequestUsageUnreported
	if len(attempts) > 0 {
		status = RequestUsageReported
		allUnsupported := true
		for _, attempt := range attempts {
			allUnsupported = allUnsupported && attempt.UsageStatus == RequestUsageUnsupported
			switch attempt.UsageStatus {
			case RequestUsageUnreported, RequestUsageUnsupported:
				status = RequestUsageUnreported
			case RequestUsageEstimated:
				if status == RequestUsageReported {
					status = RequestUsageEstimated
				}
			}
		}
		if allUnsupported {
			status = RequestUsageUnsupported
		}
	}
	aggregate := AggregateAttemptUsage(attempts)
	if aggregate == nil {
		return nil, status, nil
	}
	if status == RequestUsageEstimated {
		aggregate.Estimated = true
	}
	total := canonicalUsageTotal(*aggregate)
	aggregate.TotalTokens = total
	return aggregate, status, &total
}

func canonicalUsageTotal(usage types.Usage) int {
	if usage.TotalTokens > 0 {
		return usage.TotalTokens
	}
	return usage.InputTokens + usage.OutputTokens
}

func RecordFirstOutput(logContext *RequestLogContext, requestStartedAt, now time.Time) {
	if logContext == nil || requestStartedAt.IsZero() || now.IsZero() {
		return
	}
	elapsed := now.Sub(requestStartedAt)
	if elapsed < 0 {
		elapsed = 0
	}
	if logContext.FirstOutputMS == nil {
		value := elapsed.Milliseconds()
		logContext.FirstOutputMS = &value
	}
	if logContext.ActiveAttempt != nil && logContext.ActiveAttempt.FirstOutputMS == nil {
		origin := logContext.ActiveAttemptStartedAt
		if origin.IsZero() {
			origin = requestStartedAt
		}
		attemptElapsed := now.Sub(origin)
		if attemptElapsed < 0 {
			attemptElapsed = 0
		}
		value := attemptElapsed.Milliseconds()
		logContext.ActiveAttempt.FirstOutputMS = &value
	}
}

func RequestLogSpeedLabel(serviceTier string) string {
	switch strings.ToLower(strings.TrimSpace(serviceTier)) {
	case "priority", "fast":
		return "fast"
	default:
		return ""
	}
}

func ApplyResponseLogMetadata(logContext *RequestLogContext, payload any) {
	if logContext == nil {
		return
	}
	object, ok := payload.(map[string]any)
	if !ok {
		return
	}
	if response, ok := object["response"].(map[string]any); ok {
		object = response
	}
	if model, ok := object["model"].(string); ok && strings.TrimSpace(model) != "" {
		logContext.ResolvedModel = strings.TrimSpace(model)
	}
	if tier, ok := object["service_tier"].(string); ok && strings.TrimSpace(tier) != "" {
		logContext.ResponseServiceTier = strings.TrimSpace(tier)
	}
	if parsed := UsageFromResponsesPayload(object["usage"]); parsed != nil {
		logContext.Usage = parsed
		if logContext.ActiveAttempt != nil {
			clone := *parsed
			logContext.ActiveAttempt.Usage = &clone
		}
	}
}

func InspectResponseLogJSON(logContext *RequestLogContext, text string) {
	if logContext == nil {
		return
	}
	var payload map[string]any
	if json.Unmarshal([]byte(text), &payload) == nil {
		ApplyResponseLogMetadata(logContext, payload)
		captureRequestLogUpstreamError(logContext, payload, "")
		return
	}
	captureRequestLogUpstreamError(logContext, nil, text)
}

func InspectResponseLogSSEPayload(logContext *RequestLogContext, payload string) {
	if strings.TrimSpace(payload) == "" || strings.TrimSpace(payload) == "[DONE]" {
		return
	}
	InspectResponseLogJSON(logContext, payload)
}

func captureRequestLogUpstreamError(logContext *RequestLogContext, payload map[string]any, fallback string) {
	if logContext == nil || logContext.UpstreamError != "" {
		return
	}
	if payload == nil {
		logContext.UpstreamError = sanitizeDiagnostic(fallback, 500)
		return
	}
	if eventType, _ := payload["type"].(string); eventType == "response.failed" && logContext.TerminalHTTPStatus == 0 {
		response, _ := payload["response"].(map[string]any)
		errorObject, _ := response["error"].(map[string]any)
		for _, key := range []string{"status", "status_code", "code"} {
			if value, ok := numericHTTPStatus(errorObject[key]); ok {
				logContext.TerminalHTTPStatus = value
				break
			}
		}
	}
	message := nestedString(payload, "error", "message")
	if message == "" {
		message = nestedString(payload, "last_error", "message")
	}
	if message == "" {
		message = nestedString(payload, "response", "error", "message")
	}
	if message == "" {
		reason := nestedString(payload, "response", "incomplete_details", "reason")
		switch reason {
		case "upstream_stall_timeout":
			message = "Upstream stalled: no data for the stall-timeout window (upstream_stall_timeout)"
		case "adapter_eof":
			message = "Upstream stream ended unexpectedly without a terminal event (adapter_eof)"
		case "":
		default:
			message = "Upstream incomplete: " + reason
		}
	}
	logContext.UpstreamError = sanitizeDiagnostic(message, 500)
}

func nestedString(value map[string]any, path ...string) string {
	var current any = value
	for _, key := range path {
		object, ok := current.(map[string]any)
		if !ok {
			return ""
		}
		current = object[key]
	}
	text, _ := current.(string)
	return strings.TrimSpace(text)
}

func HTTPStatusForRequestLogTerminal(status ResponsesTerminalStatus, logContext *RequestLogContext) int {
	if status == ResponsesCompleted {
		return 200
	}
	if status == ResponsesFailed && logContext != nil && logContext.TerminalHTTPStatus != 0 {
		return logContext.TerminalHTTPStatus
	}
	return 502
}

func FinalRequestLogEntry(requestID string, startedAt, finishedAt time.Time, logContext *RequestLogContext, status int, terminal ResponsesTerminalStatus, closeReason RequestLogCloseReason) RequestLogEntry {
	if logContext == nil {
		logContext = &RequestLogContext{}
	}
	if finishedAt.Before(startedAt) {
		finishedAt = startedAt
	}
	if status >= 500 && isClientClosedDiagnostic(logContext.UpstreamError) {
		status = 499
	}
	if status == 499 {
		closeReason = RequestLogClientCancel
	}
	if logContext.ActiveAttempt != nil {
		origin := logContext.ActiveAttemptStartedAt
		if origin.IsZero() {
			origin = startedAt
		}
		logContext.ActiveAttempt.Finish(status, finishedAt.Sub(origin), logContext.Usage)
	}
	usage, usageStatus, total := finalizedRequestUsage(logContext.ProviderAdapter, logContext.Usage, logContext.UsageLogInputTokens)
	attempts := cloneRequestAttempts(logContext.Attempts)
	isCombo := logContext.ComboID != "" && len(attempts) > 0
	if isCombo {
		usage, usageStatus, total = AggregateAttemptUsageStatus(attempts)
	}
	model, provider := logContext.Model, logContext.Provider
	if isCombo {
		model, provider = logContext.RequestedModel, "combo"
	}
	entry := RequestLogEntry{
		RequestID: requestID, Timestamp: startedAt.UnixMilli(), Model: model, Provider: provider,
		FirstOutputMS: cloneInt64(logContext.FirstOutputMS), Surface: logContext.Surface,
		RequestedModel: logContext.RequestedModel, RequestedEffort: logContext.RequestedEffort,
		RequestedServiceTier: logContext.RequestedServiceTier, RequestedSpeedLabel: logContext.RequestedSpeedLabel,
		ConfiguredServiceTier: logContext.ConfiguredServiceTier, ConfiguredSpeedLabel: logContext.ConfiguredSpeedLabel,
		ModelSupportsServiceTier: cloneBool(logContext.ModelSupportsServiceTier), ResponseServiceTier: logContext.ResponseServiceTier,
		ResolvedModel: logContext.ResolvedModel, Status: status, DurationMS: finishedAt.Sub(startedAt).Milliseconds(),
		ErrorCode: RequestLogErrorCode(status, logContext.UpstreamError), TerminalStatus: terminal, CloseReason: closeReason,
		UpstreamError: logContext.UpstreamError, UsageStatus: usageStatus, Usage: usage, TotalTokens: total,
		Attempts: attempts, Affinity: logContext.Affinity, TransportPhase: logContext.TransportPhase,
		TerminalSource: logContext.TerminalSource,
	}
	return sanitizeRequestLogEntry(entry)
}

func FilterRequestLogs(entries []RequestLogEntry, query url.Values) []RequestLogEntry {
	provider := strings.TrimSpace(query.Get("provider"))
	statusFilter := strings.ToLower(strings.TrimSpace(query.Get("status")))
	result := make([]RequestLogEntry, 0, len(entries))
	for _, entry := range entries {
		if provider != "" && entry.Provider != provider && !attemptsContainProvider(entry.Attempts, provider) {
			continue
		}
		if statusFilter != "" && !matchesRequestLogStatus(entry.Status, statusFilter) {
			continue
		}
		result = append(result, cloneRequestLogEntry(entry))
	}
	if rawTail := strings.TrimSpace(query.Get("tail")); rawTail != "" {
		var tail int
		if _, err := fmt.Sscanf(rawTail, "%d", &tail); err == nil && tail > 0 && len(result) > tail {
			if tail > MaxRequestLogEntries {
				tail = MaxRequestLogEntries
			}
			result = result[len(result)-tail:]
		}
	}
	return result
}

func attemptsContainProvider(attempts []RequestAttemptLog, provider string) bool {
	for _, attempt := range attempts {
		if attempt.Provider == provider {
			return true
		}
	}
	return false
}

func matchesRequestLogStatus(status int, filter string) bool {
	if len(filter) == 3 && filter[1:] == "xx" && filter[0] >= '1' && filter[0] <= '5' {
		return status/100 == int(filter[0]-'0')
	}
	return fmt.Sprintf("%d", status) == filter
}

func finalizedRequestUsage(adapter string, measured *types.Usage, estimate *int) (*types.Usage, RequestUsageStatus, *int) {
	var result *types.Usage
	if measured != nil {
		copy := *measured
		result = &copy
	}
	if result == nil && estimate != nil && *estimate >= 0 {
		result = &types.Usage{InputTokens: *estimate, Estimated: true}
	} else if result != nil && estimate != nil && *estimate >= 0 && result.InputTokens < *estimate {
		result.InputTokens = *estimate
		result.Estimated = true
	}
	status := RequestUsageUnreported
	if result != nil {
		status = RequestUsageReported
		if result.Estimated {
			status = RequestUsageEstimated
		}
	} else if adapterDoesNotReportUsage(adapter) {
		status = RequestUsageUnsupported
	}
	if result == nil {
		return nil, status, nil
	}
	total := canonicalUsageTotal(*result)
	result.TotalTokens = total
	return result, status, &total
}

func adapterDoesNotReportUsage(adapter string) bool {
	switch strings.ToLower(strings.TrimSpace(adapter)) {
	case "cursor", "windsurf":
		return true
	default:
		return false
	}
}

func sanitizeRequestLogEntry(entry RequestLogEntry) RequestLogEntry {
	entry.RequestID = sanitizeIdentifier(entry.RequestID, 128)
	entry.Model = sanitizeIdentifier(entry.Model, 256)
	entry.Provider = sanitizeIdentifier(entry.Provider, 128)
	entry.Surface = sanitizeIdentifier(entry.Surface, 32)
	entry.RequestedModel = sanitizeIdentifier(entry.RequestedModel, 256)
	entry.RequestedEffort = sanitizeIdentifier(entry.RequestedEffort, 32)
	entry.RequestedServiceTier = sanitizeIdentifier(entry.RequestedServiceTier, 64)
	entry.RequestedSpeedLabel = sanitizeIdentifier(entry.RequestedSpeedLabel, 64)
	entry.ConfiguredServiceTier = sanitizeIdentifier(entry.ConfiguredServiceTier, 64)
	entry.ConfiguredSpeedLabel = sanitizeIdentifier(entry.ConfiguredSpeedLabel, 64)
	entry.ResponseServiceTier = sanitizeIdentifier(entry.ResponseServiceTier, 64)
	entry.ResolvedModel = sanitizeIdentifier(entry.ResolvedModel, 256)
	entry.ErrorCode = sanitizeIdentifier(entry.ErrorCode, 64)
	entry.UpstreamError = sanitizeDiagnostic(entry.UpstreamError, 500)
	entry.Affinity = sanitizeIdentifier(entry.Affinity, 32)
	entry.TransportPhase = sanitizeIdentifier(entry.TransportPhase, 32)
	entry.TerminalSource = sanitizeIdentifier(entry.TerminalSource, 32)
	entry.Usage = cloneUsageValue(entry.Usage)
	entry.Attempts = cloneRequestAttempts(entry.Attempts)
	for index := range entry.Attempts {
		entry.Attempts[index].Provider = sanitizeIdentifier(entry.Attempts[index].Provider, 128)
		entry.Attempts[index].Model = sanitizeIdentifier(entry.Attempts[index].Model, 256)
		entry.Attempts[index].Adapter = sanitizeIdentifier(entry.Attempts[index].Adapter, 64)
		entry.Attempts[index].ErrorCode = sanitizeIdentifier(entry.Attempts[index].ErrorCode, 64)
		for recoveryIndex := range entry.Attempts[index].RecoveryKinds {
			entry.Attempts[index].RecoveryKinds[recoveryIndex] = sanitizeIdentifier(entry.Attempts[index].RecoveryKinds[recoveryIndex], 64)
		}
		sort.Strings(entry.Attempts[index].RecoveryKinds)
	}
	return entry
}

func sanitizeIdentifier(value string, max int) string {
	value = ocxlib.RedactSecretString(strings.TrimSpace(value))
	if len(value) > max {
		value = value[:max]
	}
	return value
}

func sanitizeDiagnostic(value string, max int) string {
	// Diagnostics may arrive as "status text {raw upstream body}". Request logs
	// retain the status text but never the embedded body, even after individual
	// credentials inside it have been redacted.
	if index := firstStructuredPayloadIndex(value); index >= 0 {
		value = strings.TrimSpace(value[:index]) + " [REDACTED]"
	}
	value = strings.TrimSpace(ocxlib.RedactSecretString(value))
	if len(value) > max {
		value = value[:max]
	}
	return value
}

func firstStructuredPayloadIndex(value string) int {
	object := strings.IndexByte(value, '{')
	array := strings.IndexByte(value, '[')
	if object < 0 {
		return array
	}
	if array < 0 || object < array {
		return object
	}
	return array
}

func isClientClosedDiagnostic(value string) bool {
	lower := strings.ToLower(value)
	return strings.Contains(lower, "client closed") || strings.Contains(lower, "client cancel") || strings.Contains(lower, "broken pipe")
}

func cloneRequestLogEntry(entry RequestLogEntry) RequestLogEntry {
	entry.FirstOutputMS = cloneInt64(entry.FirstOutputMS)
	entry.ModelSupportsServiceTier = cloneBool(entry.ModelSupportsServiceTier)
	entry.TotalTokens = cloneInt(entry.TotalTokens)
	entry.Usage = cloneUsageValue(entry.Usage)
	entry.Attempts = cloneRequestAttempts(entry.Attempts)
	return entry
}

func cloneRequestAttempts(attempts []RequestAttemptLog) []RequestAttemptLog {
	if len(attempts) == 0 {
		return nil
	}
	result := make([]RequestAttemptLog, len(attempts))
	for index, attempt := range attempts {
		result[index] = attempt
		result[index].FirstOutputMS = cloneInt64(attempt.FirstOutputMS)
		result[index].InputTokenEstimate = cloneInt(attempt.InputTokenEstimate)
		result[index].TotalTokens = cloneInt(attempt.TotalTokens)
		result[index].RecoveryKinds = append([]string(nil), attempt.RecoveryKinds...)
		result[index].Usage = cloneUsageValue(attempt.Usage)
	}
	return result
}

func cloneUsageValue(value *types.Usage) *types.Usage {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func cloneInt(value *int) *int {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func cloneInt64(value *int64) *int64 {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func cloneBool(value *bool) *bool {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}
