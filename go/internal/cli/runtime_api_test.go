package cli

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/lidge-jun/opencodex-go/internal/config"
)

// noConfig keeps a test off the real config file on this machine.
func noConfig() func() (*config.Config, error) {
	return func() (*config.Config, error) { return &config.Config{}, nil }
}

// A management failure must surface the API's own words, not a generic status
// line, or the user has to go read logs to learn what went wrong.
func TestRuntimeRequestSurfacesServerMessage(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":"boom"}`))
	}))
	defer server.Close()

	api := &runtimeAPI{BaseURL: server.URL, loadCfg: noConfig()}
	_, err := api.request(context.Background(), http.MethodGet, "/api/combos", nil)
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

// The proxy answers /api/* with 401 unless the admission credential is present,
// so a client that forgets it makes every ported command fail against a
// protected proxy.
func TestRuntimeRequestSendsManagementCredential(t *testing.T) {
	var gotKey, gotContentType string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotKey = r.Header.Get("X-OpenCodex-API-Key")
		gotContentType = r.Header.Get("Content-Type")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	api := &runtimeAPI{
		BaseURL: server.URL,
		loadCfg: func() (*config.Config, error) { return &config.Config{AuthToken: "config-token"}, nil },
	}
	if _, err := api.request(context.Background(), http.MethodPut, "/api/combos", map[string]any{"id": "x"}); err != nil {
		t.Fatal(err)
	}
	if gotKey != "config-token" {
		t.Fatalf("X-OpenCodex-API-Key = %q, want the configured token", gotKey)
	}
	if gotContentType != "application/json" {
		t.Fatalf("Content-Type = %q", gotContentType)
	}
}

// The environment token wins over the configured one, matching the doctor path
// and the oracle's runningProxyUpdateHeaders.
func TestRuntimeRequestPrefersEnvironmentToken(t *testing.T) {
	t.Setenv("OPENCODEX_API_AUTH_TOKEN", "env-token")
	var gotKey string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotKey = r.Header.Get("X-OpenCodex-API-Key")
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()

	api := &runtimeAPI{
		BaseURL: server.URL,
		loadCfg: func() (*config.Config, error) { return &config.Config{AuthToken: "config-token"}, nil },
	}
	if _, err := api.request(context.Background(), http.MethodGet, "/api/combos", nil); err != nil {
		t.Fatal(err)
	}
	if gotKey != "env-token" {
		t.Fatalf("X-OpenCodex-API-Key = %q, want the environment token", gotKey)
	}
}

// A caller-supplied header overrides the default rather than being dropped.
func TestRuntimeRequestMergesCallerHeadersOverDefaults(t *testing.T) {
	var gotContentType, gotKey string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotContentType = r.Header.Get("Content-Type")
		gotKey = r.Header.Get("X-OpenCodex-API-Key")
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()

	api := &runtimeAPI{
		BaseURL: server.URL,
		Headers: map[string]string{"Content-Type": "text/plain"},
		loadCfg: func() (*config.Config, error) { return &config.Config{AuthToken: "t"}, nil },
	}
	if _, err := api.request(context.Background(), http.MethodGet, "/api/combos", nil); err != nil {
		t.Fatal(err)
	}
	if gotContentType != "text/plain" {
		t.Fatalf("Content-Type = %q, want the caller override", gotContentType)
	}
	if gotKey != "t" {
		t.Fatal("overriding one header must not drop the management credential")
	}
}

// Without an explicit BaseURL the client must locate the running proxy itself,
// or every command has to reimplement discovery.
func TestRuntimeBaseURLUsesProxyDiscovery(t *testing.T) {
	api := &runtimeAPI{
		loadCfg: noConfig(),
		findProxy: func(context.Context, *config.Config) (string, int, bool) {
			return "127.0.0.1", 10100, true
		},
	}
	got, err := api.runtimeBaseURL(context.Background(), &config.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if got != "http://127.0.0.1:10100" {
		t.Fatalf("base URL = %q", got)
	}
}

// Without a live proxy the user needs the command that fixes it, not a stack.
func TestRuntimeBaseURLWithoutLiveProxy(t *testing.T) {
	api := &runtimeAPI{
		loadCfg:   noConfig(),
		findProxy: func(context.Context, *config.Config) (string, int, bool) { return "", 0, false },
	}
	_, err := api.runtimeBaseURL(context.Background(), &config.Config{})
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

// The oracle caps with String.slice, which counts UTF-16 units. A byte-based
// cut would truncate non-ASCII text far earlier and could split a rune.
func TestResponseMessageTruncatesLikeJavaScript(t *testing.T) {
	got := responseMessage(strings.Repeat("x", 900), 500)
	if len(got) != 400 {
		t.Fatalf("ascii len = %d, want 400", len(got))
	}

	got = responseMessage(strings.Repeat("가", 900), 500)
	if units := len(utf16.Encode([]rune(got))); units != 400 {
		t.Fatalf("utf16 units = %d, want 400", units)
	}
	for _, r := range got {
		if r == '\uFFFD' {
			t.Fatal("truncation split a rune into invalid UTF-8")
		}
	}
}

// A body that is not JSON must still reach the caller instead of being dropped.
func TestRuntimeRequestKeepsNonJSONBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("not json"))
	}))
	defer server.Close()

	api := &runtimeAPI{BaseURL: server.URL, loadCfg: noConfig()}
	result, err := api.request(context.Background(), http.MethodGet, "api/logs", nil)
	if err != nil {
		t.Fatal(err)
	}
	if result != "not json" {
		t.Fatalf("result = %#v, want the raw text", result)
	}
}

// Whitespace is content: JSON.parse(" ") throws, so the oracle keeps " ".
// Only a genuinely empty body decodes to nil.
func TestDecodeBodyDistinguishesEmptyFromWhitespace(t *testing.T) {
	if got := decodeBody(nil); got != nil {
		t.Fatalf("empty body = %#v, want nil", got)
	}
	if got := decodeBody([]byte(" ")); got != " " {
		t.Fatalf("whitespace body = %#v, want a preserved string", got)
	}
	if got := decodeBody([]byte(`{"a":1}`)); got == nil {
		t.Fatal("valid JSON should decode")
	}
}

// loadConfig falls through to BackupInvalidConfig, which WRITES a backup file
// when the config fails to parse. Re-reading per request would litter backups
// and repeat the warning for a command that issues several calls.
func TestConfigurationIsResolvedOncePerClient(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()

	loads := 0
	api := &runtimeAPI{
		BaseURL: server.URL,
		loadCfg: func() (*config.Config, error) {
			loads++
			return &config.Config{AuthToken: "t"}, nil
		},
	}
	for range 3 {
		if _, err := api.request(context.Background(), http.MethodGet, "/api/combos", nil); err != nil {
			t.Fatal(err)
		}
	}
	if loads != 1 {
		t.Fatalf("config was loaded %d times, want exactly 1", loads)
	}
}

// Slicing exactly at the limit can land between the halves of a surrogate
// pair. JavaScript keeps the lone high surrogate; Go cannot carry one, and a
// naive utf16.Decode would substitute U+FFFD, inventing content the server
// never sent. The cut is pulled back to a whole rune instead.
func TestTruncateStopsAtASurrogateBoundaryWithoutSubstituting(t *testing.T) {
	value := strings.Repeat("x", 399) + "\U0001F600"
	got := truncateLikeJS(value, 400)

	if strings.ContainsRune(got, '\uFFFD') {
		t.Fatal("truncation substituted a replacement character")
	}
	if !utf8.ValidString(got) {
		t.Fatal("truncation produced invalid UTF-8")
	}
	if got != strings.Repeat("x", 399) {
		t.Fatalf("got %q, want the text without the split emoji", got)
	}

	// A pair that fits whole is preserved untouched.
	whole := strings.Repeat("x", 398) + "\U0001F600"
	if truncateLikeJS(whole, 400) != whole {
		t.Fatal("a surrogate pair inside the limit must survive")
	}
}

// The service token file is how a managed service actually carries its
// credential; reading only the config would 401 against exactly the deployment
// most likely to be running.
func TestManagementTokenPrefersResolvedServiceCredential(t *testing.T) {
	api := &runtimeAPI{loadToken: func(*config.Config) string { return "file-token" }}
	if got := api.managementToken(&config.Config{AuthToken: "config-token"}); got != "file-token" {
		t.Fatalf("token = %q, want the service token", got)
	}
}

// The server dereferences a `$NAME` config value before comparing, so a client
// that sends the literal reference is rejected.
func TestManagementTokenResolvesEnvironmentReference(t *testing.T) {
	t.Setenv("OPENCODEX_TEST_TOKEN_REF", "dereferenced")
	if got := resolveTokenReference("$OPENCODEX_TEST_TOKEN_REF"); got != "dereferenced" {
		t.Fatalf("resolveTokenReference = %q", got)
	}
	if got := resolveTokenReference("literal"); got != "literal" {
		t.Fatalf("a plain value must pass through, got %q", got)
	}
}

// http.Header matching is case-insensitive, so a caller override must replace
// the default rather than racing it through random map iteration.
func TestCallerHeaderOverrideIsCaseInsensitive(t *testing.T) {
	var gotContentType string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotContentType = r.Header.Get("Content-Type")
		if values := r.Header.Values("Content-Type"); len(values) != 1 {
			t.Errorf("Content-Type sent %d times, want exactly 1: %v", len(values), values)
		}
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()

	api := &runtimeAPI{
		BaseURL:   server.URL,
		Headers:   map[string]string{"content-type": "text/plain"},
		loadCfg:   noConfig(),
		loadToken: func(*config.Config) string { return "" },
	}
	if _, err := api.request(context.Background(), http.MethodGet, "/api/combos", nil); err != nil {
		t.Fatal(err)
	}
	if gotContentType != "text/plain" {
		t.Fatalf("Content-Type = %q, want the lowercase override to win", gotContentType)
	}
}
