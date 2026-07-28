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

type recordedCall struct {
	method string
	path   string
	body   map[string]any
}

// comboServer records what the CLI sent so a test can assert the wire contract
// rather than only the exit status.
func comboServer(t *testing.T, payload string) (*httptest.Server, *[]recordedCall) {
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

func runComboWith(t *testing.T, server *httptest.Server, args ...string) (string, error) {
	t.Helper()
	var out bytes.Buffer
	api := runtimeAPI{BaseURL: server.URL, loadCfg: func() (*config.Config, error) { return &config.Config{}, nil }}
	err := comboDispatch(context.Background(), api, args, IO{Out: &out})
	return out.String(), err
}

// The weight colon is the last colon AFTER the provider slash, because model
// identifiers legitimately contain colons.
func TestParseComboTargetsSeparatesModelColonsFromWeight(t *testing.T) {
	targets, err := parseComboTargets("openai/gpt:preview:3,anthropic/claude")
	if err != nil {
		t.Fatal(err)
	}
	if len(targets) != 2 {
		t.Fatalf("targets = %d, want 2", len(targets))
	}
	if targets[0].Provider != "openai" || targets[0].Model != "gpt:preview" {
		t.Fatalf("first target = %+v", targets[0])
	}
	if targets[0].Weight == nil || *targets[0].Weight != 3 {
		t.Fatalf("weight = %v, want 3", targets[0].Weight)
	}
	if targets[1].Weight != nil {
		t.Fatalf("second target should be weightless, got %v", *targets[1].Weight)
	}
}

func TestParseComboTargetsRejectsBadInput(t *testing.T) {
	for _, raw := range []string{"", "openai", "/model", "openai/", "openai/m:0", "openai/m:10001"} {
		if _, err := parseComboTargets(raw); err == nil {
			t.Fatalf("expected %q to be rejected", raw)
		}
	}
}

// `-` clears, and the two fields clear to different zero values because the API
// distinguishes "no effort pinned" from "no alias".
func TestComboSetSerializesClearSentinels(t *testing.T) {
	server, calls := comboServer(t, `{"ok":true}`)
	if _, err := runComboWith(t, server, "set", "x", "--targets", "a/b", "--effort", "-", "--alias", "-"); err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 1 || (*calls)[0].method != http.MethodPut {
		t.Fatalf("calls = %+v", *calls)
	}
	combo, _ := (*calls)[0].body["combo"].(map[string]any)
	effort, hasEffort := combo["defaultEffort"]
	if !hasEffort || effort != nil {
		t.Fatalf("defaultEffort = %#v, want an explicit null", effort)
	}
	if combo["alias"] != "" {
		t.Fatalf("alias = %#v, want an empty string", combo["alias"])
	}
	if combo["strategy"] != "failover" || combo["stickyLimit"] != float64(1) {
		t.Fatalf("defaults not applied: %#v", combo)
	}
}

// A destructive command must not reach the network without confirmation.
func TestComboRemoveRequiresConfirmation(t *testing.T) {
	server, calls := comboServer(t, `{}`)
	_, err := runComboWith(t, server, "remove", "x")
	if err == nil || !strings.Contains(err.Error(), "--yes") {
		t.Fatalf("err = %v, want a --yes usage error", err)
	}
	if len(*calls) != 0 {
		t.Fatalf("no request should have been sent, got %+v", *calls)
	}
}

func TestComboRemoveEscapesTheIdentifier(t *testing.T) {
	server, calls := comboServer(t, `{}`)
	if _, err := runComboWith(t, server, "remove", "a b/c", "--yes"); err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 1 || (*calls)[0].method != http.MethodDelete {
		t.Fatalf("calls = %+v", *calls)
	}
	if !strings.Contains((*calls)[0].path, "id=a+b%2Fc") {
		t.Fatalf("path = %q, want an escaped id", (*calls)[0].path)
	}
}

func TestComboRejectsInvalidStrategyAndSticky(t *testing.T) {
	server, calls := comboServer(t, `{}`)
	for _, args := range [][]string{
		{"set", "x", "--targets", "a/b", "--strategy", "bogus"},
		{"set", "x", "--targets", "a/b", "--sticky", "101"},
		{"set", "x", "--targets", "a/b", "--sticky", "0"},
	} {
		if _, err := runComboWith(t, server, args...); err == nil {
			t.Fatalf("expected %v to be rejected", args)
		}
	}
	if len(*calls) != 0 {
		t.Fatalf("validation must happen before the request, got %+v", *calls)
	}
}

func TestComboListRendersEmptyState(t *testing.T) {
	server, _ := comboServer(t, `{"combos":[]}`)
	out, err := runComboWith(t, server, "list")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "No combos configured.") {
		t.Fatalf("output = %q", out)
	}
}

func TestComboShowRejectsUnknownIdentifier(t *testing.T) {
	server, _ := comboServer(t, `{"combos":[{"id":"a"}]}`)
	if _, err := runComboWith(t, server, "show", "missing"); err == nil {
		t.Fatal("expected an unknown-combo error")
	}
}

// A weight too large to survive an int conversion must still be rejected as
// out-of-range. Converting first leaves the digits in the model name and ships
// a target the user never asked for.
func TestComboRejectsUnrepresentableWeight(t *testing.T) {
	for _, raw := range []string{"a/b:1e30", "a/b:99999"} {
		if _, err := parseComboTargets(raw); err == nil {
			t.Fatalf("expected %q to be rejected as out-of-range", raw)
		}
	}
	// The boundary values themselves stay valid.
	for _, raw := range []string{"a/b:1", "a/b:10000"} {
		if _, err := parseComboTargets(raw); err != nil {
			t.Fatalf("%q should be accepted: %v", raw, err)
		}
	}
}

// The oracle shifts the positional unconditionally, so a leading flag becomes
// the id and fails validation rather than being treated as absent.
func TestComboTreatsLeadingFlagAsTheIdentifier(t *testing.T) {
	server, calls := comboServer(t, `{"combos":[]}`)
	if _, err := runComboWith(t, server, "show", "--json"); err == nil {
		t.Fatal("expected --json to be consumed as the id and then rejected")
	}
	// The oracle shifts the id, then GETs before reporting an unknown combo, so
	// the request must actually have happened.
	if len(*calls) != 1 || (*calls)[0].method != http.MethodGet || (*calls)[0].path != "/api/combos" {
		t.Fatalf("calls = %+v, want one GET /api/combos", *calls)
	}
}

// Top-level command dispatch is exact-match in the oracle; only inner section
// actions are lowercased.
func TestComboDispatchIsCaseSensitive(t *testing.T) {
	server, calls := comboServer(t, `{"combos":[]}`)
	if _, err := runComboWith(t, server, "LIST"); err == nil {
		t.Fatal("expected LIST to be an unknown combo command")
	}
	if len(*calls) != 0 {
		t.Fatalf("an unknown command must not reach the network, got %+v", *calls)
	}
}

// route accepts only `route combo`; anything else must not silently do combo work.
func TestRouteAcceptsOnlyCombo(t *testing.T) {
	var out bytes.Buffer
	for _, args := range [][]string{nil, {"bogus"}, {"combos"}} {
		if err := runRoute(context.Background(), args, IO{Out: &out}); err == nil {
			t.Fatalf("expected %v to be rejected", args)
		}
	}
}
