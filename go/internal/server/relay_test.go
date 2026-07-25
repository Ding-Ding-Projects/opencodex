package server

import (
	"context"
	"io"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestRelaySSEMarksPrematureEOFIncomplete(t *testing.T) {
	response := httptest.NewRecorder()
	err := RelaySSE(context.Background(), response, io.NopCloser(strings.NewReader("event: response.output_text.delta\ndata: {\"delta\":\"hi\"}\n\n")), RelayOptions{Heartbeat: time.Hour})
	if err != nil || !strings.Contains(response.Body.String(), "event: response.incomplete") || !strings.Contains(response.Body.String(), "data: [DONE]") {
		t.Fatalf("relay error=%v body=%s", err, response.Body.String())
	}
}

func TestRelaySSEDoesNotDuplicateTerminal(t *testing.T) {
	response := httptest.NewRecorder()
	input := "event: response.completed\ndata: {\"type\":\"response.completed\"}\n\ndata: [DONE]\n\n"
	if err := RelaySSE(context.Background(), response, io.NopCloser(strings.NewReader(input)), RelayOptions{Heartbeat: time.Hour}); err != nil {
		t.Fatal(err)
	}
	if strings.Count(response.Body.String(), "response.completed") != 2 || strings.Contains(response.Body.String(), "response.incomplete") {
		t.Fatalf("body=%s", response.Body.String())
	}
}
