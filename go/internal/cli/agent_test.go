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

func agentServer(t *testing.T, payload string) (*httptest.Server, *[]recordedCall) {
	t.Helper()
	calls := &[]recordedCall{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body := map[string]any{}
		if raw, _ := io.ReadAll(r.Body); len(raw) > 0 {
			_ = json.Unmarshal(raw, &body)
		}
		*calls = append(*calls, recordedCall{method: r.Method, path: r.URL.RequestURI(), body: body})
		_, _ = w.Write([]byte(payload))
	}))
	t.Cleanup(server.Close)
	return server, calls
}

func runAgentWith(t *testing.T, server *httptest.Server, args ...string) (string, error) {
	t.Helper()
	var out bytes.Buffer
	api := runtimeAPI{BaseURL: server.URL, loadCfg: func() (*config.Config, error) { return &config.Config{}, nil }}
	err := agentDispatch(context.Background(), api, args, IO{Out: &out})
	return out.String(), err
}

// Every subcommand must reach its own route; a copy-paste slip here silently
// writes one setting while reporting another.
func TestAgentSubcommandsUseTheirOwnRoutes(t *testing.T) {
	for _, testCase := range []struct {
		args   []string
		method string
		path   string
	}{
		{args: []string{"injection"}, method: http.MethodGet, path: "/api/injection-model"},
		{args: []string{"guidance"}, method: http.MethodGet, path: "/api/injection-model"},
		{args: []string{"effort"}, method: http.MethodGet, path: "/api/effort-caps"},
		{args: []string{"subagents"}, method: http.MethodGet, path: "/api/subagent-models"},
		{args: []string{"roster"}, method: http.MethodGet, path: "/api/subagent-models"},
		{args: []string{"fallback"}, method: http.MethodGet, path: "/api/subagent-model-fallback"},
		{args: []string{"sidecar"}, method: http.MethodGet, path: "/api/sidecar-settings"},
		{args: []string{"injection", "set", "--model", "m"}, method: http.MethodPut, path: "/api/injection-model"},
		{args: []string{"effort", "set", "--main", "high"}, method: http.MethodPut, path: "/api/effort-caps"},
		{args: []string{"subagents", "clear"}, method: http.MethodPut, path: "/api/subagent-models"},
		{args: []string{"fallback", "clear"}, method: http.MethodPut, path: "/api/subagent-model-fallback"},
		{args: []string{"sidecar", "web", "--model", "m"}, method: http.MethodPut, path: "/api/sidecar-settings"},
	} {
		t.Run(strings.Join(testCase.args, " "), func(t *testing.T) {
			server, calls := agentServer(t, `{}`)
			if _, err := runAgentWith(t, server, testCase.args...); err != nil {
				t.Fatal(err)
			}
			if len(*calls) != 1 {
				t.Fatalf("calls = %d, want 1", len(*calls))
			}
			if (*calls)[0].method != testCase.method || (*calls)[0].path != testCase.path {
				t.Fatalf("call = %s %s, want %s %s", (*calls)[0].method, (*calls)[0].path, testCase.method, testCase.path)
			}
		})
	}
}

// The bare command answers "how is the agent configured" from all six surfaces.
func TestAgentStatusReadsEverySurface(t *testing.T) {
	server, calls := agentServer(t, `{}`)
	if _, err := runAgentWith(t, server); err != nil {
		t.Fatal(err)
	}
	// Exactly six reads, all GET: a seventh would mean a duplicate fetch and a
	// non-GET would mean status is mutating something.
	if len(*calls) != 6 {
		t.Fatalf("status issued %d requests, want exactly 6: %+v", len(*calls), *calls)
	}
	seen := map[string]bool{}
	for _, call := range *calls {
		if call.method != http.MethodGet {
			t.Fatalf("status issued %s %s; it must only read", call.method, call.path)
		}
		seen[call.path] = true
	}
	for _, path := range []string{
		"/api/v2", "/api/injection-model", "/api/effort-caps",
		"/api/subagent-models", "/api/subagent-model-fallback", "/api/sidecar-settings",
	} {
		if !seen[path] {
			t.Fatalf("status did not read %s", path)
		}
	}
}

// Absent and cleared are different states: a PUT must not overwrite fields the
// user never mentioned.
func TestAgentInjectionSendsOnlyMentionedFields(t *testing.T) {
	server, calls := agentServer(t, `{}`)
	if _, err := runAgentWith(t, server, "injection", "set", "--model", "-", "--guidance", "off"); err != nil {
		t.Fatal(err)
	}
	body := (*calls)[0].body
	model, hasModel := body["model"]
	if !hasModel || model != nil {
		t.Fatalf("model = %#v, want an explicit null", model)
	}
	if body["multiAgentGuidanceEnabled"] != false {
		t.Fatalf("guidance = %#v, want false", body["multiAgentGuidanceEnabled"])
	}
	if _, sentEffort := body["effort"]; sentEffort {
		t.Fatal("effort was never mentioned and must not be sent")
	}
	if _, sentPrompt := body["prompt"]; sentPrompt {
		t.Fatal("prompt was never mentioned and must not be sent")
	}
}

// A no-op mutation is a mistake worth reporting, not a silent empty PUT.
func TestAgentRejectsEmptyMutations(t *testing.T) {
	for _, args := range [][]string{
		{"injection", "set"},
		{"effort", "set"},
		{"sidecar", "web"},
		{"fallback", "set"},
	} {
		server, calls := agentServer(t, `{}`)
		if _, err := runAgentWith(t, server, args...); err == nil {
			t.Fatalf("expected %v to be rejected", args)
		}
		if len(*calls) != 0 {
			t.Fatalf("%v must not reach the network, got %+v", args, *calls)
		}
	}
}

func TestAgentSubagentsEnforcesRosterCap(t *testing.T) {
	server, calls := agentServer(t, `{}`)
	if _, err := runAgentWith(t, server, "subagents", "set", "a,b,c,d,e,f"); err == nil {
		t.Fatal("expected the 5-model cap to be enforced")
	}
	if len(*calls) != 0 {
		t.Fatal("the cap must be checked before the request")
	}

	server, calls = agentServer(t, `{}`)
	if _, err := runAgentWith(t, server, "subagents", "set", "a,b,a"); err != nil {
		t.Fatal(err)
	}
	models, _ := (*calls)[0].body["models"].([]any)
	if len(models) != 2 {
		t.Fatalf("models = %#v, want duplicates collapsed", models)
	}
}

// fallback also owns --poll-ms, so a models-free `set` is legitimate here even
// though the same shape is an error for `subagents set`.
func TestAgentFallbackAcceptsPollOnlyUpdate(t *testing.T) {
	server, calls := agentServer(t, `{}`)
	if _, err := runAgentWith(t, server, "fallback", "set", "--poll-ms", "30000"); err != nil {
		t.Fatal(err)
	}
	body := (*calls)[0].body
	if body["pollMs"] != float64(30000) {
		t.Fatalf("pollMs = %#v", body["pollMs"])
	}
	if _, sentModels := body["models"]; sentModels {
		t.Fatal("an unmentioned roster must not be cleared by a poll-only update")
	}
}

func TestAgentFallbackBoundsPollInterval(t *testing.T) {
	for _, raw := range []string{"4999", "600001"} {
		server, calls := agentServer(t, `{}`)
		if _, err := runAgentWith(t, server, "fallback", "set", "--poll-ms", raw); err == nil {
			t.Fatalf("expected %s to be rejected", raw)
		}
		if len(*calls) != 0 {
			t.Fatal("bounds must be checked before the request")
		}
	}
}

// web and vision write different fields of the same document.
func TestAgentSidecarSelectsTheRightSection(t *testing.T) {
	for _, testCase := range []struct{ section, field string }{
		{"web", "webSearch"},
		{"vision", "vision"},
	} {
		server, calls := agentServer(t, `{}`)
		if _, err := runAgentWith(t, server, "sidecar", testCase.section, "--model", "m", "--backend", "-"); err != nil {
			t.Fatal(err)
		}
		settings, ok := (*calls)[0].body[testCase.field].(map[string]any)
		if !ok {
			t.Fatalf("%s body = %#v, want the %s field", testCase.section, (*calls)[0].body, testCase.field)
		}
		if settings["model"] != "m" {
			t.Fatalf("model = %#v", settings["model"])
		}
		backend, hasBackend := settings["backend"]
		if !hasBackend || backend != nil {
			t.Fatalf("backend = %#v, want an explicit null", backend)
		}
	}
}

func TestAgentRejectsUnknownSections(t *testing.T) {
	server, calls := agentServer(t, `{}`)
	for _, args := range [][]string{
		{"bogus"},
		{"injection", "bogus"},
		{"effort", "bogus"},
		{"subagents", "bogus"},
		{"fallback", "bogus"},
		{"sidecar", "bogus"},
	} {
		if _, err := runAgentWith(t, server, args...); err == nil {
			t.Fatalf("expected %v to be rejected", args)
		}
	}
	if len(*calls) != 0 {
		t.Fatalf("unknown sections must not reach the network, got %+v", *calls)
	}
}

// The lower bound is inclusive: 5000 is a legal poll interval.
func TestAgentFallbackAcceptsExactLowerBound(t *testing.T) {
	server, calls := agentServer(t, `{}`)
	if _, err := runAgentWith(t, server, "fallback", "set", "--poll-ms", "5000"); err != nil {
		t.Fatalf("5000 is the documented minimum: %v", err)
	}
	if (*calls)[0].body["pollMs"] != float64(5000) {
		t.Fatalf("pollMs = %#v", (*calls)[0].body["pollMs"])
	}
}

// The oracle shifts the leading argument unconditionally, so a flag becomes the
// action name and fails as unknown WITHOUT sending a request.
func TestAgentLeadingFlagBecomesTheAction(t *testing.T) {
	server, calls := agentServer(t, `{}`)
	if _, err := runAgentWith(t, server, "--json"); err == nil {
		t.Fatal("expected --json to be read as an unknown section")
	}
	if len(*calls) != 0 {
		t.Fatalf("no request should have been sent, got %+v", *calls)
	}
}
