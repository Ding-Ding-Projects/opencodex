package server

import (
	"context"
	"io"
	"net/http/httptest"
	"strings"
	"syscall"
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

func TestClassifyRelayRetryHonorsCommitAndReplayBoundaries(t *testing.T) {
	tests := []struct {
		name       string
		status     int
		err        error
		committed  bool
		replayable bool
		elapsed    time.Duration
		want       RelayRetryClass
	}{
		{name: "transient headers", status: 502, replayable: true, want: RelayRetryTransientHTTP},
		{name: "cloudflare transient", status: 520, replayable: true, want: RelayRetryTransientHTTP},
		{name: "reset before headers", err: syscall.ECONNRESET, replayable: true, want: RelayRetryConnectionReset},
		{name: "committed reset", err: syscall.ECONNRESET, committed: true, replayable: true, want: RelayRetryNone},
		{name: "non replayable", status: 503, replayable: false, want: RelayRetryNone},
		{name: "client cancel", err: context.Canceled, replayable: true, want: RelayRetryNone},
		{name: "rate limit needs key policy", status: 429, replayable: true, want: RelayRetryNone},
		{name: "slow transient", status: 502, replayable: true, elapsed: 16 * time.Second, want: RelayRetryNone},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := ClassifyRelayRetry(test.status, test.err, test.committed, test.replayable, test.elapsed); got != test.want {
				t.Fatalf("class = %q, want %q", got, test.want)
			}
		})
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
