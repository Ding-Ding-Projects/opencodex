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
// diagnostics, mirroring readConfigDiagnostics.
func readConfigDocument() (document configDocument, source string, loadErr error) {
	path, err := configPath()
	if err != nil {
		return nil, "", err
	}
	raw, readErr := os.ReadFile(path)
	if readErr != nil {
		if os.IsNotExist(readErr) {
			return defaultConfigDocument(), "default", nil
		}
		return nil, "", readErr
	}
	// A BOM is stripped the way the oracle does before parsing.
	trimmed := strings.TrimPrefix(string(raw), "\ufeff")
	var decoded any
	if json.Unmarshal([]byte(trimmed), &decoded) != nil {
		return defaultConfigDocument(), "fallback", nil
	}
	record, isObject := decoded.(map[string]any)
	if !isObject {
		return defaultConfigDocument(), "fallback", nil
	}
	// NOTE: the oracle also downgrades a schema-invalid file to "fallback" and
	// serves defaults instead. Routing this through validateConfigDocument does
	// NOT reproduce that: Go's Config.Validate is stricter than the oracle's
	// schema (it requires providers.*.adapter, which the schema defaults), so
	// it rejects files the TypeScript CLI accepts. Reusing it here made `show`
	// serve defaults for an ordinary valid config. Matching the oracle needs a
	// schema-shaped validator, which belongs with the config-schema work rather
	// than in this CLI slice.
	return configDocument(record), "file", nil
}

// validateConfigDocument runs the same validation a write would, without
// persisting, so `set` and `import` can refuse an invalid candidate.
func validateConfigDocument(document configDocument) error {
	// Structural rules the typed decode cannot express. A missing `providers`
	// unmarshals to a nil map and a dangling `defaultProvider` decodes fine,
	// so without these an import would write `"providers": null` that the
	// oracle rejects outright.
	providersValue, hasProviders := document["providers"]
	if !hasProviders || providersValue == nil {
		return usageError("", "schema_invalid: providers: Invalid input: expected record, received undefined")
	}
	providers, isObject := providersValue.(map[string]any)
	if !isObject {
		return usageError("", "schema_invalid: providers: Invalid input: expected record")
	}
	if selected, present := document["defaultProvider"]; present {
		name, isString := selected.(string)
		if !isString {
			return usageError("", "schema_invalid: defaultProvider: expected string")
		}
		// No exemption for "openai": the oracle rejects it too when it is
		// absent from providers.
		if _, known := providers[name]; !known {
			return usageError("", "schema_invalid: defaultProvider: defaultProvider must exist in providers")
		}
	}
	encoded, err := json.Marshal(document)
	if err != nil {
		return err
	}
	var candidate config.Config
	if err := json.Unmarshal(encoded, &candidate); err != nil {
		return usageError("", "%s", err.Error())
	}
	return candidate.Validate()
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
		document, origin, err := readConfigDocument()
		if err != nil {
			return err
		}
		redacted := redactConfigValue(map[string]any(document), "")
		if !source {
			// show always prints JSON: the oracle passes true for wantsJson.
			return printData(streams, redacted, true, nil)
		}
		return printData(streams, map[string]any{
			"config": redacted, "source": origin, "warnings": []any{},
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
		if err := validateConfigDocument(document); err != nil {
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
		if err := validateConfigDocument(document); err != nil {
			return err
		}
		if err := saveConfigDocument(document); err != nil {
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
	// FreshInstall, not Default: Default is the minimal construction baseline
	// with an EMPTY providers map, so a document built from it fails its own
	// defaultProvider check. FreshInstall is the TypeScript-compatible config a
	// new installation gets, which is what getDefaultConfig() returns.
	defaults := config.FreshInstall()
	encoded, err := json.Marshal(defaults)
	if err != nil {
		return configDocument{}
	}
	var document map[string]any
	if json.Unmarshal(encoded, &document) != nil {
		return configDocument{}
	}
	return configDocument(document)
}
