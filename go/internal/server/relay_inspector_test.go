package server

import (
	"net/http"
	"strings"
	"testing"
)

func TestSSEInspectorHandlesChunkBoundariesAndMetadata(t *testing.T) {
	var first, terminal, completed int
	inspector := NewSSEInspector(SSEInspectorHandlers{
		OnFirstOutput: func() { first++ },
		OnTerminal: func(status ResponsesTerminalStatus, httpStatus int) {
			terminal++
			if status != ResponsesCompleted || httpStatus != http.StatusOK {
				t.Errorf("terminal = %s %d", status, httpStatus)
			}
		},
		OnCompletedResponse: func(map[string]any) { completed++ },
	})
	stream := `event: response.output_text.delta
data: {"type":"response.output_text.delta","delta":"hello"}

event: response.completed
data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}

data: [DONE]

`
	for _, chunk := range []string{stream[:17], stream[17:83], stream[83:151], stream[151:]} {
		inspector.Consume([]byte(chunk))
	}
	inspector.Finish()
	if first != 1 || terminal != 1 || completed != 1 || !inspector.TerminalSeen() {
		t.Fatalf("callbacks first=%d terminal=%d completed=%d", first, terminal, completed)
	}
	if usage := inspector.Usage(); usage == nil || usage.InputTokens != 3 || usage.TotalTokens != 5 {
		t.Fatalf("usage = %#v", usage)
	}
	if response := inspector.CompletedResponse(); response["id"] != "resp_1" {
		t.Fatalf("completed response = %#v", response)
	}
}

func TestSSEInspectorDoesNotTreatQuotedTerminalTextAsTerminal(t *testing.T) {
	inspector := NewSSEInspector(SSEInspectorHandlers{})
	inspector.Consume([]byte("data: {\"type\":\"response.output_text.delta\",\"delta\":\"\\\"type\\\":\\\"response.completed\\\"\"}\n\n"))
	inspector.Finish()
	if inspector.TerminalSeen() {
		t.Fatal("quoted output text was mistaken for a terminal event")
	}
}

func TestSSEInspectorDerivesFailedHTTPStatus(t *testing.T) {
	inspector := NewSSEInspector(SSEInspectorHandlers{})
	inspector.Consume([]byte("data: {\"type\":\"response.failed\",\"response\":{\"status\":\"failed\",\"error\":{\"status_code\":429}}}\n\n"))
	if inspector.TerminalStatus() != ResponsesFailed || inspector.TerminalHTTPStatus() != http.StatusTooManyRequests {
		t.Fatalf("terminal = %s %d", inspector.TerminalStatus(), inspector.TerminalHTTPStatus())
	}
}

func TestSanitizePassthroughHeaders(t *testing.T) {
	headers := http.Header{"Content-Type": {"text/event-stream"}, "Content-Length": {"99"}, "Connection": {"keep-alive"}, "X-Request-Id": {"req"}}
	safe := SanitizePassthroughHeaders(headers)
	if safe.Get("Content-Type") != "text/event-stream" || safe.Get("X-Request-Id") != "req" {
		t.Fatalf("safe headers = %#v", safe)
	}
	if safe.Get("Content-Length") != "" || safe.Get("Connection") != "" {
		t.Fatalf("hop headers retained = %#v", safe)
	}
	if !strings.EqualFold(headers.Get("Connection"), "keep-alive") {
		t.Fatal("input headers were mutated")
	}
}
