package cli

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// summaryLines renders a management payload as flat "key: value" lines.
//
// Mirrors src/cli/runtime-api.ts summaryLines: descend one level, join scalar
// arrays, count non-scalar ones, and show an em-dash placeholder for empty
// values so a missing setting is visibly missing rather than blank.
func summaryLines(value any) []string {
	return summaryLinesAt(value, "", 0)
}

func summaryLinesAt(value any, prefix string, depth int) []string {
	record, ok := value.(map[string]any)
	if !ok || value == nil || depth > 1 {
		label := prefix
		if label == "" {
			label = "value"
		}
		return []string{fmt.Sprintf("%s: %s", label, scalarText(value))}
	}
	// Go randomizes map iteration; the oracle walks insertion order. Sorting
	// keeps the output stable so a test can assert it and a user reading two
	// runs sees the same shape.
	keys := make([]string, 0, len(record))
	for key := range record {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	lines := []string{}
	for _, key := range keys {
		child := record[key]
		label := key
		if prefix != "" {
			label = prefix + "." + key
		}
		switch typed := child.(type) {
		case []any:
			lines = append(lines, fmt.Sprintf("%s: %s", label, arrayText(typed)))
		case map[string]any:
			if depth < 1 {
				lines = append(lines, summaryLinesAt(typed, label, depth+1)...)
				continue
			}
			lines = append(lines, fmt.Sprintf("%s: %s", label, scalarText(child)))
		default:
			lines = append(lines, fmt.Sprintf("%s: %s", label, scalarText(child)))
		}
	}
	return lines
}

func arrayText(items []any) string {
	scalars := make([]string, 0, len(items))
	for _, item := range items {
		switch item.(type) {
		case nil, string, float64, bool, json.Number:
			scalars = append(scalars, scalarText(item))
		default:
			return fmt.Sprintf("%d item(s)", len(items))
		}
	}
	if len(scalars) == 0 {
		return "none"
	}
	return strings.Join(scalars, ", ")
}

// scalarText formats one value, collapsing null/empty to "-" the way the oracle
// does so an unset field reads as unset instead of as an empty line.
func scalarText(value any) string {
	switch typed := value.(type) {
	case nil:
		return "-"
	case string:
		if typed == "" {
			return "-"
		}
		return typed
	case bool:
		return fmt.Sprintf("%t", typed)
	case float64:
		// JSON numbers decode as float64; render integers without a ".0" tail
		// so a port number reads as 10100, not 10100.0.
		if typed == float64(int64(typed)) {
			return fmt.Sprintf("%d", int64(typed))
		}
		return strings.TrimRight(strings.TrimRight(fmt.Sprintf("%f", typed), "0"), ".")
	default:
		encoded, err := json.Marshal(typed)
		if err != nil {
			return fmt.Sprintf("%v", typed)
		}
		return string(encoded)
	}
}
