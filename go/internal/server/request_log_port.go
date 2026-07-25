package server

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync/atomic"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

var requestLogSequence atomic.Uint64

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
	Ordinal       int
	Provider      string
	Model         string
	Adapter       string
	Status        int
	Duration      time.Duration
	SendCount     int
	RecoveryKinds []string
	Usage         *types.Usage
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

func canonicalUsageTotal(usage types.Usage) int {
	if usage.TotalTokens > 0 {
		return usage.TotalTokens
	}
	return usage.InputTokens + usage.OutputTokens
}
