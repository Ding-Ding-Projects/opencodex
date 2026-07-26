package lib

import (
	"strings"
	"testing"
)

func stringPointer(value string) *string { return &value }

func TestAdapterFailureFromMessageParity(t *testing.T) {
	tests := []struct {
		message   string
		status    int
		errorType string
		code      string
		retryHint bool
	}{
		{"client closed request during web-search", 499, "invalid_request_error", "client_closed_request", false},
		{"resource exhausted; retry after 12.2s", 429, "rate_limit_error", "rate_limit_exceeded", true},
		{"AccessDeniedException: security token expired", 401, "authentication_error", "invalid_api_key", false},
		{"Access denied", 403, "permission_error", "permission_denied", false},
		{"server is busy", 503, "server_error", "server_is_overloaded", false},
	}
	for _, test := range tests {
		got := AdapterFailureFromMessage(test.message)
		if got.HTTPStatus != test.status || got.Error.Type != test.errorType || got.Error.Code == nil || *got.Error.Code != test.code {
			t.Errorf("failure(%q)=%+v", test.message, got)
		}
		if strings.Contains(got.Error.Message, "Please try again in 13s.") != test.retryHint {
			t.Errorf("retry hint(%q)=%q", test.message, got.Error.Message)
		}
	}
}

func TestHTTPStatusFromTerminalErrorParity(t *testing.T) {
	tests := []struct {
		terminal *TerminalError
		want     int
	}{
		{nil, 502},
		{&TerminalError{Type: "invalid_request_error", Code: stringPointer("client_cancelled")}, 499},
		{&TerminalError{Type: "insufficient_quota"}, 429},
		{&TerminalError{Type: "server_error", Code: stringPointer("server_is_overloaded")}, 503},
		{&TerminalError{Type: "invalid_request_error", Message: "client closed request"}, 499},
		{&TerminalError{Message: "deadline exceeded"}, 504},
	}
	for _, test := range tests {
		if got := HTTPStatusFromTerminalError(test.terminal); got != test.want {
			t.Errorf("status(%+v)=%d want=%d", test.terminal, got, test.want)
		}
	}
}

func TestRateLimitOrQuotaFailureMessageParity(t *testing.T) {
	for _, value := range []string{"429", "402", "402.0", "monthly quota exceeded", "usage limit reached"} {
		if !IsRateLimitOrQuotaFailureMessage(value) {
			t.Errorf("expected quota failure for %q", value)
		}
	}
	for _, value := range []string{"", "Access denied", "invalid model"} {
		if IsRateLimitOrQuotaFailureMessage(value) {
			t.Errorf("unexpected quota failure for %q", value)
		}
	}
}

func TestClassifyErrorKeepsExplicitServerStatusAuthoritative(t *testing.T) {
	got := ClassifyError(500, "invalid_request_error", "upstream failed")
	if got.Type != "server_error" || got.Code == nil || *got.Code != "upstream_server_error" {
		t.Fatalf("mixed 500 classification=%+v", got)
	}
}

func TestClassifyErrorPreservesMidStreamUpstreamCode(t *testing.T) {
	got := ClassifyError(502, UpstreamStreamErrorType, "synthetic mid-stream failure")
	if got.Type != "server_error" || got.Code == nil || *got.Code != "upstream_error" {
		t.Fatalf("mid-stream classification=%+v", got)
	}
}
