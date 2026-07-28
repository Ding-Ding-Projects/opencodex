package codex

// Ownership-aware edits to Codex's native [agents] defaults, ported from
// src/codex/subagent-defaults.ts.
//
// This writes a file the USER owns. So it deliberately does not parse and
// re-serialize the document: comments, key order, unknown keys and line
// endings all survive because only the specific lines this transform owns are
// ever touched. Every value it may later remove carries its own marker on the
// immediately preceding line, and anything ambiguous refuses to write at all.

import (
	"strings"
	"unicode/utf8"
)

const (
	// ManagedSubagentDefaultMarker claims the single line that follows it.
	ManagedSubagentDefaultMarker = "# Managed by opencodex: native subagent default"
	// ManagedAgentsTableMarker claims an [agents] table this transform created.
	ManagedAgentsTableMarker = "# Managed by opencodex: native subagent defaults table"
)

// targetKeys are the only keys this transform will ever write or remove.
var targetKeys = []string{"default_subagent_model", "default_subagent_reasoning_effort"}

// ManagedSubagentDefaults is the desired state. A nil pointer means "remove
// what we own".
type ManagedSubagentDefaults struct {
	Model string
	// ReasoningEffort is optional and a POINTER, because absent and
	// present-but-empty are different requests. Absent means "do not manage an
	// effort", which removes one we previously wrote. Present-but-empty is a
	// caller mistake and is refused, since silently deleting a setting the
	// user is relying on is the worst reading of an empty string.
	ReasoningEffort *string
}

// SubagentDefaultsConflict reports a target key the user owns.
type SubagentDefaultsConflict struct {
	Key string
	// Line is 1-based, so it can be shown to a person reading their file.
	Line   int
	Reason string
}

// SubagentDefaultsResult is the outcome of one transform.
//
// Content is ALWAYS the bytes the caller should keep: on refusal it is the
// original input unchanged, so a caller that writes it regardless cannot
// corrupt the file.
type SubagentDefaultsResult struct {
	OK        bool
	Changed   bool
	Content   string
	Conflicts []SubagentDefaultsConflict
	Error     string
}

type sourceLine struct {
	text string
	eol  string
	// structural is false when this physical line began inside a multiline
	// string or an unterminated bracket, where table-looking text is data
	// rather than syntax.
	structural bool
}

type targetDefinition struct {
	key   string
	index int
	owned bool
}

type tomlShape struct {
	agentsHeader int
	agentsEnd    int
	tableOwned   bool
	definitions  map[string]targetDefinition
}

// TransformManagedSubagentDefaults adds, updates, or removes the managed
// defaults.
//
// Unmarked target keys belong to the user: they are retained and reported as
// conflicts rather than overwritten. Anything the transform cannot read
// unambiguously is refused byte-for-byte, so a caller never has to guess what
// changed in someone's config.
func TransformManagedSubagentDefaults(content string, defaults *ManagedSubagentDefaults) SubagentDefaultsResult {
	if defaults != nil {
		if defaults.Model == "" {
			return refuse(content, "managed subagent model must be a non-empty string")
		}
		// Lone surrogates cannot round-trip through a TOML string, and writing
		// one would produce a file Codex cannot read back.
		if !utf8.ValidString(defaults.Model) {
			return refuse(content, "managed subagent model must contain valid Unicode scalar values")
		}
		if defaults.ReasoningEffort != nil {
			if *defaults.ReasoningEffort == "" {
				return refuse(content, "managed subagent reasoning effort must be a non-empty string when supplied")
			}
			if !utf8.ValidString(*defaults.ReasoningEffort) {
				return refuse(content, "managed subagent reasoning effort must contain valid Unicode scalar values")
			}
		}
	}

	lines := splitSourceLines(content)
	if defaults == nil && !hasAnyMarker(lines) {
		// Nothing of ours is in the file, so a disable has nothing to do.
		return SubagentDefaultsResult{OK: true, Content: content, Conflicts: []SubagentDefaultsConflict{}}
	}

	shape, err := analyzeToml(lines)
	if err != "" {
		return refuse(content, err)
	}
	eol := dominantEol(lines)

	desired := map[string]string{}
	if defaults != nil {
		desired["default_subagent_model"] = defaults.Model
		if defaults.ReasoningEffort != nil {
			desired["default_subagent_reasoning_effort"] = *defaults.ReasoningEffort
		}
	}

	conflicts := []SubagentDefaultsConflict{}
	if defaults != nil {
		for _, key := range targetKeys {
			if definition, found := shape.definitions[key]; found && !definition.owned {
				conflicts = append(conflicts, SubagentDefaultsConflict{Key: key, Line: definition.index + 1, Reason: "user-owned"})
			}
		}
		// Model and effort are ONE effective native default. A partial write
		// could apply a freshly managed effort to a model the user chose, so
		// any ownership conflict makes the whole update a no-op.
		if len(conflicts) > 0 {
			return SubagentDefaultsResult{OK: true, Content: content, Conflicts: conflicts}
		}
	}

	missing := [][2]string{}
	removals := []int{}
	for _, key := range targetKeys {
		definition, found := shape.definitions[key]
		value, wanted := desired[key]
		if !found {
			if wanted {
				missing = append(missing, [2]string{key, value})
			}
			continue
		}
		if !definition.owned {
			continue
		}
		// Validated before deciding anything: a line we own but cannot rewrite
		// must refuse rather than be half-edited or deleted.
		probe := value
		if !wanted {
			probe = "__opencodex_validation__"
		}
		if replaceManagedString(lines[definition.index].text, key, probe) == "" {
			return refuse(content, "managed agents."+key+" is not a supported single-line TOML string")
		}
		if !wanted {
			// The marker above it goes too, or the next run would see an
			// orphan and refuse.
			removals = append(removals, definition.index-1, definition.index)
			continue
		}
		lines[definition.index].text = replaceManagedString(lines[definition.index].text, key, value)
	}

	lines = removeLines(lines, removals)

	if len(missing) > 0 {
		var pairs []sourceLine
		for _, entry := range missing {
			pairs = append(pairs, insertedLines(entry[0], entry[1], eol)...)
		}
		lines = insertPairs(lines, pairs, eol)
	}

	lines = pruneOwnedTable(lines, shape, defaults == nil)

	output := joinSourceLines(lines)
	return SubagentDefaultsResult{OK: true, Changed: output != content, Content: output, Conflicts: conflicts}
}

func refuse(content, message string) SubagentDefaultsResult {
	return SubagentDefaultsResult{Content: content, Conflicts: []SubagentDefaultsConflict{}, Error: message}
}

func hasAnyMarker(lines []sourceLine) bool {
	for index := range lines {
		if markerLine(lines, index, ManagedSubagentDefaultMarker) || markerLine(lines, index, ManagedAgentsTableMarker) {
			return true
		}
	}
	return false
}

// splitSourceLines keeps each line's own terminator so a mixed-ending file
// survives a round trip unchanged.
func splitSourceLines(content string) []sourceLine {
	lines := []sourceLine{}
	offset := 0
	for offset < len(content) {
		lf := strings.IndexByte(content[offset:], '\n')
		if lf < 0 {
			lines = append(lines, sourceLine{text: content[offset:], structural: true})
			break
		}
		lf += offset
		crlf := lf > offset && content[lf-1] == '\r'
		text := content[offset:lf]
		eol := "\n"
		if crlf {
			text = content[offset : lf-1]
			eol = "\r\n"
		}
		lines = append(lines, sourceLine{text: text, eol: eol, structural: true})
		offset = lf + 1
	}
	markStructuralLines(lines)
	return lines
}

// markStructuralLines runs a deliberately small lexer over the document.
//
// TOML table-looking text inside a multiline string is DATA. Without this, a
// prompt containing "[agents]" in a triple-quoted string would be read as a
// table header and the transform would edit the wrong place.
func markStructuralLines(lines []sourceLine) {
	multiline := ""
	squareDepth, curlyDepth := 0, 0

	for index := range lines {
		lines[index].structural = multiline == "" && squareDepth == 0 && curlyDepth == 0
		text := lines[index].text
		single := ""

		for position := 0; position < len(text); {
			switch {
			case multiline == "basic":
				switch {
				case strings.HasPrefix(text[position:], `"""`):
					multiline, position = "", position+3
				case text[position] == '\\':
					position += 2
				default:
					position++
				}
			case multiline == "literal":
				if strings.HasPrefix(text[position:], "'''") {
					multiline, position = "", position+3
				} else {
					position++
				}
			case single == "basic":
				switch {
				case text[position] == '\\':
					position += 2
				case text[position] == '"':
					single, position = "", position+1
				default:
					position++
				}
			case single == "literal":
				if text[position] == '\'' {
					single = ""
				}
				position++
			case text[position] == '#':
				position = len(text)
			case strings.HasPrefix(text[position:], `"""`):
				multiline, position = "basic", position+3
			case strings.HasPrefix(text[position:], "'''"):
				multiline, position = "literal", position+3
			case text[position] == '"':
				single, position = "basic", position+1
			case text[position] == '\'':
				single, position = "literal", position+1
			case text[position] == '[':
				squareDepth, position = squareDepth+1, position+1
			case text[position] == ']':
				squareDepth, position = max(0, squareDepth-1), position+1
			case text[position] == '{':
				curlyDepth, position = curlyDepth+1, position+1
			case text[position] == '}':
				curlyDepth, position = max(0, curlyDepth-1), position+1
			default:
				position++
			}
		}
	}
}

func joinSourceLines(lines []sourceLine) string {
	var out strings.Builder
	for _, line := range lines {
		out.WriteString(line.text)
		out.WriteString(line.eol)
	}
	return out.String()
}

// dominantEol picks the ending inserted lines should use, so a CRLF file does
// not gain stray LF lines.
func dominantEol(lines []sourceLine) string {
	crlf, lf := 0, 0
	for _, line := range lines {
		switch line.eol {
		case "\r\n":
			crlf++
		case "\n":
			lf++
		}
	}
	if crlf > 0 && crlf >= lf {
		return "\r\n"
	}
	return "\n"
}
