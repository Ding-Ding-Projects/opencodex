package codex

// The line-level edits. Each one is narrow on purpose: the surrounding
// document belongs to the user.

import (
	"bytes"
	"encoding/json"
	"sort"
	"strings"
)

// quotedTomlString renders a value as a TOML basic string.
//
// JSON basic strings are valid TOML basic strings and already cover quotes,
// backslashes, control characters and newlines. Two corrections, both measured
// against the oracle by running it:
//
//   - Go's json.Marshal HTML-escapes < > and &, which JSON.stringify does not.
//     Left alone, a model name containing any of them would be written as
//     \u003c and the file would differ from the oracle's byte-for-byte, and
//     would keep differing on every re-run.
//   - Go also escapes U+2028 and U+2029 unconditionally, even with HTML
//     escaping off, because they are line terminators in older JavaScript.
//     TOML has no such rule and the oracle writes them literally.
//   - JSON leaves DEL literal while TOML requires it escaped.
func quotedTomlString(value string) string {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return `""`
	}
	// Encode appends a newline that is not part of the literal.
	encoded := strings.TrimSuffix(buffer.String(), "\n")
	return unescapeLineSeparators(strings.ReplaceAll(encoded, "\u007f", `\u007F`))
}

// unescapeLineSeparators turns the encoder's \u2028 and \u2029 back into the
// literal characters.
//
// It walks the string rather than using ReplaceAll, because a value containing
// the literal TEXT `\u2028` is encoded as `\\u2028` — and a blind replacement
// would rewrite the user's own backslash into a line separator, silently
// corrupting their value.
func unescapeLineSeparators(encoded string) string {
	if !strings.Contains(encoded, `\u202`) {
		return encoded
	}
	var out strings.Builder
	out.Grow(len(encoded))
	for index := 0; index < len(encoded); {
		if encoded[index] == '\\' {
			switch {
			case strings.HasPrefix(encoded[index:], `\u2028`):
				out.WriteString("\u2028")
				index += 6
			case strings.HasPrefix(encoded[index:], `\u2029`):
				out.WriteString("\u2029")
				index += 6
			default:
				// Any other escape, INCLUDING an escaped backslash, is copied
				// whole so its second character can never start a new match.
				end := index + 2
				if end > len(encoded) {
					end = len(encoded)
				}
				out.WriteString(encoded[index:end])
				index = end
			}
			continue
		}
		out.WriteByte(encoded[index])
		index++
	}
	return out.String()
}

// replaceManagedString rewrites the value on a line this transform owns.
//
// Returns "" when the line is not a shape it can rewrite — a multiline value,
// a non-string, or a different key. The caller treats that as a refusal rather
// than editing around it.
func replaceManagedString(line, key, value string) string {
	match := managedStringValue.FindStringSubmatch(line)
	if match == nil || canonicalKeySegment(match[2]) != key {
		return ""
	}
	quoted := quotedTomlString(value)
	if match[4] == quoted {
		// Byte-identical already: returning the original keeps `changed` false
		// for a no-op run.
		return line
	}
	return match[1] + match[2] + match[3] + quoted + match[5]
}

// insertedLines is the marker plus its value, always as a pair. The marker is
// what makes the value removable later.
func insertedLines(key, value, eol string) []sourceLine {
	return []sourceLine{
		{text: ManagedSubagentDefaultMarker, eol: eol, structural: true},
		{text: key + " = " + quotedTomlString(value), eol: eol, structural: true},
	}
}

// removeLines deletes by index, highest first so earlier indexes stay valid.
func removeLines(lines []sourceLine, indexes []int) []sourceLine {
	if len(indexes) == 0 {
		return lines
	}
	sort.Sort(sort.Reverse(sort.IntSlice(indexes)))
	for _, index := range indexes {
		if index < 0 || index >= len(lines) {
			continue
		}
		lines = append(lines[:index], lines[index+1:]...)
	}
	return lines
}

// insertPairs places new marker/value pairs inside [agents], creating the
// table when it does not exist.
func insertPairs(lines []sourceLine, pairs []sourceLine, eol string) []sourceLine {
	header := findExactAgentsHeader(lines)
	if header >= 0 {
		// A final line with no terminator has to gain one, or the inserted
		// line would be appended to it.
		if lines[header].eol == "" {
			lines[header].eol = eol
		}
		return spliceLines(lines, header+1, pairs)
	}

	table := append([]sourceLine{
		{text: ManagedAgentsTableMarker, eol: eol, structural: true},
		{text: "[agents]", eol: eol, structural: true},
	}, pairs...)

	// A new [agents] table must come BEFORE any [agents.x] sub-table, since
	// TOML would otherwise read the new keys as belonging to that sub-table.
	for index, line := range lines {
		if _, ok := dottedAgentsHeader(line); ok {
			return spliceLines(lines, index, table)
		}
	}
	if len(lines) > 0 && lines[len(lines)-1].eol == "" {
		lines[len(lines)-1].eol = eol
	}
	return append(lines, table...)
}

// pruneOwnedTable removes a table this transform created once it is empty.
//
// Only when EVERY body line is blank: a comment or an unknown key means the
// user extended it, and deleting their content to tidy up ours would be a bad
// trade. When the defaults are being removed but the table survives, only the
// ownership claim is dropped — what remains is theirs now.
func pruneOwnedTable(lines []sourceLine, shape tomlShape, disabling bool) []sourceLine {
	if !shape.tableOwned {
		return lines
	}
	header := findExactAgentsHeader(lines)
	if header < 0 || !markerLine(lines, header-1, ManagedAgentsTableMarker) {
		return lines
	}
	end := len(lines)
	for index := header + 1; index < len(lines); index++ {
		if isAnyTableHeader(lines[index]) {
			end = index
			break
		}
	}
	empty := true
	for index := header + 1; index < end; index++ {
		if strings.TrimSpace(lines[index].text) != "" {
			empty = false
			break
		}
	}
	if empty {
		return append(lines[:header-1], lines[end:]...)
	}
	if disabling {
		return append(lines[:header-1], lines[header:]...)
	}
	return lines
}

func findExactAgentsHeader(lines []sourceLine) int {
	for index := range lines {
		if exactAgentsHeader(lines, index) {
			return index
		}
	}
	return -1
}

func spliceLines(lines []sourceLine, at int, inserted []sourceLine) []sourceLine {
	out := make([]sourceLine, 0, len(lines)+len(inserted))
	out = append(out, lines[:at]...)
	out = append(out, inserted...)
	return append(out, lines[at:]...)
}
