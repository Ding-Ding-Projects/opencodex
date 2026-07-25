package server

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestResponseToWebSocketFramesSplitsSSEAndStopsAtTerminal(t *testing.T) {
	body := strings.Join([]string{
		`event: response.created`, `data: {"type":"response.created","response":{"status":"in_progress"}}`, "",
		`event: response.output_text.delta`, `data: {"type":"response.output_text.delta","delta":"hello"}`, "",
		`event: response.completed`, `data: {"type":"response.completed","response":{"status":"completed"}}`, "",
		`data: [DONE]`, "", `data: {"type":"response.output_text.delta","delta":"late"}`, "",
	}, "\n")
	frames := ResponseToWebSocketFrames(http.StatusOK, http.Header{"Content-Type": {"text/event-stream"}}, []byte(body))
	if len(frames) != 3 {
		t.Fatalf("frames = %q", frames)
	}
	if !strings.Contains(string(frames[1]), `"delta":"hello"`) || strings.Contains(string(frames[2]), "late") {
		t.Fatalf("frames = %q", frames)
	}
}

func TestResponseToWebSocketFramesExpandsBufferedJSON(t *testing.T) {
	body := []byte(`{"id":"resp_1","status":"completed","output":[{"type":"message","id":"msg_1"}]}`)
	frames := ResponseToWebSocketFrames(http.StatusOK, http.Header{"Content-Type": {"application/json"}}, body)
	if len(frames) != 3 {
		t.Fatalf("frames = %q", frames)
	}
	for index, want := range []string{"response.created", "response.output_item.done", "response.completed"} {
		var frame map[string]any
		if err := json.Unmarshal(frames[index], &frame); err != nil || frame["type"] != want {
			t.Fatalf("frame[%d] = %#v, err=%v", index, frame, err)
		}
	}
}

func TestResponseToWebSocketFramesReportsPrematureEOF(t *testing.T) {
	body := []byte("data: {\"type\":\"response.created\"}\n\n")
	frames := ResponseToWebSocketFrames(http.StatusOK, nil, body)
	if len(frames) != 2 || !strings.Contains(string(frames[1]), "websocket_protocol_error") {
		t.Fatalf("frames = %q", frames)
	}
}

func TestSafeWebSocketResponseHeadersDropsCredentials(t *testing.T) {
	headers := http.Header{
		"Retry-After":              {"5"},
		"X-RateLimit-Remaining":    {"10"},
		"X-Codex-Primary-Reset-At": {"123"},
		"Set-Cookie":               {"secret=1"},
		"Authorization":            {"Bearer secret"},
	}
	safe := SafeWebSocketResponseHeaders(headers)
	if safe["retry-after"] != "5" || safe["x-ratelimit-remaining"] != "10" || safe["x-codex-primary-reset-at"] != "123" {
		t.Fatalf("safe headers = %#v", safe)
	}
	if _, ok := safe["set-cookie"]; ok {
		t.Fatalf("unsafe headers leaked: %#v", safe)
	}
}

func TestBuildWarmupCompletionFrames(t *testing.T) {
	frames := BuildWarmupCompletionFrames(map[string]any{"model": "gpt-test", "generate": false})
	if len(frames) != 2 || !strings.Contains(string(frames[0]), "response.created") || !strings.Contains(string(frames[1]), "response.completed") {
		t.Fatalf("warmup frames = %q", frames)
	}
}
