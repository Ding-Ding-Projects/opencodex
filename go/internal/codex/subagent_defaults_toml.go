package codex

// The TOML shape recognition behind the managed-defaults transform.
//
// Everything here answers one question: can this document be edited without
// guessing? When the answer is no, the caller refuses rather than writing.

import (
	"regexp"
	"strconv"
	"strings"
)

const keySegment = `(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')`

var (
	exactTableHeader   = regexp.MustCompile(`^\s*\[\s*(` + keySegment + `)\s*\]\s*(?:#.*)?$`)
	arrayTableHeader   = regexp.MustCompile(`^\s*\[\[\s*(` + keySegment + `)\s*\]\]\s*(?:#.*)?$`)
	dottedTableHeader  = regexp.MustCompile(`^\s*\[\[?\s*(` + keySegment + `)\s*\.\s*(` + keySegment + `)(?:\s*\.|\s*\]\]?)`)
	keyAssignment      = regexp.MustCompile(`^\s*(` + keySegment + `)\s*=`)
	dottedAssignment   = regexp.MustCompile(`^\s*(` + keySegment + `)\s*\.\s*(` + keySegment + `)(?:\s*\.|\s*=)`)
	anyTableHeader     = regexp.MustCompile(`^\s*\[{1,2}`)
	managedStringValue = regexp.MustCompile(`^(\s*)(` + keySegment + `)(\s*=\s*)("(?:\\.|[^"\\])*"|'[^']*')(\s*(?:#.*)?)$`)
	basicKeyEscape     = regexp.MustCompile(`\\(x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|.)`)
)

// decodeTomlBasicKey resolves escapes so a quoted key compares equal to the
// bare spelling of the same name.
func decodeTomlBasicKey(body string) string {
	return basicKeyEscape.ReplaceAllStringFunc(body, func(whole string) string {
		escape := whole[1:]
		switch escape[0] {
		case 'x', 'u':
			value, err := strconv.ParseUint(escape[1:], 16, 32)
			if err != nil {
				return whole
			}
			return string(rune(value))
		case 'U':
			value, err := strconv.ParseUint(escape[1:], 16, 32)
			if err != nil || value > 0x10ffff {
				return whole
			}
			return string(rune(value))
		}
		switch escape {
		case "b":
			return "\b"
		case "t":
			return "\t"
		case "n":
			return "\n"
		case "f":
			return "\f"
		case "r":
			return "\r"
		case `"`:
			return `"`
		case `\`:
			return `\`
		}
		return whole
	})
}

func canonicalKeySegment(raw string) string {
	if strings.HasPrefix(raw, `"`) {
		return decodeTomlBasicKey(raw[1 : len(raw)-1])
	}
	if strings.HasPrefix(raw, "'") {
		return raw[1 : len(raw)-1]
	}
	return raw
}

func lineAt(lines []sourceLine, index int) (sourceLine, bool) {
	if index < 0 || index >= len(lines) {
		return sourceLine{}, false
	}
	return lines[index], true
}

func exactAgentsHeader(lines []sourceLine, index int) bool {
	line, ok := lineAt(lines, index)
	if !ok || !line.structural {
		return false
	}
	match := exactTableHeader.FindStringSubmatch(line.text)
	return match != nil && canonicalKeySegment(match[1]) == "agents"
}

func arrayAgentsHeader(line sourceLine) bool {
	if !line.structural {
		return false
	}
	match := arrayTableHeader.FindStringSubmatch(line.text)
	return match != nil && canonicalKeySegment(match[1]) == "agents"
}

// dottedAgentsHeader returns the second segment of an [agents.x] header.
func dottedAgentsHeader(line sourceLine) (string, bool) {
	if !line.structural {
		return "", false
	}
	match := dottedTableHeader.FindStringSubmatch(line.text)
	if match == nil || canonicalKeySegment(match[1]) != "agents" {
		return "", false
	}
	return canonicalKeySegment(match[2]), true
}

func isAnyTableHeader(line sourceLine) bool {
	return line.structural && anyTableHeader.MatchString(line.text)
}

func assignmentKeyAt(line sourceLine) string {
	if !line.structural {
		return ""
	}
	match := keyAssignment.FindStringSubmatch(line.text)
	if match == nil {
		return ""
	}
	return canonicalKeySegment(match[1])
}

func markerLine(lines []sourceLine, index int, marker string) bool {
	line, ok := lineAt(lines, index)
	return ok && line.structural && strings.TrimSpace(line.text) == marker
}

func targetKeyAt(lines []sourceLine, index int) string {
	line, ok := lineAt(lines, index)
	if !ok {
		return ""
	}
	key := assignmentKeyAt(line)
	for _, target := range targetKeys {
		if key == target {
			return key
		}
	}
	return ""
}

func dottedAssignmentAt(line sourceLine) (string, string, bool) {
	if !line.structural {
		return "", "", false
	}
	match := dottedAssignment.FindStringSubmatch(line.text)
	if match == nil {
		return "", "", false
	}
	return canonicalKeySegment(match[1]), canonicalKeySegment(match[2]), true
}

func isTargetKey(key string) bool {
	for _, target := range targetKeys {
		if key == target {
			return true
		}
	}
	return false
}

// analyzeToml decides whether the document can be edited safely, and where.
//
// Every error here is a REFUSAL, not a failure: each describes a shape where
// the transform would have to guess which occurrence is the real one, and
// guessing wrong means silently rewriting a value the user set.
func analyzeToml(lines []sourceLine) (tomlShape, string) {
	exactHeaders := []int{}
	for index, line := range lines {
		switch {
		case exactAgentsHeader(lines, index):
			exactHeaders = append(exactHeaders, index)
		case arrayAgentsHeader(line):
			return tomlShape{}, "array [[agents]] tables are not supported for managed subagent defaults"
		default:
			if second, ok := dottedAgentsHeader(line); ok && isTargetKey(second) {
				return tomlShape{}, "agents default keys cannot be represented as nested tables"
			}
		}
	}
	if len(exactHeaders) > 1 {
		return tomlShape{}, "duplicate [agents] tables cannot be updated safely"
	}

	// Root-level dotted or inline forms of the same keys would take effect
	// alongside anything written into the table.
	rootEnd := len(lines)
	for index, line := range lines {
		if isAnyTableHeader(line) {
			rootEnd = index
			break
		}
	}
	for index := 0; index < rootEnd; index++ {
		if first, second, ok := dottedAssignmentAt(lines[index]); ok && first == "agents" && isTargetKey(second) {
			return tomlShape{}, "dotted agents default keys are not supported for managed subagent defaults"
		}
		if assignmentKeyAt(lines[index]) == "agents" {
			return tomlShape{}, "inline agents definitions cannot be updated safely"
		}
	}

	shape := tomlShape{agentsHeader: -1, agentsEnd: -1, definitions: map[string]targetDefinition{}}
	if len(exactHeaders) == 1 {
		shape.agentsHeader = exactHeaders[0]
		shape.agentsEnd = len(lines)
		for index := shape.agentsHeader + 1; index < len(lines); index++ {
			if isAnyTableHeader(lines[index]) {
				shape.agentsEnd = index
				break
			}
			if first, _, ok := dottedAssignmentAt(lines[index]); ok && isTargetKey(first) {
				return tomlShape{}, "dotted agents." + first + " fields are not supported"
			}
			key := targetKeyAt(lines, index)
			if key == "" {
				continue
			}
			if _, duplicate := shape.definitions[key]; duplicate {
				return tomlShape{}, "duplicate agents." + key + " definitions cannot be updated safely"
			}
			shape.definitions[key] = targetDefinition{
				key: key, index: index,
				owned: markerLine(lines, index-1, ManagedSubagentDefaultMarker),
			}
		}
	}

	// A marker that does not sit immediately above what it claims is the one
	// shape where removal could delete something arbitrary, so it refuses.
	for index := range lines {
		if markerLine(lines, index, ManagedSubagentDefaultMarker) {
			insideAgents := shape.agentsHeader >= 0 && index > shape.agentsHeader && index+1 < shape.agentsEnd
			if targetKeyAt(lines, index+1) == "" || !insideAgents {
				return tomlShape{}, "orphaned managed subagent default marker cannot be updated safely"
			}
		}
		if markerLine(lines, index, ManagedAgentsTableMarker) && index+1 != shape.agentsHeader {
			return tomlShape{}, "orphaned managed agents table marker cannot be updated safely"
		}
	}

	shape.tableOwned = shape.agentsHeader >= 0 && markerLine(lines, shape.agentsHeader-1, ManagedAgentsTableMarker)
	return shape, ""
}
