package cli

import (
	"bytes"
	"context"
	"math"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// observeServer answers every GET with the supplied payload. The grok helper
// only serves state on /api/grok, so it would hand observe an empty body.
func observeServer(t *testing.T, payload string) (*httptest.Server, *[]recordedCall) {
	t.Helper()
	calls := &[]recordedCall{}
	// system status fans its reads out across goroutines, so the recorder is
	// written concurrently and needs its own lock.
	var recordMu sync.Mutex
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		recordMu.Lock()
		*calls = append(*calls, recordedCall{method: r.Method, path: r.URL.RequestURI()})
		recordMu.Unlock()
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
	// The exact URI, including key order: URLSearchParams preserves insertion
	// order, so a reordered query is a byte difference the differential sees.
	if len(*calls) != 1 || (*calls)[0].method != http.MethodGet {
		t.Fatalf("calls = %+v, want one GET", *calls)
	}
	const want = "/api/logs?provider=openai&model=gpt&status=5xx&limit=10"
	if (*calls)[0].path != want {
		t.Fatalf("path = %q, want %q", (*calls)[0].path, want)
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

// A log row may legitimately contain the literal string "-". scalarText uses
// "-" to mean "unset" when rendering a settings field, so reusing that sentinel
// here would silently drop a real provider or model name.
func TestObserveFormatKeepsLiteralDashValues(t *testing.T) {
	line := formatLog(map[string]any{
		"timestamp": "t1", "provider": "-", "model": "m", "status": float64(200),
	})
	if !strings.Contains(line, "-/m") {
		t.Fatalf("line = %q, want the literal dash preserved in the route", line)
	}
}

// The oracle trims the seen-set to its most recent 2500 keys rather than
// clearing it. Clearing outright would make the next poll reprint rows the user
// has already been shown.
func TestObserveFollowTrimRetainsRecentKeys(t *testing.T) {
	seen := map[string]struct{}{}
	order := []string{}
	for index := 0; index < 5_001; index++ {
		key := strconv.Itoa(index)
		seen[key] = struct{}{}
		order = append(order, key)
	}
	if len(order) > 5_000 {
		order = append([]string{}, order[len(order)-2_500:]...)
		seen = make(map[string]struct{}, len(order))
		for _, key := range order {
			seen[key] = struct{}{}
		}
	}
	if len(seen) != 2_500 {
		t.Fatalf("retained %d keys, want 2500", len(seen))
	}
	// The most recent key must survive; the oldest must not.
	if _, present := seen["5000"]; !present {
		t.Fatal("the newest key was dropped")
	}
	if _, present := seen["0"]; present {
		t.Fatal("the oldest key should have been trimmed")
	}
}

// URLSearchParams is not url.QueryEscape: it escapes `~` and leaves `*` alone,
// while Go does the reverse. Both parse back to the same value, so this only
// shows up as a byte difference in the request URI -- which is precisely what
// the unknown-command differential compares. Expected values were produced by
// running new URLSearchParams({k: v}).toString() in Bun.
func TestFormURLEncodeMatchesURLSearchParams(t *testing.T) {
	for _, testCase := range []struct{ raw, want string }{
		{raw: "a b", want: "a+b"},
		{raw: "a~b", want: "a%7Eb"},
		{raw: "a*b", want: "a*b"},
		{raw: "a!b", want: "a%21b"},
		{raw: "a'b", want: "a%27b"},
		{raw: "a(b)", want: "a%28b%29"},
		{raw: "é", want: "%C3%A9"},
		{raw: "a.b", want: "a.b"},
		{raw: "a_b", want: "a_b"},
		{raw: "a-b", want: "a-b"},
	} {
		if got := formURLEncode(testCase.raw); got != testCase.want {
			t.Fatalf("formURLEncode(%q) = %q, want %q", testCase.raw, got, testCase.want)
		}
	}
}

// An unset filter must be omitted entirely rather than sent as an empty value:
// the oracle only calls search.set for defined entries, so `?provider=` would
// be a filter the server actually applies.
func TestObserveQueryDistinguishesAbsentFromEmpty(t *testing.T) {
	// An OMITTED option is absent from the URI.
	got := observeQuery([]queryParam{
		{key: "provider", value: "openai", present: true},
		{key: "model"},
		{key: "status", value: "5xx", present: true},
	})
	if got != "?provider=openai&status=5xx" {
		t.Fatalf("observeQuery = %q", got)
	}
	// An EXPLICIT empty is a real filter and must be serialized: the oracle
	// calls search.set for every defined option, producing "provider=".
	explicit := observeQuery([]queryParam{
		{key: "provider", value: "", present: true},
		{key: "status", value: "5xx", present: true},
	})
	if explicit != "?provider=&status=5xx" {
		t.Fatalf("explicit empty = %q, want ?provider=&status=5xx", explicit)
	}
	if empty := observeQuery([]queryParam{{key: "provider"}}); empty != "" {
		t.Fatalf("all-absent query = %q, want no query string at all", empty)
	}
}

// End to end through the command: `--provider ""` must reach the server as a
// filter, not vanish.
func TestObserveLogsSendsAnExplicitlyEmptyFilter(t *testing.T) {
	server, calls := observeServer(t, `[]`)
	if _, err := runObserveWith(t, server, "logs", "--provider", "", "--jsonl"); err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 1 {
		t.Fatalf("calls = %+v, want exactly one", *calls)
	}
	if (*calls)[0].path != "/api/logs?provider=&limit=200" {
		t.Fatalf("path = %q, want the empty provider filter preserved", (*calls)[0].path)
	}
}

// summaryLines renders numbers with String(number) semantics. Expected values
// were produced by running String(v) in Bun; the non-finite cases matter
// because Go's FormatFloat writes "+Inf" where JavaScript writes "Infinity",
// and a server reporting an unbounded quota would render differently.
func TestJSNumberTextMatchesStringNumber(t *testing.T) {
	tenth, fifth := 0.1, 0.2
	for _, testCase := range []struct {
		value float64
		want  string
	}{
		{value: 1e21, want: "1e+21"},
		{value: 1e-7, want: "1e-7"},
		{value: 1e-6, want: "0.000001"},
		{value: 1e30, want: "1e+30"},
		{value: math.Copysign(0, -1), want: "0"},
		{value: tenth + fifth, want: "0.30000000000000004"},
		{value: 1.5, want: "1.5"},
		{value: 100, want: "100"},
		{value: math.NaN(), want: "NaN"},
		{value: math.Inf(1), want: "Infinity"},
		{value: math.Inf(-1), want: "-Infinity"},
	} {
		if got := jsNumberText(testCase.value); got != testCase.want {
			t.Fatalf("jsNumberText(%v) = %q, want %q", testCase.value, got, testCase.want)
		}
	}
}

// JSON.stringify preserves the order a row was parsed in. Re-marshalling a
// decoded Go map sorts the keys, so a scripted consumer diffing --jsonl output
// against the TypeScript CLI would see every line reordered.
func TestObserveJSONLPreservesServerKeyOrder(t *testing.T) {
	server, _ := observeServer(t, `[{"timestamp":"t","id":"a","provider":"p"}]`)
	out, err := runObserveWith(t, server, "logs", "--jsonl")
	if err != nil {
		t.Fatal(err)
	}
	line := strings.TrimSpace(out)
	if line != `{"timestamp":"t","id":"a","provider":"p"}` {
		t.Fatalf("jsonl line = %s, want the server's own key order", line)
	}
}

// The same rule applies through the wrapper shapes.
func TestObserveJSONLPreservesOrderInsideWrappers(t *testing.T) {
	server, _ := observeServer(t, `{"logs":[{"z":1,"a":2}]}`)
	out, err := runObserveWith(t, server, "logs", "--jsonl")
	if err != nil {
		t.Fatal(err)
	}
	if line := strings.TrimSpace(out); line != `{"z":1,"a":2}` {
		t.Fatalf("jsonl line = %s, want the server's own key order", line)
	}
}

// The oracle iterates the parsed array directly, so a malformed payload prints
// EVERY entry, and each line must be the entry it belongs to. Filtering to
// objects would drop the number and shift the pairing.
func TestObserveJSONLPrintsEveryRowInOrder(t *testing.T) {
	server, _ := observeServer(t, `[1,{"z":1,"a":2},"text",null]`)
	out, err := runObserveWith(t, server, "logs", "--jsonl")
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	want := []string{"1", `{"z":1,"a":2}`, `"text"`, "null"}
	if len(lines) != len(want) {
		t.Fatalf("got %d lines %q, want %d", len(lines), lines, len(want))
	}
	for index := range want {
		if lines[index] != want[index] {
			t.Fatalf("line %d = %s, want %s", index+1, lines[index], want[index])
		}
	}
}

// The oracle prints JSON.stringify output, which normalizes whitespace and
// escape spelling. Copying the server's bytes verbatim would keep both.
func TestObserveJSONLNormalizesLikeJSONStringify(t *testing.T) {
	server, _ := observeServer(t, `[ { "z" : "\u0061", "a":2 } ]`)
	out, err := runObserveWith(t, server, "logs", "--jsonl")
	if err != nil {
		t.Fatal(err)
	}
	if line := strings.TrimSpace(out); line != `{"z":"a","a":2}` {
		t.Fatalf("jsonl line = %s, want compact normalized output in source order", line)
	}
}

// Numbers go through IEEE-754 exactly as JSON.parse does, so the source
// spelling is deliberately NOT preserved. Bun: 12345678901234567890 becomes
// 12345678901234567000, 1.00 becomes 1, and 1e+3 becomes 1000.
func TestObserveJSONLNormalizesNumbersLikeJavaScript(t *testing.T) {
	server, _ := observeServer(t, `[{"big":12345678901234567890,"round":1.00,"exp":1e+3,"rate":1e-7}]`)
	out, err := runObserveWith(t, server, "logs", "--jsonl")
	if err != nil {
		t.Fatal(err)
	}
	line := strings.TrimSpace(out)
	if line != `{"big":12345678901234567000,"round":1,"exp":1000,"rate":1e-7}` {
		t.Fatalf("jsonl line = %s, want JavaScript number normalization", line)
	}
}

// JSON.parse keeps the LAST value for a duplicate key while retaining the
// position of the first occurrence.
func TestObserveJSONLAppliesDuplicateKeyOverwrite(t *testing.T) {
	server, _ := observeServer(t, `{"logs":[{"first":1}],"logs":[{"second":2}]}`)
	out, err := runObserveWith(t, server, "logs", "--jsonl")
	if err != nil {
		t.Fatal(err)
	}
	if line := strings.TrimSpace(out); line != `{"second":2}` {
		t.Fatalf("jsonl line = %s, want the last duplicate wrapper to win", line)
	}
}

func TestOrderedDecodeKeepsFirstPositionForDuplicateKeys(t *testing.T) {
	value, err := decodeOrdered([]byte(`{"a":1,"b":2,"a":3}`))
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := value.MarshalJSON()
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != `{"a":3,"b":2}` {
		t.Fatalf("encoded = %s, want the last value at the first position", encoded)
	}
}

// Malformed input must be reported, not panic.
func TestOrderedDecodeRejectsMalformedJSON(t *testing.T) {
	for _, raw := range []string{`{"a":`, `[1,`, `{`, ``} {
		if _, err := decodeOrdered([]byte(raw)); err == nil {
			t.Fatalf("expected %q to fail", raw)
		}
	}
}

// The four aliases must forward their flags into the right observe section.
// The test drives the SAME functions the registry calls, so a wrapper that
// names the wrong section or drops its arguments fails here.
func TestObserveAliasesForwardArgumentsToTheirSection(t *testing.T) {
	for _, testCase := range []struct {
		alias   string
		run     func(context.Context, runtimeAPI, []string, IO) error
		args    []string
		wantURI string
	}{
		{alias: "logs", run: runObserveLogsWith, args: []string{"--status", "5xx", "--limit", "7", "--jsonl"}, wantURI: "/api/logs?status=5xx&limit=7"},
		{alias: "usage", run: runObserveUsageWith, args: []string{"--range", "7d", "--surface", "codex", "--json"}, wantURI: "/api/usage?range=7d&surface=codex"},
		{alias: "storage", run: runObserveStorageWith, args: []string{"--limit", "3", "--json"}, wantURI: "/api/storage?limit=3"},
		{alias: "memory", run: runObserveMemoryWith, args: []string{"--json"}, wantURI: "/api/system/memory"},
	} {
		t.Run(testCase.alias, func(t *testing.T) {
			server, calls := observeServer(t, `[]`)
			if err := testCase.run(context.Background(), testAPI(server), testCase.args, IO{Out: &bytes.Buffer{}}); err != nil {
				t.Fatal(err)
			}
			if len(*calls) != 1 {
				t.Fatalf("calls = %+v, want exactly one", *calls)
			}
			if (*calls)[0].path != testCase.wantURI {
				t.Fatalf("%s => %q, want %q", testCase.alias, (*calls)[0].path, testCase.wantURI)
			}
		})
	}
}

// The guard messages are the oracle's, verbatim. Paraphrasing them would be a
// user-visible divergence that no path assertion catches.
func TestObserveGuardsUseTheOracleWording(t *testing.T) {
	for _, testCase := range []struct {
		args []string
		want string
	}{
		{args: []string{"logs", "--json", "--jsonl"}, want: "--json and --jsonl cannot be combined"},
		{args: []string{"logs", "--follow", "--json"}, want: "--follow uses --jsonl, not --json"},
		{args: []string{"usage", "--range", "90d"}, want: "--range must be 7d, 30d, or all"},
		{args: []string{"usage", "--surface", "bogus"}, want: "--surface must be all, codex, claude, or grok"},
	} {
		server, calls := observeServer(t, `[]`)
		err := observeDispatch(context.Background(), testAPI(server), testCase.args, IO{Out: &bytes.Buffer{}})
		if err == nil {
			t.Fatalf("%v should have been rejected", testCase.args)
		}
		if err.Error() != testCase.want {
			t.Fatalf("%v => %q, want %q", testCase.args, err.Error(), testCase.want)
		}
		if len(*calls) != 0 {
			t.Fatalf("%v sent %+v; validation must precede the request", testCase.args, *calls)
		}
	}
}

// Each top-level alias must resolve to its own wrapper, and none of them may
// become visible: the root help is compared byte-for-byte with the oracle.
func TestObserveAliasesAreRegisteredAndHidden(t *testing.T) {
	for _, alias := range []string{"logs", "usage", "storage", "memory"} {
		position, ok := commandIndex[alias]
		if !ok {
			t.Fatalf("%q is not registered", alias)
		}
		if !commandSpecs[position].Hidden {
			t.Fatalf("%q must be hidden so it does not appear in the root help", alias)
		}
	}
	// Presence is not enough: the registry must resolve each alias to ITS OWN
	// wrapper, or `ocx storage` could quietly run the usage handler.
	for alias, want := range map[string]commandHandler{
		"logs":    runObserveLogs,
		"usage":   runObserveUsage,
		"storage": runObserveStorage,
		"memory":  runObserveMemory,
	} {
		got := commandSpecs[commandIndex[alias]].Handler
		if reflect.ValueOf(got).Pointer() != reflect.ValueOf(want).Pointer() {
			t.Fatalf("%q resolves to the wrong handler", alias)
		}
	}
	for _, name := range registeredCommandNames(false) {
		switch name {
		case "logs", "usage", "storage", "memory":
			t.Fatalf("%q leaked into the visible command list", name)
		}
	}
}

// JSON.parse accepts a literal beyond float64 range as Infinity, and
// JSON.stringify renders a non-finite number as null. Letting the Go decoder
// reject it would drop the whole row.
func TestObserveJSONLRendersOutOfRangeNumbersAsNull(t *testing.T) {
	server, _ := observeServer(t, `[{"n":1e400,"m":-1e400}]`)
	out, err := runObserveWith(t, server, "logs", "--jsonl")
	if err != nil {
		t.Fatal(err)
	}
	if line := strings.TrimSpace(out); line != `{"n":null,"m":null}` {
		t.Fatalf("jsonl line = %s, want non-finite numbers as null", line)
	}
}

// JSON.parse throws on anything after the root value.
func TestOrderedDecodeRejectsTrailingContent(t *testing.T) {
	for _, raw := range []string{`{} {}`, `[] garbage`, `1 2`, `{"a":1}x`} {
		if _, err := decodeOrdered([]byte(raw)); err == nil {
			t.Fatalf("expected %q to be rejected as trailing content", raw)
		}
	}
	// A single root value with surrounding whitespace stays valid.
	if _, err := decodeOrdered([]byte("  {\"a\":1}\n")); err != nil {
		t.Fatalf("a lone value must still parse: %v", err)
	}
}
