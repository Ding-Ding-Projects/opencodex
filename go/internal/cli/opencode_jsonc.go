package cli

import (
	"encoding/json"
	"strings"
	"unicode/utf8"
)

// opencode documents opencode.json as JSONC, so a valid user config may carry
// comments or trailing commas. This is the Go form of parseJsonc in
// src/cli/opencode.ts.
//
// Strict parsing runs FIRST and untouched: a well-formed config never reaches
// the stripper, so the stripper's edge cases cannot corrupt it.
func parseJSONC(raw []byte) (any, error) {
	var value any
	if err := json.Unmarshal(raw, &value); err == nil {
		return value, nil
	}
	cleaned := stripTrailingCommas(stripJSONComments(string(raw)))
	if err := json.Unmarshal([]byte(cleaned), &value); err != nil {
		return nil, err
	}
	return value, nil
}

// stripJSONComments removes // and /* */ comments outside string literals.
//
// The scan is escape-aware: a quote inside an escaped sequence must not flip
// the in-string state, or config text after it would be fed to the comment
// stripper and silently deleted.
func stripJSONComments(text string) string {
	var out strings.Builder
	inString := false
	inLine := false
	inBlock := false
	for index := 0; index < len(text); {
		char, width := utf8.DecodeRuneInString(text[index:])
		next := byte(0)
		if index+width < len(text) {
			next = text[index+width]
		}
		switch {
		case inLine:
			if char == '\n' {
				inLine = false
				out.WriteRune(char)
			}
		case inBlock:
			// Newlines survive so a later parse error still points at the
			// right line.
			if char == '\n' {
				out.WriteRune(char)
			} else if char == '*' && next == '/' {
				inBlock = false
				index += width
				width = 1
			}
		case inString:
			out.WriteRune(char)
			if char == '\\' {
				if index+width < len(text) {
					escaped, escapedWidth := utf8.DecodeRuneInString(text[index+width:])
					out.WriteRune(escaped)
					index += width
					width = escapedWidth
				}
			} else if char == '"' {
				inString = false
			}
		case char == '"':
			inString = true
			out.WriteRune(char)
		case char == '/' && next == '/':
			inLine = true
			index += width
			width = 1
		case char == '/' && next == '*':
			inBlock = true
			index += width
			width = 1
		default:
			out.WriteRune(char)
		}
		index += width
	}
	return out.String()
}

// stripTrailingCommas drops a comma that sits directly before } or ], ignoring
// string contents.
func stripTrailingCommas(text string) string {
	var out strings.Builder
	inString := false
	for index := 0; index < len(text); {
		char, width := utf8.DecodeRuneInString(text[index:])
		if inString {
			out.WriteRune(char)
			if char == '\\' {
				if index+width < len(text) {
					escaped, escapedWidth := utf8.DecodeRuneInString(text[index+width:])
					out.WriteRune(escaped)
					index += width
					width = escapedWidth
				}
			} else if char == '"' {
				inString = false
			}
			index += width
			continue
		}
		if char == '"' {
			inString = true
			out.WriteRune(char)
			index += width
			continue
		}
		if char == ',' {
			scan := index + width
			for scan < len(text) {
				peek, peekWidth := utf8.DecodeRuneInString(text[scan:])
				if peek != ' ' && peek != '\t' && peek != '\n' && peek != '\r' && peek != '\f' && peek != '\v' {
					break
				}
				scan += peekWidth
			}
			if scan < len(text) && (text[scan] == '}' || text[scan] == ']') {
				index += width
				continue
			}
		}
		out.WriteRune(char)
		index += width
	}
	return out.String()
}
