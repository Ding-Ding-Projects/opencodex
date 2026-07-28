package cli

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// observeServer answers every GET with the supplied payload. The grok helper
// only serves state on /api/grok, so it would hand observe an empty body.
func observeServer(t *testing.T, payload string) (*httptest.Server, *[]recordedCall) {
	t.Helper()
	calls := &[]recordedCall{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*calls = append(*calls, recordedCall{method: r.Method, path: r.URL.RequestURI()})
		_, _ = w.Write([]byte(payload))
	}))
	t.Cleanup(server.Close)
	return server, calls
}

func runObserveWith(t *testing.T, server *httptest.Server, args ...string) (string, error) {
	t.Helper()
	var out bytes.Buffer
	err := observeDispatch(context.Background(), testAPI(server), args, IO{Out: &out})
	return out.String(), err
}

// Each section must reach its own route; the four aliases must land on the same
// place as the section they stand for.
func TestObserveSectionsAndAliasesUseTheirOwnRoutes(t *testing.T) {
	for _, testCase := range []struct {
		args []string
		path string
	}{
		{args: []string{"logs"}, path: "/api/logs?limit=200"},
		{args: []string{"usage"}, path: "/api/usage?range=30d&surface=all"},
		{args: []string{"storage"}, path: "/api/storage"},
		{args: []string{"memory"}, path: "/api/system/memory"},
		{args: []string{"debug"}, path: "/api/debug"},
		{args: []string{"claude-inbound"}, path: "/api/claude/inbound-debug"},
		{args: []string{"injection"}, path: "/api/debug/injection-logs"},
	} {
		t.Run(strings.Join(testCase.args, " "), func(t *testing.T) {
			server, calls := observeServer(t, `{}`)
			if _, err := runObserveWith(t, server, testCase.args...); err != nil {
				t.Fatal(err)
			}
			if len(*calls) != 1 || (*calls)[0].method != http.MethodGet || (*calls)[0].path != testCase.path {
				t.Fatalf("calls = %+v, want one GET %s", *calls, testCase.path)
			}
		})
	}
}

// The oracle sends limit and model even though the server ignores them today;
// dropping them would be a silent contract change rather than a simplification.
func TestObserveLogsSendsEveryFilter(t *testing.T) {
	server, calls := observeServer(t, `[]`)
	if _, err := runObserveWith(t, server, "logs",
		"--provider", "openai", "--model", "gpt", "--status", "5xx", "--limit", "10"); err != nil {
		t.Fatal(err)
	}
	path := (*calls)[0].path
	for _, want := range []string{"provider=openai", "model=gpt", "status=5xx", "limit=10"} {
		if !strings.Contains(path, want) {
			t.Fatalf("path = %q, missing %s", path, want)
		}
	}
}

// Only one output shape can win, and follow streams line by line, so a single
// JSON document could never be closed.
func TestObserveLogsRejectsConflictingOutputModes(t *testing.T) {
	server, calls := observeServer(t, `[]`)
	for _, args := range [][]string{
		{"logs", "--json", "--jsonl"},
		{"logs", "--follow", "--json"},
		{"logs", "-f", "--json"},
	} {
		if _, err := runObserveWith(t, server, args...); err == nil {
			t.Fatalf("expected %v to be rejected", args)
		}
	}
	if len(*calls) != 0 {
		t.Fatalf("conflicting modes must not reach the network, got %+v", *calls)
	}
}

// Follow polls repeatedly and must not reprint a row it already showed.
func TestObserveLogsFollowDeduplicates(t *testing.T) {
	server, _ := observeServer(t, `[{"id":"a","timestamp":"t1","provider":"p","model":"m","status":200}]`)

	previousRounds, previousSleep := observeFollowRounds, observeSleep
	observeFollowRounds = 2
	slept := 0
	observeSleep = func(context.Context, time.Duration) error { slept++; return nil }
	t.Cleanup(func() { observeFollowRounds, observeSleep = previousRounds, previousSleep })

	out, err := runObserveWith(t, server, "logs", "--follow")
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Count(out, "t1"); got != 1 {
		t.Fatalf("row printed %d times across two polls, want 1", got)
	}
	if slept != 1 {
		t.Fatalf("slept %d times between two polls, want 1", slept)
	}
}

func TestObserveUsageValidatesItsEnums(t *testing.T) {
	server, calls := observeServer(t, `{}`)
	for _, args := range [][]string{
		{"usage", "--range", "90d"},
		{"usage", "--surface", "bogus"},
	} {
		if _, err := runObserveWith(t, server, args...); err == nil {
			t.Fatalf("expected %v to be rejected", args)
		}
	}
	if len(*calls) != 0 {
		t.Fatal("validation must precede the request")
	}
}

// logRows accepts the bare array and the three wrapper keys the oracle handles.
func TestObserveLogRowsAcceptsEveryShape(t *testing.T) {
	for _, payload := range []any{
		[]any{map[string]any{"id": "a"}},
		map[string]any{"logs": []any{map[string]any{"id": "a"}}},
		map[string]any{"entries": []any{map[string]any{"id": "a"}}},
		map[string]any{"requests": []any{map[string]any{"id": "a"}}},
	} {
		if rows := logRows(payload); len(rows) != 1 {
			t.Fatalf("payload %#v produced %d rows, want 1", payload, len(rows))
		}
	}
	if rows := logRows(map[string]any{"other": 1}); len(rows) != 0 {
		t.Fatalf("unknown shape produced %d rows, want 0", len(rows))
	}
}

func TestObserveRejectsUnknownSection(t *testing.T) {
	server, calls := observeServer(t, `{}`)
	if _, err := runObserveWith(t, server, "bogus"); err == nil {
		t.Fatal("expected an unknown section to be rejected")
	}
	if len(*calls) != 0 {
		t.Fatal("an unknown section must not reach the network")
	}
}
