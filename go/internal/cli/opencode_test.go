package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const opencodeTestConfig = `{"port":10100,"hostname":"127.0.0.1","defaultProvider":"openai","providers":{"openai":{"adapter":"openai-responses","baseUrl":"https://chatgpt.com/backend-api/codex","authMode":"forward","codexAccountMode":"pool"}}}`

type opencodeLaunch struct {
	args []string
	env  map[string]string
}

// runOpencodeAgainst drives the launcher against a stub management server and a
// stub exec, so neither a live proxy nor the real opencode binary is needed.
func runOpencodeAgainst(t *testing.T, body string, args []string, runErr error) (opencodeLaunch, string, error) {
	t.Helper()
	configHome(t, opencodeTestConfig)
	stub := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/models" {
			writer.WriteHeader(http.StatusNotFound)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(body))
	}))
	t.Cleanup(stub.Close)

	var launched opencodeLaunch
	var stderr bytes.Buffer
	api := newRuntimeAPI()
	api.BaseURL = stub.URL
	err := opencodeDispatch(context.Background(), api, args,
		IO{In: strings.NewReader(""), Out: &bytes.Buffer{}, Err: &stderr},
		func(_ context.Context, execArgs []string, env []string, _ IO) error {
			launched = opencodeLaunch{args: execArgs, env: environmentMap(env)}
			return runErr
		})
	return launched, stderr.String(), err
}

func opencodeProviderFromLaunch(t *testing.T, launch opencodeLaunch) map[string]any {
	t.Helper()
	raw, present := launch.env[opencodeConfigContentEnv]
	if !present {
		t.Fatalf("%s was not set; env=%v", opencodeConfigContentEnv, launch.env)
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		t.Fatalf("inline config is not valid JSON: %v", err)
	}
	providerRecord, isObject := decoded["provider"].(map[string]any)
	if !isObject {
		t.Fatalf("inline config has no provider object: %s", raw)
	}
	block, isBlock := providerRecord[opencodeProviderID].(map[string]any)
	if !isBlock {
		t.Fatalf("inline config has no %s provider: %s", opencodeProviderID, raw)
	}
	return block
}

// The oracle assumes /api/models returns a bare array; the Go management server
// answers with an envelope. The launcher accepts BOTH, because it only consumes
// the response and widening it here is narrower than moving server bytes other
// differential tests compare.
func TestOpencodeAcceptsBothModelResponseShapes(t *testing.T) {
	rows := `{"provider":"anthropic","id":"claude-x","namespaced":"anthropic/claude-x","contextWindow":200000}`
	for _, testCase := range []struct{ name, body string }{
		{name: "bare array", body: "[" + rows + "]"},
		{name: "envelope", body: `{"models":[` + rows + `],"customModels":[]}`},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			launch, _, err := runOpencodeAgainst(t, testCase.body, []string{}, nil)
			if err != nil {
				t.Fatal(err)
			}
			block := opencodeProviderFromLaunch(t, launch)
			models, isObject := block["models"].(map[string]any)
			if !isObject || models["anthropic/claude-x"] == nil {
				t.Fatalf("catalog did not survive the %s shape: %#v", testCase.name, block["models"])
			}
		})
	}
}

// The admission key travels in the ENV. The inline config carries only the
// {env:...} reference, so the credential never lands in a config payload that
// gets logged or inherited.
func TestOpencodeKeepsTheAdmissionKeyOutOfTheConfigPayload(t *testing.T) {
	t.Setenv("OPENCODEX_API_AUTH_TOKEN", "SUPERSECRET")
	launch, stderr, err := runOpencodeAgainst(t, `[]`, []string{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if launch.env[opencodeAPIKeyEnv] != "SUPERSECRET" {
		t.Fatalf("%s = %q, want the admission token", opencodeAPIKeyEnv, launch.env[opencodeAPIKeyEnv])
	}
	inline := launch.env[opencodeConfigContentEnv]
	if strings.Contains(inline, "SUPERSECRET") {
		t.Fatalf("the admission token was serialized into the inline config: %s", inline)
	}
	if !strings.Contains(inline, opencodeAPIKeyEnvRef) {
		t.Fatalf("the inline config lost the env reference: %s", inline)
	}
	if strings.Contains(stderr, "SUPERSECRET") {
		t.Fatalf("the admission token reached stderr: %s", stderr)
	}
}

// Arguments are passed through untouched: the launcher parses no subcommands.
func TestOpencodeForwardsArgumentsUnchanged(t *testing.T) {
	want := []string{"run", "--flag", "x"}
	launch, _, err := runOpencodeAgainst(t, `[]`, want, nil)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(launch.args, " ") != strings.Join(want, " ") {
		t.Fatalf("argv = %v, want %v", launch.args, want)
	}
}

// An inherited inline layer is merged rather than replaced: only our own
// provider key is overridden, so a wrapper script's configuration survives.
func TestOpencodeMergesInheritedInlineConfig(t *testing.T) {
	t.Setenv(opencodeConfigContentEnv, `{"theme":"dark","provider":{"other":{"npm":"x"}}}`)
	launch, _, err := runOpencodeAgainst(t, `[]`, []string{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(launch.env[opencodeConfigContentEnv]), &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["theme"] != "dark" {
		t.Fatalf("the inherited layer was dropped: %#v", decoded)
	}
	providerRecord, _ := decoded["provider"].(map[string]any)
	if providerRecord["other"] == nil {
		t.Fatalf("a sibling provider was dropped: %#v", providerRecord)
	}
	if providerRecord[opencodeProviderID] == nil {
		t.Fatalf("our own provider block is missing: %#v", providerRecord)
	}
}

// A conflicting on-disk config is REPORTED, not rewritten, and the launch
// continues: the inline layer outranks it anyway.
func TestOpencodeReportsAConflictingDiskConfigWithoutRewritingIt(t *testing.T) {
	home := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", home)
	directory := filepath.Join(home, "opencode")
	if err := os.MkdirAll(directory, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, "opencode.json")
	// JSONC, to prove the tolerant parser is on this path.
	contents := "{\n  // user comment\n  \"provider\": { \"opencodex\": { \"npm\": \"mine\" } },\n}"
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
	_, stderr, err := runOpencodeAgainst(t, `[]`, []string{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stderr, path) {
		t.Fatalf("the conflicting config was not reported: %s", stderr)
	}
	after, readErr := os.ReadFile(path)
	if readErr != nil || string(after) != contents {
		t.Fatalf("the launcher rewrote the user's config: %q", string(after))
	}
}

// A limit block is emitted only from an authoritative context window, and its
// output half is clamped so a small-context model can never exceed it.
func TestOpencodeEmitsLimitsOnlyFromAnAuthoritativeContextWindow(t *testing.T) {
	body := `[{"provider":"a","id":"known","namespaced":"a/known","contextWindow":1000},` +
		`{"provider":"a","id":"unknown","namespaced":"a/unknown"}]`
	launch, _, err := runOpencodeAgainst(t, body, []string{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	models, _ := opencodeProviderFromLaunch(t, launch)["models"].(map[string]any)
	known, _ := models["a/known"].(map[string]any)
	limit, isObject := known["limit"].(map[string]any)
	if !isObject {
		t.Fatalf("a known context window produced no limit: %#v", known)
	}
	if limit["context"] != float64(1000) || limit["output"] != float64(1000) {
		t.Fatalf("limit = %#v; output must be clamped to the context window", limit)
	}
	unknown, _ := models["a/unknown"].(map[string]any)
	if _, present := unknown["limit"]; present {
		t.Fatalf("a limit was guessed for a model without a context window: %#v", unknown)
	}
}

// Disabled rows never reach opencode.
func TestOpencodeOmitsDisabledModels(t *testing.T) {
	body := `[{"provider":"a","id":"on","namespaced":"a/on"},{"provider":"a","id":"off","namespaced":"a/off","disabled":true}]`
	launch, _, err := runOpencodeAgainst(t, body, []string{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	models, _ := opencodeProviderFromLaunch(t, launch)["models"].(map[string]any)
	if models["a/on"] == nil {
		t.Fatalf("an enabled model was dropped: %#v", models)
	}
	if _, present := models["a/off"]; present {
		t.Fatalf("a disabled model was advertised: %#v", models)
	}
}

// A malformed catalog is reported rather than launching opencode against a
// provider block built from nothing.
func TestOpencodeReportsAnUnexpectedCatalogPayload(t *testing.T) {
	launch, stderr, err := runOpencodeAgainst(t, `"not a catalog"`, []string{}, nil)
	if err == nil {
		t.Fatal("an unexpected payload must fail")
	}
	if launch.args != nil {
		t.Fatalf("opencode was launched anyway: %v", launch.args)
	}
	if !strings.Contains(stderr, "Could not fetch the model catalog") {
		t.Fatalf("stderr did not explain the failure: %s", stderr)
	}
}
