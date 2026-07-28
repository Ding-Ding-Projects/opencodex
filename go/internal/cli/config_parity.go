package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
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
			return configDocument{}, "default", nil
		}
		return nil, "", readErr
	}
	// A BOM is stripped the way the oracle does before parsing.
	trimmed := strings.TrimPrefix(string(raw), "\ufeff")
	var decoded any
	if json.Unmarshal([]byte(trimmed), &decoded) != nil {
		return configDocument{}, "fallback", nil
	}
	record, isObject := decoded.(map[string]any)
	if !isObject {
		return configDocument{}, "fallback", nil
	}
	return configDocument(record), "file", nil
}

// validateConfigDocument runs the same validation a write would, without
// persisting, so `set` and `import` can refuse an invalid candidate.
func validateConfigDocument(document configDocument) error {
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

func saveConfigDocument(document configDocument) error {
	path, err := configPath()
	if err != nil {
		return err
	}
	encoded, err := json.Marshal(document)
	if err != nil {
		return err
	}
	var candidate config.Config
	if err := json.Unmarshal(encoded, &candidate); err != nil {
		return err
	}
	return config.Save(path, &candidate)
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
	if json.Unmarshal(raw, &decoded) != nil {
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
			return errConfigInvalid
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
		if err := os.WriteFile(target, encoded, 0o600); err != nil {
			return err
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
	return usageError(configUsage, "unknown config subcommand %q", action)
}

// errConfigInvalid marks a reported-but-failed validation so Run can exit 1
// without printing a second error line.
var errConfigInvalid = fmt.Errorf("config is invalid")
