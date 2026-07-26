package grok

import (
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

const keySegmentPattern = `(?:[A-Za-z0-9_-]+|"(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*')`

var (
	modelTableHeader = regexp.MustCompile(`(?m)^[ \t]*\[\[?[ \t]*(` + keySegmentPattern + `)[ \t]*\.[ \t]*(` + keySegmentPattern + `)[ \t]*(?:\.[^\]\r\n]*)?\]\]?[ \t]*(?:#[^\r\n]*)?$`)
	invalidAliasByte = regexp.MustCompile(`[^A-Za-z0-9_-]`)
)

func userModelAliases(content string, region *managedRegion) map[string]struct{} {
	outside := content
	if region != nil {
		outside = content[:region.start] + content[region.end:]
	}
	aliases := make(map[string]struct{})
	for _, match := range modelTableHeader.FindAllStringSubmatch(outside, -1) {
		if canonicalKeySegment(match[1]) != "model" {
			continue
		}
		aliases[canonicalKeySegment(match[2])] = struct{}{}
	}
	return aliases
}

func canonicalKeySegment(raw string) string {
	if len(raw) >= 2 && raw[0] == '"' {
		return decodeTOMLBasicString(raw[1 : len(raw)-1])
	}
	if len(raw) >= 2 && raw[0] == '\'' {
		return raw[1 : len(raw)-1]
	}
	return raw
}

// decodeTOMLBasicString decodes TOML basic-string escapes conservatively. Invalid
// escapes and invalid Unicode scalar values remain raw so reservation over-matches
// rather than allowing a user-owned alias to be overwritten.
func decodeTOMLBasicString(body string) string {
	var output strings.Builder
	for index := 0; index < len(body); {
		if body[index] != '\\' || index+1 >= len(body) {
			output.WriteByte(body[index])
			index++
			continue
		}
		start := index
		index++
		escape := body[index]
		index++
		switch escape {
		case 'b':
			output.WriteByte('\b')
		case 't':
			output.WriteByte('\t')
		case 'n':
			output.WriteByte('\n')
		case 'f':
			output.WriteByte('\f')
		case 'r':
			output.WriteByte('\r')
		case '"':
			output.WriteByte('"')
		case '\\':
			output.WriteByte('\\')
		case 'u', 'U':
			digits := 4
			if escape == 'U' {
				digits = 8
			}
			if index+digits > len(body) {
				output.WriteString(body[start:index])
				continue
			}
			value, err := strconv.ParseUint(body[index:index+digits], 16, 32)
			if err != nil || value > utf8.MaxRune || value >= 0xd800 && value <= 0xdfff {
				output.WriteString(body[start : index+digits])
				index += digits
				continue
			}
			output.WriteRune(rune(value))
			index += digits
		default:
			output.WriteString(body[start:index])
		}
	}
	return output.String()
}

func sanitizeAlias(id string) string {
	return invalidAliasByte.ReplaceAllString(id, "-")
}
