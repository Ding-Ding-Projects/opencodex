package cli

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A management failure must surface the API's own words, not a generic status
// line, or the user has to go read logs to learn what went wrong.
func TestRuntimeRequestSurfacesServerMessage(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":"boom"}`))
	}))
	defer server.Close()

	api := runtimeAPI{BaseURL: server.URL}
	_, err := api.request(context.Background(), nil, http.MethodGet, "/api/combos", nil)
	if err == nil {
		t.Fatal("expected an error for a 400 response")
	}
	runtimeErr, ok := err.(*RuntimeAPIError)
	if !ok {
		t.Fatalf("expected RuntimeAPIError, got %T", err)
	}
	if runtimeErr.Message != "boom" {
		t.Fatalf("message = %q, want %q", runtimeErr.Message, "boom")
	}
	if runtimeErr.Status != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", runtimeErr.Status)
	}
}

// error/message/detail precedence, plus the fallbacks for a non-JSON body.
func TestResponseMessagePrecedence(t *testing.T) {
	for _, testCase := range []struct {
		name   string
		body   any
		status int
		want   string
	}{
		{name: "error wins", body: map[string]any{"error": "e", "message": "m", "detail": "d"}, status: 400, want: "e"},
		{name: "message next", body: map[string]any{"message": "m", "detail": "d"}, status: 400, want: "m"},
		{name: "detail last", body: map[string]any{"detail": "d"}, status: 400, want: "d"},
		{name: "empty string ignored", body: map[string]any{"error": "", "message": "m"}, status: 400, want: "m"},
		{name: "plain text body", body: "  upstream exploded  ", status: 502, want: "upstream exploded"},
		{name: "no usable body", body: nil, status: 503, want: "Management request failed (503)"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			if got := responseMessage(testCase.body, testCase.status); got != testCase.want {
				t.Fatalf("responseMessage = %q, want %q", got, testCase.want)
			}
		})
	}
}

// A long non-JSON body is truncated rather than dumped whole into the terminal.
func TestResponseMessageTruncatesLongText(t *testing.T) {
	got := responseMessage(strings.Repeat("x", 900), 500)
	if len(got) != 400 {
		t.Fatalf("len = %d, want 400", len(got))
	}
}

// Without a live proxy the user needs the command that fixes it, not a stack.
func TestRuntimeBaseURLWithoutLiveProxy(t *testing.T) {
	_, err := runtimeAPI{}.runtimeBaseURL(context.Background(), nil)
	if err == nil {
		t.Fatal("expected an error when no proxy is running")
	}
	runtimeErr, ok := err.(*RuntimeAPIError)
	if !ok {
		t.Fatalf("expected RuntimeAPIError, got %T", err)
	}
	if runtimeErr.Message != "Proxy is not running. Start it with: ocx start" {
		t.Fatalf("message = %q", runtimeErr.Message)
	}
	if runtimeErr.Status != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", runtimeErr.Status)
	}
}

// A body that is not JSON must still reach the caller instead of being dropped.
func TestRuntimeRequestKeepsNonJSONBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("not json"))
	}))
	defer server.Close()

	result, err := runtimeAPI{BaseURL: server.URL}.request(context.Background(), nil, http.MethodGet, "api/logs", nil)
	if err != nil {
		t.Fatal(err)
	}
	if result != "not json" {
		t.Fatalf("result = %#v, want the raw text", result)
	}
}
