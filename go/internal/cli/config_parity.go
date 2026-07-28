package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/config"
)

const configUsage = `Usage:
  ocx config [show] [--json] [--source]
  ocx config get <dot.path> [--json]
  ocx config set <dot.path> <json-or-string> [--json]
  ocx config unset <dot.path> [--json]
  ocx config validate [path|-] [--json]
  ocx config export <path|->
  ocx config import <path|-> --yes [--json]`

// configDocument is the config as a generic tree, which is what a dot path
// walks. The typed struct cannot represent an arbitrary path.
type configDocument map[string]any

// readConfigDocument loads the config file as a generic tree plus its
// diagnostics, mirroring readConfigDiagnostics: the config plus where it came
// from and, when the file could not be used, why.
type configDiagnostics struct {
	document configDocument
	source   string
	failure  string
	warnings []string
}

func readConfigDiagnostics() (configDiagnostics, error) {
	path, err := configPath()
	if err != nil {
		return configDiagnostics{}, err
	}
	fallback := func(reason string) configDiagnostics {
		// The oracle discards an unusable file and hands back defaults, so
		// show/get/export never surface its contents. That matters beyond
		// tidiness: exporting an unvalidated file would copy whatever
		// credentials it holds into a new location.
		return configDiagnostics{document: defaultConfigDocument(), source: "fallback", failure: reason}
	}
	raw, readErr := os.ReadFile(path)
	if readErr != nil {
		if os.IsNotExist(readErr) {
			return configDiagnostics{document: defaultConfigDocument(), source: "default"}, nil
		}
		return configDiagnostics{}, readErr
	}
	// A BOM is stripped the way the oracle does before parsing.
	var decoded any
	if json.Unmarshal([]byte(strings.TrimPrefix(string(raw), "\ufeff")), &decoded) != nil {
		return fallback("invalid_json"), nil
	}
	record, isObject := decoded.(map[string]any)
	if !isObject {
		return fallback("invalid_json"), nil
	}
	// Degrade before validating: the oracle's schema drops these fields rather
	// than rejecting, so a single bad optional value must not send an
	// otherwise-good file to fallback.
	normalized, warnings, normalizeErr := normalizeConfigCandidate(configDocument(record))
	if normalizeErr == nil {
		return configDiagnostics{document: normalized, source: "file", warnings: warnings}, nil
	}
	// RETRY over the defaults before giving up, the way readConfigDiagnostics
	// does. A file that only omits required keys -- or writes `providers` as
	// an array, which spreads into an empty object -- is repaired by the
	// merge and still counts as `source: "file"`. Skipping this step sent
	// such a file to fallback and hid the settings it did carry.
	//
	// The REPORTED error stays the FIRST failure: the oracle reports the
	// original schema error when even the merged form fails.
	merged, mergedWarnings, mergedErr := normalizeConfigCandidate(mergeConfigDefaults(configDocument(record)))
	if mergedErr == nil {
		return configDiagnostics{document: merged, source: "file", warnings: mergedWarnings}, nil
	}
	return fallback(normalizeErr.Error()), nil
}

// mergeConfigDefaults layers the document over the defaults, mirroring the
// oracle's function of the same name: a shallow spread, plus a second shallow
// spread for `providers` so a partial provider map keeps the built-in entry.
//
// The spread is why a non-object `providers` can survive: JavaScript spreads
// an array into an object with numeric keys, and `{...defaults.providers,
// ...[]}` is simply the defaults.
func mergeConfigDefaults(document configDocument) configDocument {
	merged := map[string]any(defaultConfigDocument())
	for key, value := range document {
		merged[key] = value
	}
	defaultProviders, hasDefaults := defaultConfigDocument()["providers"].(map[string]any)
	if !hasDefaults {
		return configDocument(merged)
	}
	// `raw.providers && typeof raw.providers === "object"` — a number or
	// string fails the typeof test and a null fails the truthiness test, so
	// only an object or an array reaches the spread. Merging a number would
	// silently repair a file the oracle rejects.
	providers, present := document["providers"]
	if !present || providers == nil {
		return configDocument(merged)
	}
	_, isObject := providers.(map[string]any)
	_, isArray := providers.([]any)
	if !isObject && !isArray {
		return configDocument(merged)
	}
	combined := make(map[string]any, len(defaultProviders))
	for name, value := range defaultProviders {
		combined[name] = value
	}
	if record, isObject := providers.(map[string]any); isObject {
		for name, value := range record {
			combined[name] = value
		}
		merged["providers"] = combined
		return configDocument(merged)
	}
	if items, ok := providers.([]any); ok {
		// Spreading an array yields "0", "1", ... keys.
		for index, value := range items {
			combined[fmt.Sprintf("%d", index)] = value
		}
		merged["providers"] = combined
		return configDocument(merged)
	}
	return configDocument(merged)
}

// readConfigDocument is the common case: the effective config and its origin.
func readConfigDocument() (configDocument, string, error) {
	diagnostics, err := readConfigDiagnostics()
	if err != nil {
		return nil, "", err
	}
	return diagnostics.document, diagnostics.source, nil
}

// validateConfigDocument runs the same validation a write would, without
// persisting, so `set` and `import` can refuse an invalid candidate.
func validateConfigDocument(document configDocument) error {
	// The oracle's gate is configSchema, NOT the runtime's admission check.
	// See config_schema.go: Config.Validate rejects values the schema accepts
	// (an unsupported injectionEffort, a blank subagentModels entry), so using
	// it here made `config show` serve defaults for files the TypeScript CLI
	// reads without complaint.
	if err := validateConfigSchema(document); err != nil {
		return usageError("", "%s", err.Error())
	}
	return nil
}

// normalizeConfigDocument validates and returns the document with schema
// defaults MATERIALIZED, the way the oracle's validateConfigCandidate hands
// back a normalized config rather than the raw input.
//
// Without this, a file that legitimately omits `port` validates but then
// `config get port` reports the path as missing, even though the oracle
// resolves it to 10100.
//
// Defaults are layered UNDER the document rather than over it, so a key the
// user actually wrote always wins, and unknown members survive untouched.
func normalizeConfigDocument(document configDocument) (configDocument, error) {
	normalized, _, err := normalizeConfigCandidate(document)
	return normalized, err
}

// normalizeConfigCandidate is the single entry point the oracle's
// validateConfigCandidate corresponds to: degrade the fields its schema
// declares with .catch(undefined), validate what remains, and return the
// NORMALIZED document plus what was dropped.
//
// read, validate and import all go through here. Routing only the read path
// through it left `validate <path>` and `import` rejecting files the
// TypeScript CLI accepts, and made import save the raw document instead of the
// defaulted one.
func normalizeConfigCandidate(document configDocument) (configDocument, []string, error) {
	malformed := malformedNativeSubagentFields(document)
	warnings := degradeInvalidFields(document)
	if reason := normalizeNativeSubagentSync(document, malformed); reason != "" {
		warnings = append(warnings, "syncCodexSubagentDefaults ignored: "+reason)
	}
	normalized, err := normalizeValidatedDocument(document)
	if err != nil {
		return nil, warnings, err
	}
	return normalized, warnings, nil
}

func normalizeValidatedDocument(document configDocument) (configDocument, error) {
	if err := validateConfigDocument(document); err != nil {
		return nil, err
	}
	base := map[string]any(defaultConfigDocument())
	for key, value := range document {
		base[key] = value
	}
	return configDocument(base), nil
}

// saveConfigDocument writes the VALIDATED GENERIC document, not a typed
// round-trip of it.
//
// Marshalling through config.Config loses any unknown member of a known
// nested object: the root and provider structs carry passthrough fields, but
// something like visionSidecar does not, so `config set port 13000` would
// silently delete visionSidecar.futureNested. Editing one key must never
// discard a setting the user wrote.
//
// The write mirrors config.Save's durability: private temp file in the same
// directory, fsync, atomic rename.
func saveConfigDocument(document configDocument) error {
	path, err := configPath()
	if err != nil {
		return err
	}
	if err := validateConfigDocument(document); err != nil {
		return err
	}
	encoded, err := json.MarshalIndent(map[string]any(document), "", "  ")
	if err != nil {
		return err
	}
	encoded = append(encoded, '\n')

	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create config directory: %w", err)
	}
	temp, err := os.CreateTemp(dir, ".config-*.tmp")
	if err != nil {
		return fmt.Errorf("create temporary config: %w", err)
	}
	tempPath := temp.Name()
	committed := false
	defer func() {
		_ = temp.Close()
		if !committed {
			_ = os.Remove(tempPath)
		}
	}()
	if err := temp.Chmod(0o600); err != nil {
		return fmt.Errorf("protect temporary config: %w", err)
	}
	if _, err := temp.Write(encoded); err != nil {
		return fmt.Errorf("write temporary config: %w", err)
	}
	if err := temp.Sync(); err != nil {
		return fmt.Errorf("sync temporary config: %w", err)
	}
	if err := temp.Close(); err != nil {
		return fmt.Errorf("close temporary config: %w", err)
	}
	if err := os.Rename(tempPath, path); err != nil {
		return fmt.Errorf("replace config: %w", err)
	}
	committed = true
	return nil
}

// readConfigInput reads a candidate from a file or, for "-", from stdin.
func readConfigInput(source string, stdin io.Reader) (configDocument, error) {
	var raw []byte
	var err error
	if source == "-" {
		if stdin == nil {
			stdin = os.Stdin
		}
		raw, err = io.ReadAll(stdin)
	} else {
		raw, err = os.ReadFile(source)
	}
	if err != nil {
		return nil, err
	}
	var decoded any
	if json.Unmarshal([]byte(strings.TrimPrefix(string(raw), "\ufeff")), &decoded) != nil {
		return nil, usageError("", "invalid JSON in %s", source)
	}
	record, isObject := decoded.(map[string]any)
	if !isObject {
		return nil, usageError("", "invalid JSON in %s", source)
	}
	return configDocument(record), nil
}

// runConfigParity implements the oracle's config surface. The legacy
// fixed-key form stays reachable through runConfig for compatibility.
func runConfigParity(ctx context.Context, args []string, streams IO) error {
	rest := append([]string{}, args...)
	action := "show"
	if len(rest) > 0 {
		action = strings.ToLower(rest[0])
		rest = rest[1:]
	}
	wantsJSON := takeFlag(&rest, "--json")

	switch action {
	case "show":
		source := takeFlag(&rest, "--source")
		if err := rejectArgs(rest, configUsage, false); err != nil {
			return err
		}
		diagnostics, err := readConfigDiagnostics()
		if err != nil {
			return err
		}
		redacted := redactConfigValue(map[string]any(diagnostics.document), "")
		if !source {
			// show always prints JSON: the oracle passes true for wantsJson.
			return printData(streams, redacted, true, nil)
		}
		// `error` is present either way, null on success, so a consumer can
		// read one shape rather than test for the key.
		var failure any
		if diagnostics.failure != "" {
			failure = diagnostics.failure
		}
		return printData(streams, map[string]any{
			"config":   redacted,
			"source":   diagnostics.source,
			"error":    failure,
			"warnings": warningList(diagnostics.warnings),
		}, true, nil)

	case "get":
		if len(rest) == 0 {
			return usageError(configUsage, "config path is required")
		}
		path := rest[0]
		rest = rest[1:]
		if err := rejectArgs(rest, configUsage, false); err != nil {
			return err
		}
		document, _, err := readConfigDocument()
		if err != nil {
			return err
		}
		value, err := getConfigPath(map[string]any(document), path)
		if err != nil {
			return err
		}
		segments, err := configPathSegments(path)
		if err != nil {
			return err
		}
		value = redactConfigValue(value, segments[len(segments)-1])
		if wantsJSON {
			return printData(streams, value, true, nil)
		}
		text, err := formatConfigValue(value)
		if err != nil {
			return err
		}
		_, err = fmt.Fprintln(streams.Out, text)
		return err

	case "set", "unset":
		if len(rest) == 0 {
			return usageError(configUsage, "config path and value are required")
		}
		path := rest[0]
		rest = rest[1:]
		var parsed any
		if action == "set" {
			if len(rest) == 0 {
				return usageError(configUsage, "config path and value are required")
			}
			parsed = parseConfigValue(rest[0])
			rest = rest[1:]
		}
		if err := rejectArgs(rest, configUsage, false); err != nil {
			return err
		}
		document, _, err := readConfigDocument()
		if err != nil {
			return err
		}
		if err := setConfigPath(map[string]any(document), path, parsed, action == "unset"); err != nil {
			return err
		}
		if err := validateConfigDocument(document); err != nil {
			return err
		}
		if err := saveConfigDocument(document); err != nil {
			return err
		}
		var saved any
		if action == "set" {
			if value, getErr := getConfigPath(map[string]any(document), path); getErr == nil {
				segments, _ := configPathSegments(path)
				saved = redactConfigValue(value, segments[len(segments)-1])
			}
		}
		verb := "Set"
		if action == "unset" {
			verb = "Unset"
		}
		return printData(streams, map[string]any{"ok": true, "path": path, "value": saved},
			wantsJSON, []string{fmt.Sprintf("%s %s.", verb, path)})

	case "validate":
		source := ""
		if len(rest) > 0 {
			source = rest[0]
			rest = rest[1:]
		}
		if err := rejectArgs(rest, configUsage, false); err != nil {
			return err
		}
		document := configDocument{}
		if source != "" {
			loaded, err := readConfigInput(source, streams.In)
			if err != nil {
				return err
			}
			document = loaded
		} else {
			loaded, _, err := readConfigDocument()
			if err != nil {
				return err
			}
			document = loaded
		}
		// Degrade first, exactly as the read path does: a file the oracle
		// accepts with a dropped field must validate here too.
		if _, _, err := normalizeConfigCandidate(document); err != nil {
			// Invalid config is a reported result, not a crash: the oracle
			// prints the reason and exits 1.
			if printErr := printData(streams, map[string]any{"ok": false, "error": err.Error()},
				wantsJSON, []string{"Config is invalid: " + err.Error()}); printErr != nil {
				return printErr
			}
			return errSilentFailure
		}
		reported := source
		if reported == "" {
			reported, _ = configPath()
		}
		return printData(streams, map[string]any{"ok": true, "source": reported},
			wantsJSON, []string{"Config is valid."})

	case "export":
		if len(rest) == 0 {
			return usageError(configUsage, "export path is required")
		}
		target := rest[0]
		rest = rest[1:]
		if err := rejectArgs(rest, configUsage, false); err != nil {
			return err
		}
		document, _, err := readConfigDocument()
		if err != nil {
			return err
		}
		// Export is a BACKUP, so it is deliberately not redacted -- a masked
		// copy could not be imported back. It is written 0600 for that reason.
		encoded, err := json.MarshalIndent(map[string]any(document), "", "  ")
		if err != nil {
			return err
		}
		encoded = append(encoded, '\n')
		if target == "-" {
			_, err = streams.Out.Write(encoded)
			return err
		}
		// WriteFile's mode applies only when it CREATES the file, so exporting
		// over an existing world-readable path would leave credentials
		// readable. Chmod unconditionally.
		if err := os.WriteFile(target, encoded, 0o600); err != nil {
			return err
		}
		if err := os.Chmod(target, 0o600); err != nil {
			return fmt.Errorf("protect exported config: %w", err)
		}
		_, err = fmt.Fprintf(streams.Out, "Exported config to %s.\n", target)
		return err

	case "import":
		if len(rest) == 0 {
			return usageError(configUsage, "import path is required")
		}
		source := rest[0]
		rest = rest[1:]
		yes := takeFlag(&rest, "--yes")
		if !yes {
			return usageError(configUsage, "import requires --yes")
		}
		if err := rejectArgs(rest, configUsage, false); err != nil {
			return err
		}
		document, err := readConfigInput(source, streams.In)
		if err != nil {
			return err
		}
		// Save the NORMALIZED candidate, not the raw one: import must persist
		// the same defaulted, degraded document the oracle would have written.
		normalized, _, err := normalizeConfigCandidate(document)
		if err != nil {
			return err
		}
		if err := saveConfigDocument(normalized); err != nil {
			return err
		}
		return printData(streams, map[string]any{"ok": true, "source": source}, wantsJSON,
			[]string{fmt.Sprintf("Imported config from %s. Restart or run ocx sync if needed.", source)})
	}
	return usageError(configUsage, "unknown config command %s", action)
}

// errSilentFailure marks a failure the command has ALREADY reported, so Run
// exits non-zero without printing a second "Error:" line over the top of it.
var errSilentFailure = errors.New("reported failure")

// defaultConfigDocument is the generic form of the built-in default config.
//
// The oracle answers an absent or unusable config with getDefaultConfig()
// rather than an empty object, so `validate` succeeds on a fresh home and
// `get providers.openai.adapter` resolves before the user has written anything.
func defaultConfigDocument() configDocument {
	// Built from FreshInstall, then reconciled with the oracle's
	// getDefaultConfig() SHAPE.
	//
	// The two are not the same document. Go's struct marshals hostname, debug
	// and log that the oracle omits, and the oracle carries websockets:false
	// that Go's zero value drops. Serving or persisting the Go shape would
	// write a config the TypeScript CLI did not produce, so the extras are
	// removed and the missing key restored.
	defaults := config.FreshInstall()
	encoded, err := json.Marshal(defaults)
	if err != nil {
		return configDocument{}
	}
	var document map[string]any
	if json.Unmarshal(encoded, &document) != nil {
		return configDocument{}
	}
	for _, goOnly := range []string{"hostname", "debug", "log", "streamMode"} {
		delete(document, goOnly)
	}
	if _, present := document["websockets"]; !present {
		document["websockets"] = false
	}
	return configDocument(document)
}

// degradableFields are the schema entries the oracle declares with
// `.catch(undefined)`: an invalid value is DROPPED with a warning rather than
// rejecting the whole file, so one hand-edited typo cannot hide every provider
// and account the user has configured.
var degradableFields = map[string]string{
	"injectionModel":            "a string",
	"injectionEffort":           "a string",
	"streamMode":                "a string",
	"syncCodexSubagentDefaults": "a boolean",
}

// degradeInvalidFields removes malformed optional fields and reports what it
// dropped, in the oracle's wording.
// diagnosticsReportedFields are the degradable fields whose removal the
// oracle surfaces in readConfigDiagnostics().warnings. streamMode degrades
// too, but the oracle reports THAT one only on the console
// (warnDegradedStreamMode), never in the diagnostics envelope, so adding it
// here would put a warning in --source that the TypeScript CLI does not.
var diagnosticsReportedFields = map[string]bool{
	"injectionModel":            true,
	"injectionEffort":           true,
	"syncCodexSubagentDefaults": true,
	"streamMode":                false,
}

func degradeInvalidFields(document configDocument) []string {
	warnings := []string{}
	for _, field := range []string{"injectionModel", "injectionEffort", "streamMode", "syncCodexSubagentDefaults"} {
		value, present := document[field]
		if !present || value == nil {
			continue
		}
		expected := degradableFields[field]
		valid := false
		switch typed := value.(type) {
		case string:
			valid = expected == "a string"
			if field == "streamMode" && valid {
				valid = typed == "auto" || typed == "legacy-tee" || typed == "eager-relay"
			}
		case bool:
			valid = expected == "a boolean"
		}
		if !valid {
			delete(document, field)
			if diagnosticsReportedFields[field] {
				warnings = append(warnings, field+" ignored: expected "+expected)
			}
		}
	}
	return warnings
}

// warningList renders warnings as a JSON array, empty rather than null when
// there are none.
func warningList(warnings []string) []any {
	out := make([]any, 0, len(warnings))
	for _, warning := range warnings {
		out = append(out, warning)
	}
	return out
}

// codexReasoningEfforts is the Codex reasoning ladder, matching
// src/reasoning-effort.ts.
var codexReasoningEfforts = map[string]struct{}{
	"low": {}, "medium": {}, "high": {}, "xhigh": {}, "max": {}, "ultra": {},
}

// normalizeNativeSubagentSync applies the oracle's disable-with-warning rule
// for syncCodexSubagentDefaults.
//
// The opt-in only means anything with a usable injectionModel, so an
// unsatisfiable one is REMOVED and reported rather than rejecting the file.
// Rejecting would hide every provider and account the user has configured
// behind a single unusable toggle; leaving it set would claim a sync that
// cannot happen.
//
// The reason order matches the oracle's, because the first applicable one is
// the message the user sees.
func normalizeNativeSubagentSync(document configDocument, malformed map[string]bool) string {
	enabled, _ := document["syncCodexSubagentDefaults"].(bool)
	if !enabled {
		return ""
	}
	reason := ""
	switch {
	case malformed["injectionModel"]:
		reason = "injectionModel must be a string"
	case strings.TrimSpace(stringField(document, "injectionModel")) == "":
		reason = "a nonblank injectionModel is required"
	case malformed["injectionEffort"]:
		reason = "injectionEffort must be a string or omitted"
	default:
		if effort, present := document["injectionEffort"]; present && effort != nil {
			text, isString := effort.(string)
			if _, known := codexReasoningEfforts[text]; !isString || !known {
				reason = "injectionEffort must be a supported Codex reasoning effort"
			}
		}
	}
	if reason == "" {
		return ""
	}
	delete(document, "syncCodexSubagentDefaults")
	return reason
}

func stringField(document configDocument, key string) string {
	text, _ := document[key].(string)
	return text
}

// malformedNativeSubagentFields records which native-subagent fields were the
// wrong TYPE before degradation removed them, because the disable reason
// distinguishes "wrong type" from "absent".
func malformedNativeSubagentFields(document configDocument) map[string]bool {
	malformed := map[string]bool{}
	for field, expected := range map[string]string{
		"injectionModel":            "a string",
		"injectionEffort":           "a string",
		"syncCodexSubagentDefaults": "a boolean",
	} {
		value, present := document[field]
		if !present || value == nil {
			continue
		}
		switch value.(type) {
		case string:
			malformed[field] = expected != "a string"
		case bool:
			malformed[field] = expected != "a boolean"
		default:
			malformed[field] = true
		}
	}
	return malformed
}
