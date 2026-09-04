package chat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/claude"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

type incompleteError struct {
	status  int
	message string
}

func (e incompleteError) Error() string { return e.message }

func buildAnthropicMessage(events []types.AdapterEvent, model string) (map[string]any, error) {
	done := false
	for _, event := range events {
		switch event.Type {
		case types.EventError:
			status := event.StatusCode
			if status == 0 {
				status = http.StatusBadGateway
			}
			return nil, statusError{status: status, message: firstNonEmpty(event.Error, "upstream request failed")}
		case types.EventDone:
			done = true
		case types.EventIncomplete:
			switch event.Reason {
			case "max_output_tokens":
				done = true
			case "content_filter":
				done = true
			default:
				message := firstNonEmpty(event.Message, fmt.Sprintf("upstream response was incomplete (%s)", event.Reason))
				return nil, incompleteError{status: 529, message: message}
			}
		}
	}
	if !done {
		return nil, statusError{status: http.StatusBadGateway, message: "adapter stream ended without a terminal event"}
	}
	_, canonical := claude.ConvertEvents(model, events)
	content := make([]any, len(canonical.Content))
	for index := range canonical.Content {
		content[index] = canonical.Content[index]
	}
	return map[string]any{
		"id": canonical.ID, "type": canonical.Type, "role": canonical.Role,
		"content": content, "model": canonical.Model, "stop_reason": canonical.StopReason,
		"stop_sequence": canonical.StopSequence, "usage": canonical.Usage,
	}, nil
}

func writeAnthropicStream(ctx context.Context, w http.ResponseWriter, model string, events <-chan types.AdapterEvent) error {
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)
	return claude.StreamEvents(ctx, anthropicStreamWriter{ResponseWriter: w}, model, normalizeAnthropicStreamEvents(ctx, events))
}

type anthropicStreamWriter struct{ http.ResponseWriter }

func (writer anthropicStreamWriter) Write(frame []byte) (int, error) {
	text := string(frame)
	marker := "\ndata: "
	start := strings.Index(text, marker)
	end := strings.LastIndex(text, "\n\n")
	if start < 0 || end < start {
		_, err := writer.ResponseWriter.Write(frame)
		return len(frame), err
	}
	var data map[string]any
	if json.Unmarshal([]byte(text[start+len(marker):end]), &data) != nil {
		_, err := writer.ResponseWriter.Write(frame)
		return len(frame), err
	}
	if message, ok := data["message"].(map[string]any); ok {
		if id, ok := message["id"].(string); ok && strings.HasPrefix(id, "msg_") && len(id) == len("msg_")+24 {
			message["id"] = id + randomHex(4)
		}
	}
	payload, err := marshalAnthropicJSON(data)
	if err != nil {
		return 0, err
	}
	rewritten := text[:start+len(marker)] + string(payload) + text[end:]
	_, err = writer.ResponseWriter.Write([]byte(rewritten))
	return len(frame), err
}

func (writer anthropicStreamWriter) Flush() {
	if flusher, ok := writer.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

func normalizeAnthropicStreamEvents(ctx context.Context, events <-chan types.AdapterEvent) <-chan types.AdapterEvent {
	out := make(chan types.AdapterEvent)
	go func() {
		defer close(out)
		terminal := false
		for {
			select {
			case <-ctx.Done():
				return
			case event, ok := <-events:
				if !ok {
					if !terminal {
						out <- types.AdapterEvent{Type: types.EventError, StatusCode: 529, Error: "upstream stream ended before a terminal event"}
					}
					return
				}
				if event.Type == types.EventError && (event.StatusCode == 0 || isTransientAnthropicStatus(event.StatusCode)) {
					event.StatusCode = 529
				}
				if event.Type == types.EventIncomplete && event.Reason != "max_output_tokens" && event.Reason != "content_filter" && event.Message == "" {
					event.Message = fmt.Sprintf("upstream response was incomplete (%s)", event.Reason)
				}
				if event.Type == types.EventDone || event.Type == types.EventError || event.Type == types.EventIncomplete {
					terminal = true
				}
				select {
				case <-ctx.Done():
					return
				case out <- event:
				}
				if terminal {
					return
				}
			}
		}
	}()
	return out
}

func isTransientAnthropicStatus(status int) bool {
	switch status {
	case 500, 502, 503, 504, 520, 521, 522:
		return true
	default:
		return false
	}
}
func anthropicUsage(value *types.Usage) map[string]any {
	if value == nil {
		return map[string]any{"input_tokens": 0, "output_tokens": 0, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}
	}
	read, creation := value.CacheReadInputTokens, value.CacheCreationInputTokens
	if read == 0 {
		read = value.CachedInputTokens
	}
	input := value.InputTokens - read - creation
	if input < 0 {
		input = 0
	}
	return map[string]any{"input_tokens": input, "output_tokens": value.OutputTokens, "cache_read_input_tokens": read, "cache_creation_input_tokens": creation}
}
func anthropicStopReason(reason string) string {
	switch reason {
	case "max_output_tokens", "max_tokens", "length":
		return "max_tokens"
	case "content_filter", "refusal":
		return "refusal"
	default:
		return "end_turn"
	}
}
func anthropicErrorType(status int) string {
	switch status {
	case 400:
		return "invalid_request_error"
	case 401:
		return "authentication_error"
	case 402:
		return "billing_error"
	case 403:
		return "permission_error"
	case 404:
		return "not_found_error"
	case 409:
		return "conflict_error"
	case 413:
		return "request_too_large"
	case 429:
		return "rate_limit_error"
	case 504:
		return "timeout_error"
	case 529:
		return "overloaded_error"
	}
	if status >= 500 {
		return "api_error"
	}
	return "invalid_request_error"
}
func anthropicErrorBody(status int, message, override string) map[string]any {
	kind := override
	if kind == "" {
		kind = anthropicErrorType(status)
	}
	return map[string]any{"type": "error", "error": map[string]any{"type": kind, "message": message}}
}
func writeAnthropicError(w http.ResponseWriter, status int, message string) {
	writeAnthropicJSON(w, status, anthropicErrorBody(status, message, ""))
}

func writeAnthropicJSON(w http.ResponseWriter, status int, body any) {
	payload, err := marshalAnthropicJSON(body)
	if err != nil {
		payload = []byte(`{"type":"error","error":{"type":"api_error","message":"JSON serialization failed"}}`)
		status = http.StatusInternalServerError
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(payload)
}
func writeAnthropicErrorFor(w http.ResponseWriter, err error) {
	var incomplete incompleteError
	if errors.As(err, &incomplete) {
		writeAnthropicJSON(w, incomplete.status, anthropicErrorBody(incomplete.status, incomplete.message, "overloaded_error"))
		return
	}
	var typed statusError
	if errors.As(err, &typed) {
		writeAnthropicError(w, typed.status, typed.message)
	} else {
		writeAnthropicError(w, 500, err.Error())
	}
}
