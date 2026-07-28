package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// configHome points the CLI at a throwaway config directory and seeds it.
func configHome(t *testing.T, contents string) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("OPENCODEX_HOME", dir)
	path := filepath.Join(dir, "config.json")
	if contents != "" {
		if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return path
}

func runConfigParityWith(t *testing.T, stdin string, args ...string) (string, error) {
	t.Helper()
	var out bytes.Buffer
	err := runConfigParity(context.Background(), args, IO{In: strings.NewReader(stdin), Out: &out})
	return out.String(), err
}

// Secret-named fields are masked, but an EMPTY one is left alone: masking it
// would read as "a credential is set" when none is.
func TestConfigShowRedactsSecretsButNotEmptyOnes(t *testing.T) {
	configHome(t, `{"port":12000,"hostname":"127.0.0.1","defaultProvider":"p","providers":{"p":{"adapter":"openai-chat","baseUrl":"http://u","apiKey":"SUPERSECRET"},"q":{"adapter":"openai-chat","baseUrl":"http://v","apiKey":""}}}`)
	out, err := runConfigParityWith(t, "", "show")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out, "SUPERSECRET") {
		t.Fatalf("show leaked a credential: %s", out)
	}
	if !strings.Contains(out, `"apiKey": "********"`) {
		t.Fatalf("show did not mask the set key: %s", out)
	}
	if !strings.Contains(out, `"apiKey": ""`) {
		t.Fatalf("an empty key must stay empty, not become a mask: %s", out)
	}
	if !strings.Contains(out, `"baseUrl": "http://u"`) {
		t.Fatalf("non-secret fields must survive: %s", out)
	}
}

func TestConfigGetWalksDotPathsAndRedacts(t *testing.T) {
	configHome(t, `{"port":12000,"hostname":"127.0.0.1","defaultProvider":"p","providers":{"p":{"adapter":"openai-chat","baseUrl":"http://u","apiKey":"SUPERSECRET","models":["a","b"]}}}`)

	out, err := runConfigParityWith(t, "", "get", "port")
	if err != nil || strings.TrimSpace(out) != "12000" {
		t.Fatalf("get port = %q, %v", out, err)
	}

	out, err = runConfigParityWith(t, "", "get", "providers.p.apiKey")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out, "SUPERSECRET") || !strings.Contains(out, "********") {
		t.Fatalf("get leaked the key: %q", out)
	}

	// An object leaf prints as JSON rather than Go's map formatting.
	out, err = runConfigParityWith(t, "", "get", "providers.p.models")
	if err != nil || !strings.Contains(out, `"a"`) {
		t.Fatalf("get array = %q, %v", out, err)
	}
}

// Prototype-poisoning segments are refused. Go has no prototype chain, but
// accepting them would write keys the TypeScript CLI then refuses to edit.
func TestConfigRejectsBlockedAndMissingPaths(t *testing.T) {
	configHome(t, `{"port":12000,"hostname":"127.0.0.1","defaultProvider":"p","providers":{"p":{"adapter":"openai-chat","baseUrl":"http://u"}}}`)
	for _, testCase := range []struct {
		args []string
		want string
	}{
		{args: []string{"get", "providers.__proto__.x"}, want: "invalid config path"},
		{args: []string{"get", "providers.constructor"}, want: "invalid config path"},
		{args: []string{"get", "nope"}, want: "config path not found: nope"},
		{args: []string{"get", "providers.p.missing"}, want: "config path not found: providers.p.missing"},
	} {
		_, err := runConfigParityWith(t, "", testCase.args...)
		if err == nil || err.Error() != testCase.want {
			t.Fatalf("%v => %v, want %q", testCase.args, err, testCase.want)
		}
	}
}

// The oracle does NOT create missing parents; it rejects them. Creating them
// would produce a config the TypeScript CLI refuses to write.
func TestConfigSetRequiresAnExistingObjectParent(t *testing.T) {
	path := configHome(t, `{"port":12000,"hostname":"127.0.0.1","defaultProvider":"p","providers":{"p":{"adapter":"openai-chat","baseUrl":"http://u"}},"list":[1]}`)
	before, _ := os.ReadFile(path)

	for _, testCase := range []struct {
		args []string
		want string
	}{
		{args: []string{"set", "a.b.c", "1"}, want: "config parent path not found: a"},
		{args: []string{"set", "list.0.x", "1"}, want: "config parent path not found: list"},
		{args: []string{"set", "port.deep", "1"}, want: "config parent path not found: port"},
		{args: []string{"unset", "providers.p.zzz"}, want: "config path not found: providers.p.zzz"},
	} {
		_, err := runConfigParityWith(t, "", testCase.args...)
		if err == nil || err.Error() != testCase.want {
			t.Fatalf("%v => %v, want %q", testCase.args, err, testCase.want)
		}
	}
	after, _ := os.ReadFile(path)
	if string(before) != string(after) {
		t.Fatal("a rejected set must not touch the file")
	}
}

func TestConfigSetAndUnsetPersist(t *testing.T) {
	configHome(t, `{"port":12000,"hostname":"127.0.0.1","defaultProvider":"p","providers":{"p":{"adapter":"openai-chat","baseUrl":"http://u","apiKey":"k"}}}`)

	if _, err := runConfigParityWith(t, "", "set", "providers.p.baseUrl", "http://v"); err != nil {
		t.Fatal(err)
	}
	out, err := runConfigParityWith(t, "", "get", "providers.p.baseUrl")
	if err != nil || strings.TrimSpace(out) != "http://v" {
		t.Fatalf("after set = %q, %v", out, err)
	}

	// unset removes an OPTIONAL field. Removing a required one is refused by
	// validation, which is the point of validating before writing.
	if _, err := runConfigParityWith(t, "", "set", "providers.p.label", `"x"`); err != nil {
		t.Fatal(err)
	}
	if _, err := runConfigParityWith(t, "", "unset", "providers.p.label"); err != nil {
		t.Fatal(err)
	}
	if _, err := runConfigParityWith(t, "", "get", "providers.p.label"); err == nil {
		t.Fatal("unset did not remove the field")
	}
	if _, err := runConfigParityWith(t, "", "unset", "providers.p.baseUrl"); err == nil {
		t.Fatal("removing a required field must fail validation before it is written")
	}
	out, err = runConfigParityWith(t, "", "get", "providers.p.baseUrl")
	if err != nil || strings.TrimSpace(out) != "http://v" {
		t.Fatalf("the refused unset must not have been written: %q %v", out, err)
	}
}

// A value is JSON first, literal string second, which is what lets an
// unquoted word work.
func TestConfigSetParsesJSONThenFallsBackToText(t *testing.T) {
	configHome(t, `{"port":12000,"hostname":"127.0.0.1","defaultProvider":"openai","providers":{"openai":{"adapter":"openai-responses","baseUrl":"https://api.openai.com/v1"}}}`)
	if _, err := runConfigParityWith(t, "", "set", "port", "13000"); err != nil {
		t.Fatal(err)
	}
	out, _ := runConfigParityWith(t, "", "get", "port")
	if strings.TrimSpace(out) != "13000" {
		t.Fatalf("numeric value = %q", out)
	}
	if _, err := runConfigParityWith(t, "", "set", "hostname", "localhost"); err != nil {
		t.Fatal(err)
	}
	out, _ = runConfigParityWith(t, "", "get", "hostname")
	if strings.TrimSpace(out) != "localhost" {
		t.Fatalf("bare word value = %q", out)
	}
}

// Export is a BACKUP: it is not redacted, because a masked copy could not be
// imported back. That is exactly why it must be written owner-only.
func TestConfigExportIsUnredactedAndOwnerOnly(t *testing.T) {
	configHome(t, `{"port":12000,"hostname":"127.0.0.1","defaultProvider":"p","providers":{"p":{"adapter":"openai-chat","baseUrl":"http://u","apiKey":"SUPERSECRET"}}}`)
	target := filepath.Join(t.TempDir(), "backup.json")
	if _, err := runConfigParityWith(t, "", "export", target); err != nil {
		t.Fatal(err)
	}
	written, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(written), "SUPERSECRET") {
		t.Fatal("export must not redact; a masked backup cannot be restored")
	}
	info, err := os.Stat(target)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("export mode = %v, want 0600 for a file holding credentials", info.Mode().Perm())
	}
}

func TestConfigExportToStdout(t *testing.T) {
	configHome(t, `{"port":12000,"hostname":"127.0.0.1","defaultProvider":"openai","providers":{"openai":{"adapter":"openai-responses","baseUrl":"https://api.openai.com/v1"}}}`)
	out, err := runConfigParityWith(t, "", "export", "-")
	if err != nil || !strings.Contains(out, `"port": 12000`) {
		t.Fatalf("export - = %q, %v", out, err)
	}
}

func TestConfigImportRequiresConfirmationAndValidJSON(t *testing.T) {
	path := configHome(t, `{"port":12000,"hostname":"127.0.0.1","defaultProvider":"openai","providers":{"openai":{"adapter":"openai-responses","baseUrl":"https://api.openai.com/v1"}}}`)
	source := filepath.Join(t.TempDir(), "in.json")
	if err := os.WriteFile(source, []byte(`{"port":14000,"hostname":"127.0.0.1","defaultProvider":"openai","providers":{"openai":{"adapter":"openai-responses","baseUrl":"https://api.openai.com/v1"}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(path)

	if _, err := runConfigParityWith(t, "", "import", source); err == nil ||
		err.Error() != "import requires --yes" {
		t.Fatalf("import without --yes = %v", err)
	}
	if after, _ := os.ReadFile(path); string(after) != string(before) {
		t.Fatal("a refused import must not write")
	}

	bad := filepath.Join(t.TempDir(), "bad.json")
	if err := os.WriteFile(bad, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := runConfigParityWith(t, "", "import", bad, "--yes"); err == nil {
		t.Fatal("invalid JSON must be rejected")
	}
	if after, _ := os.ReadFile(path); string(after) != string(before) {
		t.Fatal("an invalid import must not write")
	}

	if _, err := runConfigParityWith(t, "", "import", source, "--yes"); err != nil {
		t.Fatal(err)
	}
	out, _ := runConfigParityWith(t, "", "get", "port")
	if strings.TrimSpace(out) != "14000" {
		t.Fatalf("import did not replace the config: get port = %q", out)
	}
}

func TestConfigValidateReadsFileAndStdin(t *testing.T) {
	configHome(t, `{"port":12000,"hostname":"127.0.0.1","defaultProvider":"openai","providers":{"openai":{"adapter":"openai-responses","baseUrl":"https://api.openai.com/v1"}}}`)

	out, err := runConfigParityWith(t, "", "validate")
	if err != nil || !strings.Contains(out, "Config is valid.") {
		t.Fatalf("validate = %q, %v", out, err)
	}

	out, err = runConfigParityWith(t, `{"port":15000,"hostname":"127.0.0.1","defaultProvider":"openai","providers":{"openai":{"adapter":"openai-responses","baseUrl":"https://api.openai.com/v1"}}}`, "validate", "-")
	if err != nil || !strings.Contains(out, "Config is valid.") {
		t.Fatalf("validate - = %q, %v", out, err)
	}

	out, err = runConfigParityWith(t, `{"port":-5,"hostname":"127.0.0.1","defaultProvider":"openai","providers":{"openai":{"adapter":"openai-responses","baseUrl":"https://api.openai.com/v1"}}}`, "validate", "-")
	if err == nil {
		t.Fatalf("an invalid candidate must fail: %q", out)
	}
	if !strings.Contains(out, "Config is invalid") {
		t.Fatalf("validate must report the reason: %q", out)
	}
}

// --source adds the diagnostics envelope rather than replacing the config.
func TestConfigShowSourceAddsDiagnostics(t *testing.T) {
	configHome(t, `{"port":12000,"hostname":"127.0.0.1","defaultProvider":"openai","providers":{"openai":{"adapter":"openai-responses","baseUrl":"https://api.openai.com/v1"}}}`)
	out, err := runConfigParityWith(t, "", "show", "--source")
	if err != nil {
		t.Fatal(err)
	}
	var envelope map[string]any
	if err := json.Unmarshal([]byte(out), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope["source"] != "file" {
		t.Fatalf("source = %#v", envelope["source"])
	}
	if _, hasConfig := envelope["config"]; !hasConfig {
		t.Fatalf("--source must keep the config under its own key: %s", out)
	}
}

// Editing one key must never discard a setting the user wrote. Round-tripping
// the document through the typed config drops unknown members of a KNOWN
// nested object, so the write path keeps the generic document instead.
func TestConfigSetPreservesUnknownNestedSettings(t *testing.T) {
	path := configHome(t, `{"port":12000,"hostname":"127.0.0.1","defaultProvider":"p","providers":{"p":{"adapter":"openai-chat","baseUrl":"http://u"}},"visionSidecar":{"model":"m","futureNested":"KEEPME"},"topLevelUnknown":{"a":1}}`)
	if _, err := runConfigParityWith(t, "", "set", "port", "13000"); err != nil {
		t.Fatal(err)
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, survivor := range []string{"KEEPME", "topLevelUnknown", `"model": "m"`} {
		if !strings.Contains(string(after), survivor) {
			t.Fatalf("set deleted %s: %s", survivor, string(after))
		}
	}
	if !strings.Contains(string(after), "13000") {
		t.Fatalf("set did not apply: %s", string(after))
	}
}

// WriteFile's mode applies only when it creates the file, so exporting over an
// existing world-readable path would leave credentials readable.
func TestConfigExportTightensAnExistingPermissiveFile(t *testing.T) {
	configHome(t, `{"port":12000,"hostname":"127.0.0.1","defaultProvider":"p","providers":{"p":{"adapter":"openai-chat","baseUrl":"http://u","apiKey":"SUPERSECRET"}}}`)
	target := filepath.Join(t.TempDir(), "pre-existing.json")
	if err := os.WriteFile(target, []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := runConfigParityWith(t, "", "export", target); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(target)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("export left mode %v on an existing file; credentials would stay readable", info.Mode().Perm())
	}
}

// Object.hasOwn treats an array index as a real key, so the oracle resolves
// models.0. Refusing it would make a legitimate path look missing.
func TestConfigGetTraversesArrayIndexes(t *testing.T) {
	configHome(t, `{"port":12000,"hostname":"127.0.0.1","defaultProvider":"p","providers":{"p":{"adapter":"openai-chat","baseUrl":"http://u","models":["alpha","beta"]}}}`)
	out, err := runConfigParityWith(t, "", "get", "providers.p.models.1")
	if err != nil || strings.TrimSpace(out) != "beta" {
		t.Fatalf("array index get = %q, %v", out, err)
	}
	if _, err := runConfigParityWith(t, "", "get", "providers.p.models.9"); err == nil {
		t.Fatal("an out-of-range index must not resolve")
	}
}

// A candidate missing providers, or naming one that does not exist, is
// rejected before anything is written.
func TestConfigImportEnforcesTheSchema(t *testing.T) {
	path := configHome(t, `{"port":12000,"hostname":"127.0.0.1","defaultProvider":"p","providers":{"p":{"adapter":"openai-chat","baseUrl":"http://u"}}}`)
	before, _ := os.ReadFile(path)
	for _, candidate := range []string{
		`{"port":12000,"hostname":"127.0.0.1","defaultProvider":"openai"}`,
		`{"port":12000,"hostname":"127.0.0.1","defaultProvider":"missing","providers":{}}`,
	} {
		source := filepath.Join(t.TempDir(), "candidate.json")
		if err := os.WriteFile(source, []byte(candidate), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := runConfigParityWith(t, "", "import", source, "--yes"); err == nil {
			t.Fatalf("%s should have been rejected", candidate)
		}
		if after, _ := os.ReadFile(path); string(after) != string(before) {
			t.Fatalf("a rejected import wrote to disk: %s", candidate)
		}
	}
}

// The oracle's schema supplies a hostname when the document omits one, so a
// TypeScript-written config without it is valid. Validating a zero-valued Go
// struct rejected those with "hostname: must not be blank".
func TestConfigAcceptsADocumentWithoutHostname(t *testing.T) {
	configHome(t, `{"port":10100,"hostname":"127.0.0.1","providers":{"p":{"adapter":"openai-chat","baseUrl":"https://example.com"}},"defaultProvider":"p"}`)
	candidate := filepath.Join(t.TempDir(), "candidate.json")
	document := `{"port":10100,"providers":{"p":{"adapter":"openai-chat","baseUrl":"https://example.com"}},"defaultProvider":"p"}`
	if err := os.WriteFile(candidate, []byte(document), 0o600); err != nil {
		t.Fatal(err)
	}
	out, err := runConfigParityWith(t, "", "validate", candidate)
	if err != nil {
		t.Fatalf("a config without hostname is valid to the oracle: %v", err)
	}
	if !strings.Contains(out, "Config is valid.") {
		t.Fatalf("out = %q", out)
	}
	// The same document must import, which is the path a user actually takes.
	if _, err := runConfigParityWith(t, "", "import", candidate, "--yes"); err != nil {
		t.Fatalf("import rejected a config the oracle accepts: %v", err)
	}
}

// Only strings are masked, and the match is case-insensitive. A numeric or
// object value under a secret-looking key is left alone, exactly as the
// oracle's `typeof value === "string"` guard does.
func TestConfigRedactionAppliesOnlyToStrings(t *testing.T) {
	configHome(t, `{"port":10100,"hostname":"127.0.0.1","defaultProvider":"p","providers":{"p":{"adapter":"openai-chat","baseUrl":"https://example.com","APIKEY":"UPPERSECRET"}},"subagentModels":["m1"]}`)
	out, err := runConfigParityWith(t, "", "show")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out, "UPPERSECRET") {
		t.Fatalf("case-insensitive key was not masked: %s", out)
	}
}

// Every entry point refuses the blocked segments, not just get.
func TestConfigBlocksPrototypeSegmentsEverywhere(t *testing.T) {
	configHome(t, `{"port":10100,"hostname":"127.0.0.1","providers":{"p":{"adapter":"openai-chat","baseUrl":"https://example.com"}},"defaultProvider":"p"}`)
	for _, segment := range []string{"__proto__", "prototype", "constructor"} {
		for _, args := range [][]string{
			{"get", segment + ".x"},
			{"set", segment + ".x", "1"},
			{"unset", segment + ".x"},
		} {
			if _, err := runConfigParityWith(t, "", args...); err == nil {
				t.Fatalf("%v with %q must be refused", args, segment)
			}
		}
	}
}

// The oracle's validateConfigCandidate returns a NORMALIZED config, so a file
// that legitimately omits port still resolves it. Validating without
// materializing the defaults made `config get port` report a missing path for
// a config the TypeScript CLI reads fine.
func TestConfigResolvesSchemaDefaults(t *testing.T) {
	configHome(t, `{"providers":{"openai":{"adapter":"openai-responses","baseUrl":"https://api.openai.com/v1"}}}`)
	out, err := runConfigParityWith(t, "", "get", "port")
	if err != nil || strings.TrimSpace(out) != "10100" {
		t.Fatalf("get port = %q, %v; the schema default must be materialized", out, err)
	}
	// A value the user actually wrote still wins over the default.
	configHome(t, `{"port":12345,"providers":{"openai":{"adapter":"openai-responses","baseUrl":"https://api.openai.com/v1"}}}`)
	out, err = runConfigParityWith(t, "", "get", "port")
	if err != nil || strings.TrimSpace(out) != "12345" {
		t.Fatalf("an explicit value must win: %q %v", out, err)
	}
}

// --source reports where the config came from and, when the file could not be
// used, why. `error` is present either way so a consumer reads one shape.
func TestConfigShowSourceReportsDefaultAndFallback(t *testing.T) {
	decode := func(t *testing.T, out string) map[string]any {
		t.Helper()
		var envelope map[string]any
		if err := json.Unmarshal([]byte(out), &envelope); err != nil {
			t.Fatal(err)
		}
		return envelope
	}

	// No file at all.
	dir := t.TempDir()
	t.Setenv("OPENCODEX_HOME", dir)
	out, err := runConfigParityWith(t, "", "show", "--source")
	if err != nil {
		t.Fatal(err)
	}
	envelope := decode(t, out)
	if envelope["source"] != "default" {
		t.Fatalf("source = %#v, want default", envelope["source"])
	}
	if envelope["error"] != nil {
		t.Fatalf("error = %#v, want null on success", envelope["error"])
	}
	if config, _ := envelope["config"].(map[string]any); config["port"] == nil {
		t.Fatalf("a default config must still be served: %s", out)
	}

	// A file that is not JSON at all.
	configHome(t, "{not json")
	envelope = decode(t, mustRun(t, "show", "--source"))
	if envelope["source"] != "fallback" {
		t.Fatalf("source = %#v, want fallback", envelope["source"])
	}
	if envelope["error"] != "invalid_json" {
		t.Fatalf("error = %#v, want invalid_json", envelope["error"])
	}

	// A file that parses but cannot satisfy the schema.
	configHome(t, `{"providers":{},"defaultProvider":"missing"}`)
	envelope = decode(t, mustRun(t, "show", "--source"))
	if envelope["source"] != "fallback" {
		t.Fatalf("schema-invalid source = %#v, want fallback", envelope["source"])
	}
	if envelope["error"] == nil {
		t.Fatalf("a fallback must report why: %s", out)
	}
}

func mustRun(t *testing.T, args ...string) string {
	t.Helper()
	out, err := runConfigParityWith(t, "", args...)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// Array indexes must be spelled canonically. Object.hasOwn(array, "00") is
// false, so a lenient Atoi would resolve a path the oracle reports as missing.
func TestConfigGetRejectsNonCanonicalArrayIndexes(t *testing.T) {
	configHome(t, `{"port":10100,"hostname":"127.0.0.1","providers":{"p":{"adapter":"openai-chat","baseUrl":"https://example.com"}},"defaultProvider":"p","subagentModels":["m1","m2"]}`)
	if out, err := runConfigParityWith(t, "", "get", "subagentModels.1"); err != nil || strings.TrimSpace(out) != "m2" {
		t.Fatalf("canonical index must resolve: %q %v", out, err)
	}
	// " 1" is deliberately absent: the oracle trims each segment before
	// indexing, so it resolves there too.
	for _, segment := range []string{"00", "+1", "01", "1.0"} {
		if _, err := runConfigParityWith(t, "", "get", "subagentModels."+segment); err == nil {
			t.Fatalf("index %q must not resolve", segment)
		}
	}
}

// `config show` on a fresh home prints the default document verbatim, so its
// FIELD SET is user-visible. The runtime struct carries a few fields the
// oracle's default does not emit, and omits one it does.
func TestConfigDefaultDocumentMatchesTheOracleFieldSet(t *testing.T) {
	document := defaultConfigDocument()
	for _, runtimeOnly := range []string{"hostname", "debug", "log"} {
		if _, present := document[runtimeOnly]; present {
			t.Errorf("default document should not carry the runtime-only %q", runtimeOnly)
		}
	}
	for _, required := range []string{"websockets", "port", "providers", "defaultProvider", "subagentModels"} {
		if _, present := document[required]; !present {
			t.Errorf("default document is missing %q", required)
		}
	}
}

// The oracle's schema declares these fields with .catch(undefined): an invalid
// value is DROPPED with a warning rather than rejecting the file, so one
// hand-edited typo cannot hide every provider and account the user configured.
func TestConfigDegradesInvalidOptionalFieldsWithWarnings(t *testing.T) {
	configHome(t, `{"providers":{"openai":{"adapter":"openai-responses","baseUrl":"https://api.openai.com/v1"}},"injectionModel":123}`)
	out, err := runConfigParityWith(t, "", "show", "--source")
	if err != nil {
		t.Fatal(err)
	}
	var envelope map[string]any
	if err := json.Unmarshal([]byte(out), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope["source"] != "file" {
		t.Fatalf("source = %#v; a degradable field must not send the file to fallback", envelope["source"])
	}
	if envelope["error"] != nil {
		t.Fatalf("error = %#v, want null", envelope["error"])
	}
	warnings, _ := envelope["warnings"].([]any)
	if len(warnings) != 1 || warnings[0] != "injectionModel ignored: expected a string" {
		t.Fatalf("warnings = %#v, want the oracle's wording", envelope["warnings"])
	}
	// The rest of the config survives, which is the point of degrading.
	config, _ := envelope["config"].(map[string]any)
	if providers, _ := config["providers"].(map[string]any); providers["openai"] == nil {
		t.Fatalf("degrading dropped unrelated settings: %s", out)
	}
	if _, kept := config["injectionModel"]; kept {
		t.Fatalf("the invalid field must be dropped: %s", out)
	}
}

// The default document must be the ORACLE's shape, not Go's struct marshalled.
func TestConfigDefaultsMatchTheOracleShape(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENCODEX_HOME", dir)
	out, err := runConfigParityWith(t, "", "show")
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err := json.Unmarshal([]byte(out), &document); err != nil {
		t.Fatal(err)
	}
	// Go's struct marshals these; getDefaultConfig() does not carry them.
	for _, goOnly := range []string{"hostname", "debug", "log", "streamMode"} {
		if _, present := document[goOnly]; present {
			t.Fatalf("%q is a Go-only default the oracle does not emit: %s", goOnly, out)
		}
	}
	// And it does carry this, which Go's zero value drops.
	if value, present := document["websockets"]; !present || value != false {
		t.Fatalf("websockets = %#v, want false as the oracle emits: %s", value, out)
	}
	for _, required := range []string{"port", "providers", "defaultProvider", "subagentModels"} {
		if _, present := document[required]; !present {
			t.Fatalf("default config is missing %q: %s", required, out)
		}
	}
}

// validate and import must degrade exactly as the read path does. Routing only
// reads through the normalizer left both rejecting files the TypeScript CLI
// accepts, and made import persist the raw document rather than the defaulted
// one.
func TestConfigValidateAndImportDegradeLikeTheReadPath(t *testing.T) {
	path := configHome(t, `{"providers":{"openai":{"adapter":"openai-responses","baseUrl":"https://api.openai.com/v1"}}}`)
	candidate := filepath.Join(t.TempDir(), "candidate.json")
	body := `{"providers":{"openai":{"adapter":"openai-responses","baseUrl":"https://api.openai.com/v1"}},"injectionModel":123}`
	if err := os.WriteFile(candidate, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}

	out, err := runConfigParityWith(t, "", "validate", candidate)
	if err != nil || !strings.Contains(out, "Config is valid.") {
		t.Fatalf("validate = %q, %v; a degradable field must not fail validation", out, err)
	}

	if _, err := runConfigParityWith(t, "", "import", candidate, "--yes"); err != nil {
		t.Fatalf("import rejected a config the oracle accepts: %v", err)
	}
	written, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(written), "injectionModel") {
		t.Fatalf("import persisted the invalid field: %s", string(written))
	}
	// The normalized document is saved, so defaults are materialized.
	if !strings.Contains(string(written), `"port"`) {
		t.Fatalf("import saved the raw document rather than the normalized one: %s", string(written))
	}
}

// streamMode degrades, but the oracle reports it only on the console, never in
// the diagnostics envelope.
func TestConfigStreamModeDegradesWithoutADiagnosticsWarning(t *testing.T) {
	configHome(t, `{"providers":{"openai":{"adapter":"openai-responses","baseUrl":"https://api.openai.com/v1"}},"streamMode":"bogus"}`)
	out, err := runConfigParityWith(t, "", "show", "--source")
	if err != nil {
		t.Fatal(err)
	}
	var envelope map[string]any
	if err := json.Unmarshal([]byte(out), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope["source"] != "file" {
		t.Fatalf("source = %#v, want file", envelope["source"])
	}
	if warnings, _ := envelope["warnings"].([]any); len(warnings) != 0 {
		t.Fatalf("warnings = %#v; the oracle does not report streamMode here", warnings)
	}
	if config, _ := envelope["config"].(map[string]any); config["streamMode"] != nil {
		t.Fatalf("the invalid streamMode must still be dropped: %s", out)
	}
}
