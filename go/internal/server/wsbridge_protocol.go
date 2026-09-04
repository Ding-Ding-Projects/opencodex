package server

import (
	"bufio"
	"bytes"
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
	"time"
)

var websocketForwardHeaders = []string{
	"Authorization", "X-Api-Key", "X-OpenCodex-API-Key", "ChatGPT-Account-Id",
	"OpenAI-Alpha", "X-Codex-Turn-Metadata", "X-OpenAI-Subagent",
	"X-Codex-Parent-Thread-Id", "Thread-Id", "Session-Id", "X-Request-Id",
}

var safeCodexQuotaHeader = regexp.MustCompile(`^x-codex(?:-[a-z0-9-]+)?-(?:(?:primary|secondary|tertiary)-(?:used-percent|window-minutes|reset-at)|limit-name)$`)
var generatedResponseID = regexp.MustCompile(`"id":"resp_[0-9a-f]{32}"`)

var safeWebSocketResponseHeaders = map[string]struct{}{
	"retry-after": {}, "x-request-id": {}, "openai-request-id": {},
	"x-codex-turn-state": {}, "openai-model": {}, "x-models-etag": {},
	"x-reasoning-included": {},
}

// SafeWebSocketResponseHeaders keeps operational metadata while preventing
// provider cookies, credentials, and arbitrary upstream headers from crossing
// the WebSocket trust boundary.
func SafeWebSocketResponseHeaders(headers http.Header) map[string]string {
	out := make(map[string]string)
	for name, values := range headers {
		lower := strings.ToLower(name)
		_, exact := safeWebSocketResponseHeaders[lower]
		if !exact && !strings.HasPrefix(lower, "x-ratelimit-") && !safeCodexQuotaHeader.MatchString(lower) {
			continue
		}
		out[lower] = strings.Join(values, ", ")
	}
	return out
}

func BuildWarmupCompletionFrames(frame map[string]any) [][]byte {
	type warmupResponse struct {
		ID        string `json:"id"`
		Object    string `json:"object"`
		CreatedAt int64  `json:"created_at"`
		Model     any    `json:"model,omitempty"`
		Output    []any  `json:"output"`
		Status    string `json:"status"`
	}
	type warmupEvent struct {
		Type           string         `json:"type"`
		SequenceNumber int            `json:"sequence_number"`
		Response       warmupResponse `json:"response"`
	}
	base := warmupResponse{ID: "", Object: "response", CreatedAt: time.Now().Unix(), Model: frame["model"], Output: []any{}}
	created := warmupEvent{Type: "response.created", SequenceNumber: 0, Response: base}
	created.Response.Status = "in_progress"
	completed := warmupEvent{Type: "response.completed", SequenceNumber: 1, Response: base}
	completed.Response.Status = "completed"
	return [][]byte{mustJSONBytes(created), mustJSONBytes(completed)}
}

// ResponseToWebSocketFrames converts an HTTP Responses result into the native
// Responses WebSocket event contract. SSE payloads remain byte-equivalent JSON
// events, while buffered JSON is expanded into created/item/terminal frames.
func ResponseToWebSocketFrames(status int, headers http.Header, body []byte) [][]byte {
	if status == 0 {
		status = http.StatusOK
	}
	if status < 200 || status >= 300 {
		return [][]byte{mustJSONBytes(websocketErrorFrame(status, errorPayload(body), headers))}
	}
	contentType := strings.ToLower(headers.Get("Content-Type"))
	if strings.Contains(contentType, "text/event-stream") || LooksLikeSSE(body) {
		return sseWebSocketFrames(body)
	}
	var response map[string]any
	if json.Unmarshal(body, &response) != nil {
		return [][]byte{mustJSONBytes(websocketProtocolError(http.StatusBadGateway, "Unexpected successful non-JSON response", headers))}
	}
	response["id"] = ""
	return responseJSONWebSocketFrames(response)
}

func responseJSONWebSocketFrames(response map[string]any) [][]byte {
	frames := [][]byte{mustJSONBytes(map[string]any{"type": "response.created", "response": cloneResponseWithStatusAndOutput(response, "in_progress", []any{})})}
	output, _ := response["output"].([]any)
	for index, item := range output {
		frames = append(frames, mustJSONBytes(map[string]any{"type": "response.output_item.done", "output_index": index, "item": item}))
	}
	status, _ := response["status"].(string)
	if status != "failed" && status != "incomplete" {
		status = "completed"
	}
	frames = append(frames, mustJSONBytes(map[string]any{"type": "response." + status, "response": cloneResponseWithStatus(response, status)}))
	return frames
}

func sseWebSocketFrames(body []byte) [][]byte {
	payloads := ParseSSEDataPayloads(body)
	frames := make([][]byte, 0, len(payloads)+1)
	terminal := false
	for _, payload := range payloads {
		if payload == "[DONE]" {
			continue
		}
		var event struct {
			Type string `json:"type"`
		}
		if json.Unmarshal([]byte(payload), &event) != nil || event.Type == "" {
			frames = append(frames, mustJSONBytes(websocketProtocolError(http.StatusBadGateway, "Invalid JSON payload in upstream SSE frame", nil)))
			return frames
		}
		if terminal {
			continue
		}
		frames = append(frames, emptyGeneratedResponseID([]byte(payload)))
		terminal = event.Type == "response.completed" || event.Type == "response.failed" || event.Type == "response.incomplete"
	}
	if !terminal {
		frames = append(frames, mustJSONBytes(websocketProtocolError(http.StatusBadGateway, "Upstream stream ended before response terminal event", nil)))
	}
	return frames
}

func emptyGeneratedResponseID(payload []byte) []byte {
	return generatedResponseID.ReplaceAll(payload, []byte(`"id":""`))
}

func ParseSSEDataPayloads(body []byte) []string {
	scanner := bufio.NewScanner(bytes.NewReader(body))
	scanner.Buffer(make([]byte, 64<<10), 16<<20)
	var payloads []string
	var data []string
	flush := func() {
		if len(data) > 0 {
			payloads = append(payloads, strings.Join(data, "\n"))
			data = data[:0]
		}
	}
	for scanner.Scan() {
		line := strings.TrimSuffix(scanner.Text(), "\r")
		if line == "" {
			flush()
			continue
		}
		if strings.HasPrefix(line, "data:") {
			data = append(data, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		}
	}
	flush()
	return payloads
}

func LooksLikeSSE(prefix []byte) bool {
	trimmed := strings.TrimSpace(string(prefix))
	return strings.HasPrefix(trimmed, "event:") || strings.HasPrefix(trimmed, "data:")
}

func websocketErrorFrame(status int, errorValue map[string]any, headers http.Header) map[string]any {
	return map[string]any{"type": "error", "status": status, "error": errorValue, "headers": SafeWebSocketResponseHeaders(headers)}
}

func websocketProtocolError(status int, message string, headers http.Header) map[string]any {
	return websocketErrorFrame(status, map[string]any{"type": "protocol_error", "code": "websocket_protocol_error", "message": message}, headers)
}

func errorPayload(body []byte) map[string]any {
	var envelope struct {
		Error map[string]any `json:"error"`
	}
	if json.Unmarshal(body, &envelope) == nil && envelope.Error != nil {
		return envelope.Error
	}
	message := strings.TrimSpace(string(body))
	if len(message) > 500 {
		message = message[:500]
	}
	if message == "" {
		message = "Upstream request failed"
	}
	return map[string]any{"type": "upstream_error", "message": message}
}

func cloneResponseWithStatus(response map[string]any, status string) map[string]any {
	return cloneResponseWithStatusAndOutput(response, status, nil)
}

func cloneResponseWithStatusAndOutput(response map[string]any, status string, output []any) map[string]any {
	clone := make(map[string]any, len(response)+1)
	for key, value := range response {
		clone[key] = value
	}
	clone["status"] = status
	if output != nil {
		clone["output"] = output
	}
	return clone
}

func mustJSONBytes(value any) []byte {
	payload, _ := json.Marshal(value)
	return payload
}
