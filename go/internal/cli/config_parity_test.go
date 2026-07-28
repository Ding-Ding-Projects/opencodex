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
