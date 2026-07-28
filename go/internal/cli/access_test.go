package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/management"
)

// accessServer records every request and answers with the supplied payload.
func accessServer(t *testing.T, payload string) (*httptest.Server, *[]recordedCall) {
	t.Helper()
	calls := &[]recordedCall{}
	var recordMu sync.Mutex
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body := map[string]any{}
		if raw, _ := io.ReadAll(r.Body); len(raw) > 0 {
			_ = json.Unmarshal(raw, &body)
		}
		recordMu.Lock()
		*calls = append(*calls, recordedCall{method: r.Method, path: r.URL.RequestURI(), body: body})
		recordMu.Unlock()
		_, _ = w.Write([]byte(payload))
	}))
	t.Cleanup(server.Close)
	return server, calls
}

func runAccessWith(t *testing.T, server *httptest.Server, args ...string) (string, string, error) {
	t.Helper()
	var out, errOut bytes.Buffer
	err := accessDispatch(context.Background(), testAPI(server), args, IO{Out: &out, Err: &errOut})
	return out.String(), errOut.String(), err
}

// The plaintext key is returned once and must be shown once, with the wording
// that tells the caller to store it.
func TestAccessKeyCreateShowsThePlaintextKeyExactlyOnce(t *testing.T) {
	server, calls := accessServer(t, `{"id":"k1","name":"n","key":"SUPERSECRET"}`)
	out, errOut, err := runAccessWith(t, server, "key", "create", "n")
	if err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 1 || (*calls)[0].method != http.MethodPost || (*calls)[0].path != "/api/keys" {
		t.Fatalf("calls = %+v, want one POST /api/keys", *calls)
	}
	if (*calls)[0].body["name"] != "n" {
		t.Fatalf("body = %#v, want the supplied name", (*calls)[0].body)
	}
	// Count the SECRET itself, not the line that carries it: a second leak
	// anywhere else in stdout would still satisfy a line-shaped assertion.
	if got := strings.Count(out, "SUPERSECRET"); got != 1 {
		t.Fatalf("plaintext key appeared %d times in %q, want exactly 1", got, out)
	}
	if !strings.Contains(out, "Key (shown once): SUPERSECRET") {
		t.Fatalf("output = %q, missing the one-time key line", out)
	}
	if !strings.Contains(out, "Created API key n (k1).") {
		t.Fatalf("output = %q, missing the created line", out)
	}
	// A credential must never reach stderr, where it would land in logs.
	if strings.Contains(errOut, "SUPERSECRET") {
		t.Fatalf("credential leaked to stderr: %q", errOut)
	}
}

// create defaults the name rather than failing, matching the oracle.
func TestAccessKeyCreateDefaultsTheName(t *testing.T) {
	server, calls := accessServer(t, `{"id":"k1","name":"default","key":"s"}`)
	if _, _, err := runAccessWith(t, server, "key", "create"); err != nil {
		t.Fatal(err)
	}
	if (*calls)[0].body["name"] != "default" {
		t.Fatalf("body = %#v, want the default name", (*calls)[0].body)
	}
}

// Destructive removal is guarded, and a rejected guard must not reach the API.
func TestAccessKeyRemoveGuards(t *testing.T) {
	for _, testCase := range []struct {
		args []string
		want string
	}{
		{args: []string{"key", "remove", "k1"}, want: "remove requires --yes"},
		// The oracle shifts the positional BEFORE reading --yes, so
		// `remove --yes` consumes the flag as the id and then reports the
		// missing confirmation. Verified by running src/cli/access.ts, which
		// prints "Error: remove requires --yes".
		{args: []string{"key", "remove", "--yes"}, want: "remove requires --yes"},
		{args: []string{"key", "remove"}, want: "key id is required"},
	} {
		server, calls := accessServer(t, `{}`)
		_, _, err := runAccessWith(t, server, testCase.args...)
		if err == nil || err.Error() != testCase.want {
			t.Fatalf("%v => %v, want %q", testCase.args, err, testCase.want)
		}
		if len(*calls) != 0 {
			t.Fatalf("%v sent %+v; the guard must precede the request", testCase.args, *calls)
		}
	}
}

func TestAccessKeyRemoveSendsTheIdentifier(t *testing.T) {
	server, calls := accessServer(t, `{}`)
	if _, _, err := runAccessWith(t, server, "key", "remove", "k1", "--yes"); err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 1 || (*calls)[0].method != http.MethodDelete || (*calls)[0].path != "/api/keys" {
		t.Fatalf("calls = %+v, want one DELETE /api/keys", *calls)
	}
	if (*calls)[0].body["id"] != "k1" {
		t.Fatalf("body = %#v, want the id in the body", (*calls)[0].body)
	}
}

// The empty state reads as a sentence rather than an empty list.
func TestAccessKeyListRendersRowsAndEmptyState(t *testing.T) {
	server, _ := accessServer(t, `{"keys":[{"id":"k1","name":"prod","prefix":"ocx_ab"}]}`)
	out, _, err := runAccessWith(t, server, "key", "list")
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(out) != "k1  prod  ocx_ab" {
		t.Fatalf("output = %q", out)
	}

	empty, _ := accessServer(t, `{"keys":[]}`)
	out, _, err = runAccessWith(t, empty, "key")
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(out) != "No API access keys configured." {
		t.Fatalf("empty output = %q", out)
	}
}

// endpoints reports only addressing fields. The filter is what keeps the key
// material in the same payload off the terminal.
func TestAccessEndpointsFiltersToAddressingFields(t *testing.T) {
	server, _ := accessServer(t, `{"baseUrl":"http://u","chatEndpoint":"/v1/chat","keys":[{"id":"k1","key":"SUPERSECRET"}]}`)
	out, _, err := runAccessWith(t, server, "endpoints")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out, "SUPERSECRET") || strings.Contains(out, "keys") {
		t.Fatalf("endpoints leaked non-addressing fields: %q", out)
	}
	for _, want := range []string{"baseUrl: http://u", "chatEndpoint: /v1/chat"} {
		if !strings.Contains(out, want) {
			t.Fatalf("output = %q, missing %q", out, want)
		}
	}
}

// --json must carry the same filtered view, in the server's key order.
func TestAccessEndpointsJSONKeepsServerOrderAndFilter(t *testing.T) {
	server, _ := accessServer(t, `{"zEndpoint":"z","baseUrl":"b","keys":[{"key":"SUPERSECRET"}]}`)
	out, _, err := runAccessWith(t, server, "endpoints", "--json")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out, "SUPERSECRET") {
		t.Fatalf("json view leaked key material: %q", out)
	}
	compact := strings.Join(strings.Fields(out), "")
	if compact != `{"zEndpoint":"z","baseUrl":"b"}` {
		t.Fatalf("json view = %s, want the server's own order", compact)
	}
}

func TestAccessModelsRendersIdAndOwner(t *testing.T) {
	server, calls := accessServer(t, `{"data":[{"id":"gpt","owned_by":"openai"},{"id":"solo"}]}`)
	out, _, err := runAccessWith(t, server, "models")
	if err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 1 || (*calls)[0].path != "/v1/models" {
		t.Fatalf("calls = %+v, want one GET /v1/models", *calls)
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if len(lines) != 2 || lines[0] != "gpt  openai" || lines[1] != "solo" {
		t.Fatalf("lines = %q, want the trailing separator trimmed for a missing owner", lines)
	}
}

// Each protocol has its own endpoint and its own COMPLETE body. Spot-checking a
// field would let an extra or missing key through, and the oracle's bodies are
// exact.
func TestAccessTestSendsTheProtocolSpecificRequest(t *testing.T) {
	userMessage := []any{map[string]any{"role": "user", "content": "Reply with OK."}}
	for _, testCase := range []struct {
		protocol string
		path     string
		want     map[string]any
	}{
		{protocol: "chat", path: "/v1/chat/completions", want: map[string]any{
			"model": "m", "messages": userMessage, "max_tokens": float64(16), "stream": false,
		}},
		{protocol: "responses", path: "/v1/responses", want: map[string]any{
			"model": "m", "input": "Reply with OK.", "max_output_tokens": float64(16),
		}},
		{protocol: "messages", path: "/v1/messages", want: map[string]any{
			"model": "m", "messages": userMessage, "max_tokens": float64(16),
		}},
	} {
		t.Run(testCase.protocol, func(t *testing.T) {
			server, calls := accessServer(t, `{}`)
			args := []string{"test", "m"}
			if testCase.protocol != "chat" {
				args = append(args, "--protocol", testCase.protocol)
			}
			if _, _, err := runAccessWith(t, server, args...); err != nil {
				t.Fatal(err)
			}
			if len(*calls) != 1 || (*calls)[0].method != http.MethodPost || (*calls)[0].path != testCase.path {
				t.Fatalf("calls = %+v, want one POST %s", *calls, testCase.path)
			}
			if !reflect.DeepEqual((*calls)[0].body, testCase.want) {
				t.Fatalf("body = %#v, want exactly %#v", (*calls)[0].body, testCase.want)
			}
		})
	}
}

func TestAccessTestRejectsBadInput(t *testing.T) {
	for _, testCase := range []struct {
		args []string
		want string
	}{
		{args: []string{"test"}, want: "model is required"},
		{args: []string{"test", "m", "--protocol", "grpc"}, want: "--protocol must be chat, responses, or messages"},
		// The oracle shifts the first token unconditionally, so a flag placed
		// before the model becomes the model and the rest are leftovers.
		// Expected strings produced by running src/cli/access.ts.
		{args: []string{"test", "--protocol", "chat", "m"}, want: "Unexpected argument(s): chat m"},
		{args: []string{"test", "--protocol", "grpc"}, want: "Unexpected argument(s): grpc"},
		{args: []string{"test", "--json", "m"}, want: "Unexpected argument(s): m"},
	} {
		server, calls := accessServer(t, `{}`)
		_, _, err := runAccessWith(t, server, testCase.args...)
		if err == nil || err.Error() != testCase.want {
			t.Fatalf("%v => %v, want %q", testCase.args, err, testCase.want)
		}
		if len(*calls) != 0 {
			t.Fatalf("%v sent %+v; validation must precede the request", testCase.args, *calls)
		}
	}
}

// `api-key` is the oracle's alias for `access key`, so it must reach the same
// endpoint through the same wrapper the registry calls.
func TestAPIKeyAliasForwardsIntoAccessKey(t *testing.T) {
	server, calls := accessServer(t, `{"keys":[]}`)
	if err := runAccessKeyWith(context.Background(), testAPI(server), []string{"list"}, IO{Out: &bytes.Buffer{}}); err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 1 || (*calls)[0].method != http.MethodGet || (*calls)[0].path != "/api/keys" {
		t.Fatalf("calls = %+v, want one GET /api/keys", *calls)
	}

	position, ok := commandIndex["api-key"]
	if !ok {
		t.Fatal("api-key is not registered")
	}
	if !commandSpecs[position].Hidden {
		t.Fatal("api-key must be hidden; the root help is byte-compared")
	}
	if reflect.ValueOf(commandSpecs[position].Handler).Pointer() != reflect.ValueOf(runAccessKey).Pointer() {
		t.Fatal("api-key resolves to the wrong handler")
	}
}

// End to end against the REAL management handler, not a permissive stub.
//
// The stub-only test above passes whatever the server would have rejected:
// the Go server used to require a caller-supplied key and never returned one,
// so `ocx access key create` could not work at all and no CLI-level test
// noticed. This drives the actual handler.
func TestAccessKeyCreateAgainstTheRealManagementHandler(t *testing.T) {
	cfg := config.Default()
	api, err := management.New(management.Options{Config: &cfg})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(api)
	t.Cleanup(server.Close)

	var out, errOut bytes.Buffer
	if err := accessDispatch(context.Background(), testAPI(server), []string{"key", "create", "desktop"},
		IO{Out: &out, Err: &errOut}); err != nil {
		t.Fatalf("create failed against the real server: %v", err)
	}

	if len(cfg.APIKeys) != 1 {
		t.Fatalf("server stored %d keys, want 1", len(cfg.APIKeys))
	}
	stored := cfg.APIKeys[0].Key
	if !strings.Contains(out.String(), "Key (shown once): "+stored) {
		t.Fatalf("output %q does not present the stored key", out.String())
	}
	if strings.Contains(errOut.String(), stored) {
		t.Fatalf("credential reached stderr: %q", errOut.String())
	}

	// The listing that follows must not repeat it.
	var listOut bytes.Buffer
	if err := accessDispatch(context.Background(), testAPI(server), []string{"key", "list"}, IO{Out: &listOut}); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(listOut.String(), stored) {
		t.Fatalf("listing leaked the key: %q", listOut.String())
	}
}

// --json prints the payload verbatim, so it must carry the server's key order.
// Decoding into a map and re-serializing would sort them, which text output
// hides but the differential does not.
func TestAccessKeyCreateJSONKeepsOracleFieldOrder(t *testing.T) {
	cfg := config.Default()
	api, err := management.New(management.Options{Config: &cfg})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(api)
	t.Cleanup(server.Close)

	var out bytes.Buffer
	if err := accessDispatch(context.Background(), testAPI(server),
		[]string{"key", "create", "desktop", "--json"}, IO{Out: &out}); err != nil {
		t.Fatal(err)
	}
	body := out.String()
	for _, pair := range [][2]string{{`"id"`, `"name"`}, {`"name"`, `"key"`}, {`"key"`, `"createdAt"`}} {
		if strings.Index(body, pair[0]) > strings.Index(body, pair[1]) {
			t.Fatalf("%s must precede %s: %s", pair[0], pair[1], body)
		}
	}
}

// Top-level selectors are compared exactly, like the oracle's === chain. Only
// the key ACTIONS are lowercased.
func TestAccessDispatchIsCaseSensitiveAtTheTopLevel(t *testing.T) {
	server, calls := accessServer(t, `{}`)
	for _, section := range []string{"KEYS", "Key", "ENDPOINTS", "Models", "TEST"} {
		if _, _, err := runAccessWith(t, server, section); err == nil {
			t.Fatalf("%q should be an unknown access command", section)
		}
	}
	if len(*calls) != 0 {
		t.Fatalf("an unknown section must not reach the network, got %+v", *calls)
	}

	// The key actions themselves still accept either case.
	server, calls = accessServer(t, `{"keys":[]}`)
	if _, _, err := runAccessWith(t, server, "key", "LIST"); err != nil {
		t.Fatalf("key actions are lowercased by the oracle: %v", err)
	}
	if len(*calls) != 1 {
		t.Fatalf("calls = %+v, want the list request", *calls)
	}
}

// The positional is shifted BEFORE --yes is read, so a lone --yes becomes the
// id and the confirmation check is what fails.
func TestAccessKeyRemoveReportsTheOraclesFirstFailure(t *testing.T) {
	server, calls := accessServer(t, `{}`)
	_, _, err := runAccessWith(t, server, "key", "remove", "--yes")
	if err == nil || !strings.Contains(err.Error(), "remove requires --yes") {
		t.Fatalf("err = %v, want the confirmation error", err)
	}
	_, _, err = runAccessWith(t, server, "key", "remove")
	if err == nil || !strings.Contains(err.Error(), "key id is required") {
		t.Fatalf("err = %v, want the missing-id error", err)
	}
	if len(*calls) != 0 {
		t.Fatal("neither form may reach the network")
	}
}
