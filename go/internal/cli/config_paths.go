package cli

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// secretKeyPattern names the fields whose STRING values are masked before a
// config is printed. Matching is case-insensitive, mirroring the oracle's /i.
var secretKeyPattern = regexp.MustCompile(`(?i)^(apiKey|key|accessToken|refreshToken|idToken|token|password|clientSecret)$`)

// blockedSegments are refused in a dot path. Go has no prototype chain, but
// accepting these would let a user write keys the TypeScript CLI refuses,
// producing a config it then cannot edit.
var blockedSegments = map[string]struct{}{"__proto__": {}, "prototype": {}, "constructor": {}}

// redactConfigValue masks secret-named string fields, recursively.
//
// An EMPTY string is left alone on purpose: masking it would read as "a
// credential is set" when none is.
func redactConfigValue(value any, key string) any {
	if text, isString := value.(string); isString && secretKeyPattern.MatchString(key) {
		if text == "" {
			return text
		}
		return "********"
	}
	switch typed := value.(type) {
	case []any:
		out := make([]any, len(typed))
		for index, item := range typed {
			// Array elements inherit no key, so a bare secret inside a list is
			// not masked -- same as the oracle.
			out[index] = redactConfigValue(item, "")
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(typed))
		for childKey, child := range typed {
			out[childKey] = redactConfigValue(child, childKey)
		}
		return out
	}
	return value
}

// configPathSegments splits a dot path, rejecting empty and blocked segments.
func configPathSegments(path string) ([]string, error) {
	segments := []string{}
	for _, part := range strings.Split(path, ".") {
		trimmed := strings.TrimSpace(part)
		if trimmed == "" {
			continue
		}
		if _, blocked := blockedSegments[trimmed]; blocked {
			return nil, usageError(configUsage, "invalid config path")
		}
		segments = append(segments, trimmed)
	}
	if len(segments) == 0 {
		return nil, usageError(configUsage, "invalid config path")
	}
	return segments, nil
}

// getConfigPath walks a decoded config to the value at path.
func getConfigPath(root any, path string) (any, error) {
	segments, err := configPathSegments(path)
	if err != nil {
		return nil, err
	}
	current := root
	for _, segment := range segments {
		record, isObject := current.(map[string]any)
		if !isObject {
			return nil, usageError("", "config path not found: %s", path)
		}
		value, present := record[segment]
		if !present {
			return nil, usageError("", "config path not found: %s", path)
		}
		current = value
	}
	return current, nil
}

// setConfigPath assigns or removes the value at path.
//
// Missing parents are NOT created. The oracle rejects them, so creating them
// here would produce a config the TypeScript CLI refuses to write.
func setConfigPath(root map[string]any, path string, value any, remove bool) error {
	segments, err := configPathSegments(path)
	if err != nil {
		return err
	}
	current := root
	for _, segment := range segments[:len(segments)-1] {
		next, present := current[segment]
		if !present {
			return usageError(configUsage, "config parent path not found: %s", segment)
		}
		record, isObject := next.(map[string]any)
		if !isObject {
			// An array is explicitly not a traversable parent in the oracle.
			return usageError(configUsage, "config parent path not found: %s", segment)
		}
		current = record
	}
	leaf := segments[len(segments)-1]
	if remove {
		if _, present := current[leaf]; !present {
			return usageError("", "config path not found: %s", path)
		}
		delete(current, leaf)
		return nil
	}
	current[leaf] = value
	return nil
}

// parseConfigValue reads a value as JSON, falling back to the literal string.
// That is what lets `config set a.b hello` work without quoting.
func parseConfigValue(raw string) any {
	var decoded any
	if json.Unmarshal([]byte(raw), &decoded) == nil {
		return decoded
	}
	return raw
}

// sortedKeys is used where the oracle relies on object key order it does not
// itself control.
func sortedKeys(record map[string]any) []string {
	keys := make([]string, 0, len(record))
	for key := range record {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// formatConfigValue renders a leaf for the human path: objects and arrays as
// indented JSON, scalars bare, matching the oracle's typeof check.
func formatConfigValue(value any) (string, error) {
	switch value.(type) {
	case map[string]any, []any, nil:
		encoded, err := json.MarshalIndent(value, "", "  ")
		if err != nil {
			return "", err
		}
		return string(encoded), nil
	}
	return fmt.Sprint(scalarText(value)), nil
}
