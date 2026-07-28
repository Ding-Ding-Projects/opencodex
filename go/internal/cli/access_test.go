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
	if got := strings.Count(out, "Key (shown once): SUPERSECRET"); got != 1 {
		t.Fatalf("plaintext key appeared %d times in %q, want exactly 1", got, out)
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

// Each protocol has its own endpoint and body shape.
func TestAccessTestSendsTheProtocolSpecificRequest(t *testing.T) {
	for _, testCase := range []struct {
		protocol string
		path     string
		check    func(*testing.T, map[string]any)
	}{
		{protocol: "chat", path: "/v1/chat/completions", check: func(t *testing.T, body map[string]any) {
			if body["max_tokens"] != float64(16) || body["stream"] != false {
				t.Fatalf("chat body = %#v", body)
			}
		}},
		{protocol: "responses", path: "/v1/responses", check: func(t *testing.T, body map[string]any) {
			if body["input"] != "Reply with OK." || body["max_output_tokens"] != float64(16) {
				t.Fatalf("responses body = %#v", body)
			}
			if _, hasMessages := body["messages"]; hasMessages {
				t.Fatal("responses must not send messages")
			}
		}},
		{protocol: "messages", path: "/v1/messages", check: func(t *testing.T, body map[string]any) {
			if body["max_tokens"] != float64(16) {
				t.Fatalf("messages body = %#v", body)
			}
			if _, hasStream := body["stream"]; hasStream {
				t.Fatal("messages must not send stream")
			}
		}},
	} {
		t.Run(testCase.protocol, func(t *testing.T) {
			server, calls := accessServer(t, `{}`)
			args := []string{"test", "m"}
			if testCase.protocol != "chat" {
				args = append(args, "--protocol", testCase.protocol)
			}
			out, _, err := runAccessWith(t, server, args...)
			if err != nil {
				t.Fatal(err)
			}
			if len(*calls) != 1 || (*calls)[0].method != http.MethodPost || (*calls)[0].path != testCase.path {
				t.Fatalf("calls = %+v, want one POST %s", *calls, testCase.path)
			}
			if (*calls)[0].body["model"] != "m" {
				t.Fatalf("body = %#v, want the model", (*calls)[0].body)
			}
			testCase.check(t, (*calls)[0].body)
			if !strings.Contains(out, "m: "+testCase.protocol+" request succeeded.") {
				t.Fatalf("output = %q", out)
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
