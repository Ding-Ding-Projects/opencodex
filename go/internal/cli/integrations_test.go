package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/config"
)

// grokServer answers GET /api/grok with the supplied state and records writes.
func grokServer(t *testing.T, state string) (*httptest.Server, *[]recordedCall) {
	t.Helper()
	calls := &[]recordedCall{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body := map[string]any{}
		if raw, _ := io.ReadAll(r.Body); len(raw) > 0 {
			_ = json.Unmarshal(raw, &body)
		}
		*calls = append(*calls, recordedCall{method: r.Method, path: r.URL.RequestURI(), body: body})
		if r.Method == http.MethodGet && r.URL.Path == "/api/grok" {
			_, _ = w.Write([]byte(state))
			return
		}
		_, _ = w.Write([]byte(`{}`))
	}))
	t.Cleanup(server.Close)
	return server, calls
}

func testAPI(server *httptest.Server) runtimeAPI {
	return runtimeAPI{BaseURL: server.URL, loadCfg: func() (*config.Config, error) { return &config.Config{}, nil }}
}

func runGrokWith(t *testing.T, server *httptest.Server, args ...string) (string, error) {
	t.Helper()
	var out bytes.Buffer
	err := grokDispatch(context.Background(), testAPI(server), args, IO{Out: &out})
	return out.String(), err
}

func runClaudeConfigWith(t *testing.T, server *httptest.Server, args ...string) (string, error) {
	t.Helper()
	var out bytes.Buffer
	err := claudeConfigDispatch(context.Background(), testAPI(server), args, IO{Out: &out})
	return out.String(), err
}

func lastPut(t *testing.T, calls []recordedCall) recordedCall {
	t.Helper()
	for index := len(calls) - 1; index >= 0; index-- {
		if calls[index].method == http.MethodPut {
			return calls[index]
		}
	}
	t.Fatal("no PUT was sent")
	return recordedCall{}
}

func excludedModels(t *testing.T, call recordedCall) []string {
	t.Helper()
	raw, ok := call.body["excluded"].([]any)
	if !ok {
		t.Fatalf("excluded = %#v", call.body["excluded"])
	}
	out := make([]string, 0, len(raw))
	for _, item := range raw {
		out = append(out, item.(string))
	}
	return out
}

// exclude and include are RELATIVE edits: they must read current state first,
// or they silently replace the list instead of amending it.
func TestGrokExcludeAndIncludeAmendServerState(t *testing.T) {
	server, calls := grokServer(t, `{"excluded":["a","b"]}`)
	if _, err := runGrokWith(t, server, "exclude", "c"); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(excludedModels(t, lastPut(t, *calls)), ","); got != "a,b,c" {
		t.Fatalf("exclude produced %q, want the union", got)
	}

	server, calls = grokServer(t, `{"excluded":["a","b"]}`)
	if _, err := runGrokWith(t, server, "include", "a"); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(excludedModels(t, lastPut(t, *calls)), ","); got != "b" {
		t.Fatalf("include produced %q, want the model removed", got)
	}
}

// set is absolute: it replaces the list without consulting the server.
func TestGrokSetReplacesWithoutReadingState(t *testing.T) {
	server, calls := grokServer(t, `{"excluded":["a","b"]}`)
	if _, err := runGrokWith(t, server, "set", "z"); err != nil {
		t.Fatal(err)
	}
	for _, call := range *calls {
		if call.method == http.MethodGet {
			t.Fatal("set must not read current state")
		}
	}
	if got := strings.Join(excludedModels(t, lastPut(t, *calls)), ","); got != "z" {
		t.Fatalf("set produced %q", got)
	}
}

func TestGrokClearSendsEmptySelection(t *testing.T) {
	server, calls := grokServer(t, `{"excluded":["a"]}`)
	out, err := runGrokWith(t, server, "clear")
	if err != nil {
		t.Fatal(err)
	}
	if len(excludedModels(t, lastPut(t, *calls))) != 0 {
		t.Fatal("clear must send an empty list")
	}
	if !strings.Contains(out, "none") {
		t.Fatalf("output = %q, want the empty-state wording", out)
	}
}

// Apply is a POST to its own endpoint. Asserting the method and path matters:
// without it this test would still pass if apply silently issued a GET, or hit
// the selection endpoint instead and mutated nothing.
func TestGrokApplyPostsToTheApplyEndpoint(t *testing.T) {
	var calls []recordedCall
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, recordedCall{method: r.Method, path: r.URL.RequestURI()})
		_, _ = w.Write([]byte(`{"message":"Applied 3 models."}`))
	}))
	defer server.Close()

	out, err := runGrokWith(t, server, "apply")
	if err != nil {
		t.Fatal(err)
	}
	if len(calls) != 1 {
		t.Fatalf("calls = %+v, want exactly one", calls)
	}
	if calls[0].method != http.MethodPost || calls[0].path != "/api/grok/apply" {
		t.Fatalf("call = %+v, want POST /api/grok/apply", calls[0])
	}
	if !strings.Contains(out, "Applied 3 models.") {
		t.Fatalf("output = %q, want the server's own message", out)
	}
}

func TestGrokRejectsBadInput(t *testing.T) {
	server, calls := grokServer(t, `{}`)
	for _, args := range [][]string{{"bogus"}, {"exclude"}, {"set"}} {
		if _, err := runGrokWith(t, server, args...); err == nil {
			t.Fatalf("expected %v to be rejected", args)
		}
	}
	for _, call := range *calls {
		if call.method == http.MethodPut {
			t.Fatal("invalid input must not write")
		}
	}
}

// `default` and `-` both clear the window; anything else must be a positive
// integer so a typo cannot silently disable compaction.
func TestClaudeConfigCompactWindow(t *testing.T) {
	for _, raw := range []string{"default", "-"} {
		server, calls := grokServer(t, `{}`)
		if _, err := runClaudeConfigWith(t, server, "set", "--compact-window", raw); err != nil {
			t.Fatal(err)
		}
		value, present := lastPut(t, *calls).body["autoCompactWindow"]
		if !present || value != nil {
			t.Fatalf("%q => %#v, want an explicit null", raw, value)
		}
	}

	server, calls := grokServer(t, `{}`)
	if _, err := runClaudeConfigWith(t, server, "set", "--compact-window", "120_000"); err != nil {
		t.Fatal(err)
	}
	if lastPut(t, *calls).body["autoCompactWindow"] != float64(120000) {
		t.Fatalf("separator form = %#v", lastPut(t, *calls).body["autoCompactWindow"])
	}

	for _, raw := range []string{"0", "-5", "abc", "1.5"} {
		server, calls := grokServer(t, `{}`)
		if _, err := runClaudeConfigWith(t, server, "set", "--compact-window", raw); err == nil {
			t.Fatalf("expected %q to be rejected", raw)
		}
		for _, call := range *calls {
			if call.method == http.MethodPut {
				t.Fatalf("%q must not reach the network", raw)
			}
		}
	}
}

func TestClaudeConfigModelMap(t *testing.T) {
	server, calls := grokServer(t, `{}`)
	if _, err := runClaudeConfigWith(t, server, "set", "--model-map", "a=b, c = d"); err != nil {
		t.Fatal(err)
	}
	mapped, ok := lastPut(t, *calls).body["modelMap"].(map[string]any)
	if !ok || mapped["a"] != "b" || mapped["c"] != "d" {
		t.Fatalf("modelMap = %#v", lastPut(t, *calls).body["modelMap"])
	}

	server, calls = grokServer(t, `{}`)
	if _, err := runClaudeConfigWith(t, server, "set", "--model-map", "-"); err != nil {
		t.Fatal(err)
	}
	if cleared, ok := lastPut(t, *calls).body["modelMap"].(map[string]any); !ok || len(cleared) != 0 {
		t.Fatalf("`-` should clear the map, got %#v", lastPut(t, *calls).body["modelMap"])
	}

	for _, raw := range []string{"=b", "a=", "ab"} {
		if _, err := parseModelMap(raw); err == nil {
			t.Fatalf("expected %q to be rejected", raw)
		}
	}
}

// The two sidecars are independent: naming only the web half must not emit a
// vision patch that clears settings the user never mentioned.
func TestClaudeConfigSidecarsAreIndependent(t *testing.T) {
	server, calls := grokServer(t, `{}`)
	if _, err := runClaudeConfigWith(t, server, "set", "--web-model", "m", "--web-backend", "-"); err != nil {
		t.Fatal(err)
	}
	body := lastPut(t, *calls).body
	web, ok := body["webSearchSidecar"].(map[string]any)
	if !ok || web["model"] != "m" {
		t.Fatalf("webSearchSidecar = %#v", body["webSearchSidecar"])
	}
	if backend, present := web["backend"]; !present || backend != nil {
		t.Fatalf("backend = %#v, want an explicit null", backend)
	}
	if _, present := body["visionSidecar"]; present {
		t.Fatal("an unmentioned sidecar must not be sent")
	}
}

func TestClaudeConfigRejectsEmptyMutation(t *testing.T) {
	server, calls := grokServer(t, `{}`)
	if _, err := runClaudeConfigWith(t, server, "set"); err == nil {
		t.Fatal("expected an empty set to be rejected")
	}
	for _, call := range *calls {
		if call.method == http.MethodPut {
			t.Fatal("an empty set must not write")
		}
	}
}

func TestIntegrationRoutesToBothSurfaces(t *testing.T) {
	var out bytes.Buffer
	if err := runIntegration(context.Background(), nil, IO{Out: &out}); err == nil {
		t.Fatal("expected a bare integration call to be rejected")
	}
	if err := runIntegration(context.Background(), []string{"bogus"}, IO{Out: &out}); err == nil {
		t.Fatal("expected an unknown integration to be rejected")
	}
}

// A relative edit must never delete exclusions it cannot type-assert. The
// oracle's Set keeps whatever the server stored, so silently dropping a
// non-string entry would make `grok exclude c` destructive.
func TestGrokRefusesToRewriteMalformedState(t *testing.T) {
	server, calls := grokServer(t, `{"excluded":["a",42,null]}`)
	if _, err := runGrokWith(t, server, "exclude", "c"); err == nil {
		t.Fatal("expected malformed server state to be reported, not silently rewritten")
	}
	for _, call := range *calls {
		if call.method == http.MethodPut {
			t.Fatal("no write may happen against malformed state")
		}
	}
}

// A missing or null `excluded` is simply an empty list in both runtimes.
func TestGrokTreatsAbsentStateAsEmpty(t *testing.T) {
	for _, state := range []string{`{}`, `{"excluded":null}`} {
		server, calls := grokServer(t, state)
		if _, err := runGrokWith(t, server, "exclude", "c"); err != nil {
			t.Fatalf("state %s: %v", state, err)
		}
		if got := strings.Join(excludedModels(t, lastPut(t, *calls)), ","); got != "c" {
			t.Fatalf("state %s produced %q", state, got)
		}
	}
}

// The oracle accepts a compact window too large for an int; validating after
// conversion would reject a value the TypeScript CLI takes.
func TestClaudeConfigAcceptsLargeCompactWindow(t *testing.T) {
	server, calls := grokServer(t, `{}`)
	if _, err := runClaudeConfigWith(t, server, "set", "--compact-window", "1e30"); err != nil {
		t.Fatalf("1e30 should be accepted like the oracle: %v", err)
	}
	if lastPut(t, *calls).body["autoCompactWindow"] != 1e30 {
		t.Fatalf("autoCompactWindow = %#v", lastPut(t, *calls).body["autoCompactWindow"])
	}
}

// integration must route the valid surfaces, not merely reject invalid ones.
func TestIntegrationRoutesGrokAndClaudeToTheirRoutes(t *testing.T) {
	var out bytes.Buffer
	for _, testCase := range []struct {
		surface string
		path    string
		state   string
	}{
		{"grok", "/api/grok", `{"excluded":[]}`},
		{"claude", "/api/claude-code", `{}`},
	} {
		server, calls := grokServer(t, testCase.state)
		dispatch := grokDispatch
		if testCase.surface == "claude" {
			dispatch = claudeConfigDispatch
		}
		if err := dispatch(context.Background(), testAPI(server), []string{"status"}, IO{Out: &out}); err != nil {
			t.Fatal(err)
		}
		if len(*calls) != 1 || (*calls)[0].method != http.MethodGet || (*calls)[0].path != testCase.path {
			t.Fatalf("%s status = %+v, want one GET %s", testCase.surface, *calls, testCase.path)
		}
	}
}

// A present but non-array `excluded` must not be treated as empty and
// overwritten. new Set(42) throws in the oracle, so it never writes either.
//
// The string case is a deliberate divergence: new Set("ab") iterates into
// ["a","b"] and the oracle would PUT that back, rewriting a malformed value
// into a plausible-looking list. Refusing can only skip a write, never delete.
func TestGrokRefusesNonListState(t *testing.T) {
	for _, state := range []string{`{"excluded":42}`, `{"excluded":{"a":1}}`, `{"excluded":"ab"}`} {
		server, calls := grokServer(t, state)
		if _, err := runGrokWith(t, server, "exclude", "c"); err == nil {
			t.Fatalf("state %s should be rejected", state)
		}
		for _, call := range *calls {
			if call.method == http.MethodPut {
				t.Fatalf("state %s must not be overwritten", state)
			}
		}
	}
}

// Top-level integration dispatch is exact-match in the oracle.
func TestIntegrationDispatchIsCaseSensitive(t *testing.T) {
	var out bytes.Buffer
	for _, surface := range []string{"Grok", "CLAUDE"} {
		if err := runIntegration(context.Background(), []string{surface}, IO{Out: &out}); err == nil {
			t.Fatalf("expected %q to be rejected", surface)
		}
	}
}
