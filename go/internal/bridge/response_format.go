package bridge

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"reflect"
	"sort"

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
	data, err := marshalResponseEvent(event)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event.Type, data)
	return err
}

func marshalResponseEvent(event Event) ([]byte, error) {
	payload := make(map[string]any, len(event.Data)+1)
	for key, value := range event.Data {
		payload[key] = value
	}
	payload["type"] = event.Type
	return marshalOrderedJSON(payload, eventKeyOrder(event.Type))
}

func marshalOrderedJSON(value any, preferred []string) ([]byte, error) {
	var output bytes.Buffer
	if err := appendOrderedJSON(&output, reflect.ValueOf(value), preferred); err != nil {
		return nil, err
	}
	return output.Bytes(), nil
}

func appendOrderedJSON(output *bytes.Buffer, value reflect.Value, preferred []string) error {
	if !value.IsValid() {
		output.WriteString("null")
		return nil
	}
	for value.Kind() == reflect.Interface || value.Kind() == reflect.Pointer {
		if value.IsNil() {
			output.WriteString("null")
			return nil
		}
		value = value.Elem()
	}
	if (value.Kind() == reflect.Map || value.Kind() == reflect.Slice) && value.IsNil() {
		output.WriteString("null")
		return nil
	}
	switch value.Kind() {
	case reflect.Map:
		if value.Type().Key().Kind() != reflect.String {
			return appendStandardJSON(output, value.Interface())
		}
		keys := make([]string, 0, value.Len())
		iterator := value.MapRange()
		for iterator.Next() {
			keys = append(keys, iterator.Key().String())
		}
		keys = orderJSONKeys(keys, preferred)
		output.WriteByte('{')
		for index, key := range keys {
			if index > 0 {
				output.WriteByte(',')
			}
			encodedKey, _ := json.Marshal(key)
			output.Write(encodedKey)
			output.WriteByte(':')
			child := value.MapIndex(reflect.ValueOf(key).Convert(value.Type().Key()))
			if err := appendOrderedJSON(output, child, nestedKeyOrder(key, child)); err != nil {
				return err
			}
		}
		output.WriteByte('}')
		return nil
	case reflect.Slice, reflect.Array:
		output.WriteByte('[')
		for index := 0; index < value.Len(); index++ {
			if index > 0 {
				output.WriteByte(',')
			}
			if err := appendOrderedJSON(output, value.Index(index), nestedKeyOrder("", value.Index(index))); err != nil {
				return err
			}
		}
		output.WriteByte(']')
		return nil
	default:
		return appendStandardJSON(output, value.Interface())
	}
}

func appendStandardJSON(output *bytes.Buffer, value any) error {
	var encoded bytes.Buffer
	encoder := json.NewEncoder(&encoded)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return err
	}
	output.Write(bytes.TrimSuffix(encoded.Bytes(), []byte{'\n'}))
	return nil
}

func orderJSONKeys(keys, preferred []string) []string {
	remaining := make(map[string]bool, len(keys))
	for _, key := range keys {
		remaining[key] = true
	}
	ordered := make([]string, 0, len(keys))
	for _, key := range preferred {
		if remaining[key] {
			ordered = append(ordered, key)
			delete(remaining, key)
		}
	}
	keys = keys[:0]
	for key := range remaining {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return append(ordered, keys...)
}

func eventKeyOrder(eventType string) []string {
	prefix := []string{"type", "sequence_number"}
	switch eventType {
	case "response.created", "response.completed", "response.failed", "response.incomplete":
		return append(prefix, "response")
	case "response.output_item.added", "response.output_item.done":
		return append(prefix, "output_index", "item")
	case "response.content_part.added", "response.content_part.done":
		return append(prefix, "item_id", "output_index", "content_index", "part")
	case "response.output_text.delta":
		return append(prefix, "item_id", "output_index", "content_index", "delta")
	case "response.output_text.done", "response.reasoning_text.done":
		return append(prefix, "item_id", "output_index", "content_index", "text")
	case "response.reasoning_summary_part.added", "response.reasoning_summary_part.done":
		return append(prefix, "item_id", "output_index", "summary_index", "part")
	case "response.reasoning_summary_text.delta":
		return append(prefix, "item_id", "output_index", "summary_index", "delta")
	case "response.reasoning_summary_text.done":
		return append(prefix, "item_id", "output_index", "summary_index", "text")
	case "response.reasoning_text.delta":
		return append(prefix, "item_id", "output_index", "content_index", "delta")
	case "response.function_call_arguments.delta", "response.custom_tool_call_input.delta":
		return append(prefix, "item_id", "output_index", "delta")
	case "response.function_call_arguments.done":
		return append(prefix, "item_id", "output_index", "arguments")
	case "response.custom_tool_call_input.done":
		return append(prefix, "item_id", "output_index", "input")
	default:
		return prefix
	}
}

func nestedKeyOrder(parent string, value reflect.Value) []string {
	if parent == "response" {
		return []string{"id", "object", "created_at", "status", "model", "output", "usage", "end_turn", "error", "last_error", "retryable", "incomplete_details"}
	}
	if parent == "usage" {
		return []string{"input_tokens", "output_tokens", "total_tokens", "input_tokens_details", "output_tokens_details"}
	}
	if parent == "input_tokens_details" {
		return []string{"cached_tokens", "cache_write_tokens"}
	}
	if parent == "output_tokens_details" {
		return []string{"reasoning_tokens"}
	}
	if parent == "error" || parent == "last_error" {
		return []string{"message", "type", "code"}
	}
	if parent == "incomplete_details" {
		return []string{"reason", "message", "retryable"}
	}
	if parent == "part" {
		return []string{"type", "text", "annotations"}
	}
	if parent == "item" || parent == "" || parent == "output" || parent == "content" || parent == "summary" {
		switch jsonObjectType(value) {
		case "function_call":
			return []string{"type", "id", "call_id", "name", "arguments", "status", "namespace"}
		case "message":
			return []string{"type", "id", "status", "role", "content", "phase"}
		case "reasoning":
			return []string{"type", "id", "summary", "content", "encrypted_content"}
		}
		return []string{"type", "id", "status", "role", "content", "phase", "summary", "encrypted_content", "call_id", "execution", "name", "arguments", "input", "namespace", "action", "sources", "text", "annotations"}
	}
	return nil
}

func jsonObjectType(value reflect.Value) string {
	for value.IsValid() && (value.Kind() == reflect.Interface || value.Kind() == reflect.Pointer) {
		if value.IsNil() {
			return ""
		}
		value = value.Elem()
	}
	if !value.IsValid() || value.Kind() != reflect.Map || value.Type().Key().Kind() != reflect.String {
		return ""
	}
	typeValue := value.MapIndex(reflect.ValueOf("type").Convert(value.Type().Key()))
	for typeValue.IsValid() && (typeValue.Kind() == reflect.Interface || typeValue.Kind() == reflect.Pointer) {
		if typeValue.IsNil() {
			return ""
		}
		typeValue = typeValue.Elem()
	}
	if typeValue.IsValid() && typeValue.Kind() == reflect.String {
		return typeValue.String()
	}
	return ""
}

func usage(value *types.Usage) map[string]any {
	if value == nil {
		return map[string]any{
			"input_tokens":          0,
			"output_tokens":         0,
			"total_tokens":          0,
			"input_tokens_details":  map[string]any{"cached_tokens": 0},
			"output_tokens_details": map[string]any{"reasoning_tokens": 0},
		}
	}
	input := value.InputTokens
	total := value.TotalTokens
	if value.ContextTotalTokens != 0 {
		input = max(0, value.ContextTotalTokens-value.OutputTokens)
		total = value.ContextTotalTokens
	} else if base := input + value.OutputTokens; total < base {
		total = base
	}
	cached := min(value.CachedInputTokens, input)
	inputDetails := map[string]any{"cached_tokens": cached}
	if value.CacheCreationInputTokens != 0 {
		inputDetails["cache_write_tokens"] = min(value.CacheCreationInputTokens, max(0, input-cached))
	}
	return map[string]any{
		"input_tokens":          input,
		"output_tokens":         value.OutputTokens,
		"total_tokens":          total,
		"input_tokens_details":  inputDetails,
		"output_tokens_details": map[string]any{"reasoning_tokens": value.ReasoningOutputTokens},
	}
}

func cloneUsage(value *types.Usage) *types.Usage {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}
