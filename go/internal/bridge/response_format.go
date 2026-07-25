package bridge

import (
	"encoding/json"
	"fmt"
	"io"

	"github.com/lidge-jun/opencodex-go/internal/lib"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

type errorEnvelope struct {
	Error lib.ErrorPayload `json:"error"`
}

// FormatErrorResponse builds the non-streaming OpenAI error envelope used when
// a request fails before a Responses SSE stream begins.
func FormatErrorResponse(status int, errorType, message string) ([]byte, error) {
	return json.Marshal(errorEnvelope{Error: lib.ClassifyError(status, errorType, message)})
}

func responseError(status int, errorType, message string) map[string]any {
	payload := lib.ClassifyError(status, errorType, message)
	result := map[string]any{"message": payload.Message}
	if payload.Type != "" {
		result["type"] = payload.Type
	}
	if payload.Code != nil {
		result["code"] = *payload.Code
	}
	return result
}

func doneIncompleteReason(stopReason string) string {
	switch stopReason {
	case "max_tokens", "max_output_tokens":
		return "max_output_tokens"
	case "content_filter":
		return "content_filter"
	default:
		return ""
	}
}

func writeSSE(w io.Writer, event Event) error {
	payload := make(map[string]any, len(event.Data)+1)
	for key, value := range event.Data {
		payload[key] = value
	}
	payload["type"] = event.Type
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event.Type, data)
	return err
}

func usage(value *types.Usage) map[string]any {
	if value == nil {
		return map[string]any{"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
	}
	total := value.TotalTokens
	if total == 0 {
		total = value.InputTokens + value.OutputTokens
	}
	result := map[string]any{"input_tokens": value.InputTokens, "output_tokens": value.OutputTokens, "total_tokens": total}
	inputDetails := map[string]any{}
	if value.CachedInputTokens != 0 {
		inputDetails["cached_tokens"] = value.CachedInputTokens
	}
	if value.CacheCreationInputTokens != 0 {
		inputDetails["cache_write_tokens"] = value.CacheCreationInputTokens
	}
	if len(inputDetails) > 0 {
		result["input_tokens_details"] = inputDetails
	}
	if value.ReasoningOutputTokens != 0 {
		result["output_tokens_details"] = map[string]any{"reasoning_tokens": value.ReasoningOutputTokens}
	}
	return result
}

func cloneUsage(value *types.Usage) *types.Usage {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}
