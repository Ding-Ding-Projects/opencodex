package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// neverReadyReader blocks forever and counts attempts, so a test can prove a
// code path did not touch stdin rather than merely finishing quickly.
type neverReadyReader struct {
	reads atomic.Int64
}

func (r *neverReadyReader) Read([]byte) (int, error) {
	r.reads.Add(1)
	select {}
}

type recordedRequest struct {
	method string
	path   string
	query  string
	body   map[string]any
}

type authHarness struct {
	requests []recordedRequest
	sleeps   []time.Duration
	stdout   bytes.Buffer
	stderr   bytes.Buffer
}

// runAccountAuth drives one auth subcommand against a stub management server,
// recording every request, every sleep, and both streams.
func runAccountAuth(t *testing.T, respond func(recordedRequest) (int, string), stdin string, args ...string) (*authHarness, error) {
	t.Helper()
	harness := &authHarness{}
	stub := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		raw, _ := io.ReadAll(request.Body)
		body := map[string]any{}
		if len(raw) > 0 {
			_ = json.Unmarshal(raw, &body)
		}
		recorded := recordedRequest{
			method: request.Method,
			path:   request.URL.Path,
			query:  request.URL.RawQuery,
			body:   body,
		}
		harness.requests = append(harness.requests, recorded)
		status, payload := 200, "{}"
		if respond != nil {
			status, payload = respond(recorded)
		}
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(status)
		_, _ = writer.Write([]byte(payload))
	}))
	t.Cleanup(stub.Close)

	api := newRuntimeAPI()
	api.BaseURL = stub.URL
	deps := accountAuthDeps{
		sleep: func(duration time.Duration) { harness.sleeps = append(harness.sleeps, duration) },
		stdin: strings.NewReader(stdin),
	}
	streams := IO{In: strings.NewReader(stdin), Out: &harness.stdout, Err: &harness.stderr}
	err, owned := accountAuthDispatch(context.Background(), api, args[0], args[1:], deps, streams)
	if !owned {
		t.Fatalf("%q is not an auth subcommand", args[0])
	}
	return harness, err
}

func (h *authHarness) pathsHit() []string {
	paths := make([]string, 0, len(h.requests))
	for _, request := range h.requests {
		paths = append(paths, request.path)
	}
	return paths
}

// Flags are parsed BEFORE the positional. Otherwise `--flow` becomes the code
// and `f1` is rejected as an unexpected argument.
func TestAccountCodeParsesFlagsBeforeThePositional(t *testing.T) {
	harness, err := runAccountAuth(t, nil, "secret-code\n", "code", "openai", "--flow", "f1")
	if err != nil {
		t.Fatal(err)
	}
	if len(harness.requests) != 1 || harness.requests[0].path != "/api/codex-auth/login/code" {
		t.Fatalf("requests = %v", harness.pathsHit())
	}
	if harness.requests[0].body["flowId"] != "f1" {
		t.Fatalf("flowId = %#v, want f1", harness.requests[0].body["flowId"])
	}
	if harness.requests[0].body["input"] != "secret-code" {
		t.Fatalf("the code from stdin did not reach the request: %#v", harness.requests[0].body)
	}
}

// An unknown flag is not a credential: the complaint must name the argument
// problem, not how the code was passed.
func TestAccountCodeRejectsAnUnknownFlagAsAnArgument(t *testing.T) {
	harness, err := runAccountAuth(t, nil, "", "code", "openai", "--nope")
	if err == nil {
		t.Fatal("an unknown flag must fail")
	}
	if !strings.Contains(err.Error(), "Unexpected argument") {
		t.Fatalf("error = %q, want an unexpected-argument complaint", err.Error())
	}
	if len(harness.requests) != 0 {
		t.Fatalf("a request was sent anyway: %v", harness.pathsHit())
	}
}

// Both channels at once is ambiguous, and no request may be sent.
func TestAccountCodeRejectsBothChannels(t *testing.T) {
	harness, err := runAccountAuth(t, nil, "", "code", "openai", "--flow", "f1", "--code", "X", "POSITIONAL")
	if err == nil {
		t.Fatal("supplying the code twice must fail")
	}
	if !strings.Contains(err.Error(), "not both") {
		t.Fatalf("error = %q", err.Error())
	}
	if len(harness.requests) != 0 {
		t.Fatalf("a request was sent anyway: %v", harness.pathsHit())
	}
}

// A stray second positional is most likely the code split by an unquoted
// space, so it must be masked rather than echoed to stderr.
func TestAccountCodeRedactsAStraySecondPositional(t *testing.T) {
	_, err := runAccountAuth(t, nil, "", "code", "openai", "--flow", "f1", "first", "SUPERSECRET")
	if err == nil {
		t.Fatal("a stray positional must fail")
	}
	if strings.Contains(err.Error(), "SUPERSECRET") {
		t.Fatalf("the credential was echoed back: %q", err.Error())
	}
	if !strings.Contains(err.Error(), "<redacted>") {
		t.Fatalf("error = %q, want a redacted leftover", err.Error())
	}
}

// The Codex route is flow-scoped, so a missing flow id is refused before the
// code is sent anywhere.
func TestAccountCodeRequiresAFlowForCodexProviders(t *testing.T) {
	harness, err := runAccountAuth(t, nil, "secret\n", "code", "openai")
	if err == nil || !strings.Contains(err.Error(), "requires --flow") {
		t.Fatalf("error = %v, want a flow requirement", err)
	}
	if len(harness.requests) != 0 {
		t.Fatalf("a request was sent without a flow: %v", harness.pathsHit())
	}
}

// A non-Codex provider posts to the generic OAuth route with the provider name.
func TestAccountCodeUsesTheProviderRouteForNonCodex(t *testing.T) {
	harness, err := runAccountAuth(t, nil, "secret\n", "code", "anthropic")
	if err != nil {
		t.Fatal(err)
	}
	if harness.requests[0].path != "/api/oauth/login/code" {
		t.Fatalf("path = %s", harness.requests[0].path)
	}
	if harness.requests[0].body["provider"] != "anthropic" {
		t.Fatalf("body = %#v", harness.requests[0].body)
	}
}

// A plain login must NOT block on stdin. Regression guard: making the stdin
// read unconditional hangs every browser login.
func TestAccountLoginDoesNotReadStdinWithoutACode(t *testing.T) {
	blocking := &neverReadyReader{}
	stub := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"flowId":"f1","url":"https://example.test/login"}`))
	}))
	t.Cleanup(stub.Close)
	api := newRuntimeAPI()
	api.BaseURL = stub.URL
	var out, errOut bytes.Buffer
	deps := accountAuthDeps{sleep: func(time.Duration) {}, stdin: blocking}
	done := make(chan error, 1)
	go func() {
		err, _ := accountAuthDispatch(context.Background(), api, "login",
			[]string{"openai", "--no-wait"}, deps, IO{In: blocking, Out: &out, Err: &errOut})
		done <- err
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("login blocked on stdin without --code")
	}
	if blocking.reads.Load() != 0 {
		t.Fatalf("stdin was read %d time(s) without --code", blocking.reads.Load())
	}
}

// A failing flow stops polling immediately rather than burning the budget.
func TestAccountLoginStopsOnAFailedFlow(t *testing.T) {
	for _, status := range []string{"error", "expired"} {
		t.Run(status, func(t *testing.T) {
			harness, err := runAccountAuth(t, func(request recordedRequest) (int, string) {
				if strings.Contains(request.path, "login-status") {
					return 200, `{"status":"` + status + `"}`
				}
				return 200, `{"flowId":"f1"}`
			}, "", "login", "openai")
			if err == nil {
				t.Fatalf("a %s flow must fail", status)
			}
			if len(harness.sleeps) != 1 {
				t.Fatalf("polled %d times; a failed flow must stop at once", len(harness.sleeps))
			}
		})
	}
}

// The two poll budgets are DIFFERENT and both are load-bearing: implementing
// each at 100 would pass a test that only checked "times out eventually".
func TestAccountLoginPollBudgetsMatchTheOracle(t *testing.T) {
	// The expected counts are LITERALS taken from src/cli/account-auth.ts, not
	// the implementation's own constants. Referencing codexLoginPollAttempts
	// here would make the test agree with whatever the code says: changing the
	// Codex budget to 100 still passed.
	for _, testCase := range []struct {
		name     string
		provider string
		body     string
		attempts int
	}{
		{name: "codex", provider: "openai", body: `{"status":"pending"}`, attempts: 150},
		{name: "provider", provider: "anthropic", body: `{"loggedIn":false}`, attempts: 100},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			harness, err := runAccountAuth(t, func(request recordedRequest) (int, string) {
				if strings.Contains(request.path, "status") {
					return 200, testCase.body
				}
				return 200, `{"flowId":"f1"}`
			}, "", "login", testCase.provider)
			if err == nil || !strings.Contains(err.Error(), "login timed out") {
				t.Fatalf("error = %v, want a timeout", err)
			}
			if len(harness.sleeps) != testCase.attempts {
				t.Fatalf("polled %d times, want exactly %d", len(harness.sleeps), testCase.attempts)
			}
			for _, duration := range harness.sleeps {
				if duration != 2*time.Second {
					t.Fatalf("slept %v between polls, want 2s", duration)
				}
			}
		})
	}
}

// --no-wait skips polling entirely.
func TestAccountLoginNoWaitSkipsPolling(t *testing.T) {
	harness, err := runAccountAuth(t, func(recordedRequest) (int, string) {
		return 200, `{"flowId":"f1"}`
	}, "", "login", "openai", "--no-wait")
	if err != nil {
		t.Fatal(err)
	}
	if len(harness.sleeps) != 0 {
		t.Fatalf("--no-wait polled %d time(s)", len(harness.sleeps))
	}
	for _, path := range harness.pathsHit() {
		if strings.Contains(path, "status") {
			t.Fatalf("--no-wait still queried status: %v", harness.pathsHit())
		}
	}
}

// `--code -` reads the code from stdin and routes it to the family's endpoint.
func TestAccountLoginStdinCodeReachesTheRightEndpoint(t *testing.T) {
	for _, testCase := range []struct{ name, provider, want string }{
		{name: "codex", provider: "openai", want: "/api/codex-auth/login/code"},
		{name: "provider", provider: "anthropic", want: "/api/oauth/login/code"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			harness, err := runAccountAuth(t, func(recordedRequest) (int, string) {
				return 200, `{"flowId":"f1"}`
			}, "piped-secret\n", "login", testCase.provider, "--code", "-", "--no-wait")
			if err != nil {
				t.Fatal(err)
			}
			found := false
			for _, request := range harness.requests {
				if request.path == testCase.want {
					found = true
					if request.body["input"] != "piped-secret" {
						t.Fatalf("body = %#v", request.body)
					}
				}
			}
			if !found {
				t.Fatalf("the code never reached %s: %v", testCase.want, harness.pathsHit())
			}
			if strings.Contains(harness.stderr.String(), "piped-secret") {
				t.Fatalf("the code reached stderr: %s", harness.stderr.String())
			}
		})
	}
}

// --id only means something with --reauth on the provider OAuth path.
func TestAccountLoginRejectsIdWithoutReauth(t *testing.T) {
	harness, err := runAccountAuth(t, nil, "", "login", "anthropic", "--id", "acct-1")
	if err == nil || !strings.Contains(err.Error(), "--reauth") {
		t.Fatalf("error = %v", err)
	}
	if len(harness.requests) != 0 {
		t.Fatalf("a login was started anyway: %v", harness.pathsHit())
	}
}

// `main` is the user-facing spelling of the internal __main__ account id.
func TestAccountResetCreditsMapsMain(t *testing.T) {
	harness, err := runAccountAuth(t, nil, "", "reset-credits", "main")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(harness.requests[0].query, "accountId=__main__") {
		t.Fatalf("query = %s", harness.requests[0].query)
	}
}

// Consuming a credit is irreversible, so it is gated before the POST is built.
func TestAccountResetCreditsRequiresYesToConsume(t *testing.T) {
	harness, err := runAccountAuth(t, nil, "", "reset-credits", "acct-1", "--consume")
	if err == nil || !strings.Contains(err.Error(), "requires --yes") {
		t.Fatalf("error = %v", err)
	}
	if len(harness.requests) != 0 {
		t.Fatalf("a consume request was sent without --yes: %v", harness.pathsHit())
	}
}

// An argv-passed code is warned about WITHOUT the value being repeated.
func TestAccountCodeWarnsAboutArgvExposureWithoutEchoingTheCode(t *testing.T) {
	harness, err := runAccountAuth(t, nil, "", "code", "openai", "--flow", "f1", "--code", "SUPERSECRET")
	if err != nil {
		t.Fatal(err)
	}
	stderr := harness.stderr.String()
	if !strings.Contains(stderr, "shell history") {
		t.Fatalf("the argv exposure was not reported: %s", stderr)
	}
	if strings.Contains(stderr, "SUPERSECRET") || strings.Contains(harness.stdout.String(), "SUPERSECRET") {
		t.Fatalf("the credential was printed: stderr=%s stdout=%s", stderr, harness.stdout.String())
	}
}

// A cancel targets the flow for Codex and the provider otherwise.
func TestAccountCancelUsesTheRightRoute(t *testing.T) {
	for _, testCase := range []struct{ name, provider, want string }{
		{name: "codex", provider: "openai", want: "/api/codex-auth/login/cancel"},
		{name: "provider", provider: "anthropic", want: "/api/oauth/login/cancel"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			harness, err := runAccountAuth(t, nil, "", "cancel", testCase.provider, "--flow", "f1")
			if err != nil {
				t.Fatal(err)
			}
			if harness.requests[0].path != testCase.want {
				t.Fatalf("path = %s, want %s", harness.requests[0].path, testCase.want)
			}
		})
	}
}
