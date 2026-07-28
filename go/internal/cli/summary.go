package cli

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
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
			// Array elements go through JS Array.join, NOT the "-" placeholder:
			// join renders null and "" as empty strings, so [null,"","a"] is
			// ", , a". Reusing scalarText here would print "-, -, a".
			scalars = append(scalars, joinText(item))
		default:
			return fmt.Sprintf("%d item(s)", len(items))
		}
	}
	if len(scalars) == 0 {
		return "none"
	}
	return strings.Join(scalars, ", ")
}

// joinText renders one array element the way Array.prototype.join does.
func joinText(value any) string {
	if value == nil {
		return ""
	}
	if text, ok := value.(string); ok {
		return text
	}
	return scalarText(value)
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
		return jsNumberText(typed)
	default:
		encoded, err := json.Marshal(typed)
		if err != nil {
			return fmt.Sprintf("%v", typed)
		}
		return string(encoded)
	}
}

// jsNumberText formats a number the way JavaScript String(number) does.
//
// %f would round 1.23456789 to six decimals and collapse 1e-7 to "0.000000",
// so the shortest round-trip form is used instead. The thresholds are explicit
// because Go and JavaScript disagree about when to switch to exponent form:
// JavaScript uses fixed notation across 1e-6 <= |value| < 1e21 and exponents
// outside it, while Go's %g switches much earlier.
func jsNumberText(value float64) string {
	magnitude := math.Abs(value)
	// String(-0) is "0", not "-0".
	if magnitude == 0 {
		return "0"
	}
	if magnitude >= 1e-6 && magnitude < 1e21 {
		return strconv.FormatFloat(value, 'f', -1, 64)
	}
	formatted := strconv.FormatFloat(value, 'g', -1, 64)
	// Go emits "1e-07"; JavaScript emits "1e-7".
	if index := strings.IndexAny(formatted, "eE"); index != -1 {
		mantissa, exponent := formatted[:index], formatted[index+1:]
		sign := ""
		if exponent != "" && (exponent[0] == '+' || exponent[0] == '-') {
			sign, exponent = string(exponent[0]), exponent[1:]
		}
		exponent = strings.TrimLeft(exponent, "0")
		if exponent == "" {
			exponent = "0"
		}
		if sign == "" {
			sign = "+"
		}
		return mantissa + "e" + sign + exponent
	}
	return formatted
}

// orderedSummaryLines renders sections in the caller's order.
//
// summaryLines sorts keys because a decoded JSON object has no recoverable
// insertion order in Go. When the CALLER knows the order — a status command
// that assembles fixed sections — that ordering is part of the oracle's output
// and must survive.
func orderedSummaryLines(sections [][2]any) []string {
	lines := []string{}
	for _, section := range sections {
		key, _ := section[0].(string)
		lines = append(lines, summaryLinesAt(section[1], key, 1)...)
	}
	return lines
}
