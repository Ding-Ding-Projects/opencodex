package server

// Client-facing image-gen namespace restore, ported from
// src/server/responses-image-gen-repair.ts.
//
// Codex declares image tools under a standalone namespace, but the wire carries
// a flattened `image_gen__<name>`. The client expects the namespaced shape back,
// so the flattening has to be undone on the way out.
//
// Only the CLIENT-facing branch is restored. The inspection and
// continuation-cache branch keeps the raw upstream names, because a replay has
// to be sent back to the provider exactly as it arrived.

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"unicode/utf8"

	"github.com/lidge-jun/opencodex-go/internal/protocol"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

const (
	imageGenNamespace    = "image_gen"
	imageGenDottedPrefix = imageGenNamespace + "."
)

// NamespacedTool is one restore target.
type NamespacedTool struct {
	Namespace string
	Name      string
}

// ImageGenToolCallAliases collects the exact wire names that map back to an
// image-gen tool.
//
// Exact declared names only: splitting on a double underscore would rename
// unrelated tools that happen to contain one. The dotted spelling is accepted
// too because earlier compatibility attempts emitted it, and legacy flat dotted
// declarations are recovered from the raw request because the generic parser
// assigns them no namespace.
func ImageGenToolCallAliases(namespaced map[string]NamespacedTool, requestBody any) map[string]NamespacedTool {
	aliases := map[string]NamespacedTool{}
	for wireName, tool := range namespaced {
		if tool.Namespace != imageGenNamespace {
			continue
		}
		aliases[wireName] = tool
		aliases[tool.Namespace+"."+tool.Name] = tool
	}
	for _, group := range collectResponsesToolGroups(requestBody) {
		for _, entry := range group {
			tool, ok := entry.(map[string]any)
			if !ok {
				continue
			}
			if kind, _ := tool["type"].(string); kind != "function" {
				continue
			}
			name, _ := tool["name"].(string)
			if !strings.HasPrefix(name, imageGenDottedPrefix) || len(name) == len(imageGenDottedPrefix) {
				continue
			}
			local := name[len(imageGenDottedPrefix):]
			target := NamespacedTool{Namespace: imageGenNamespace, Name: local}
			aliases[imageGenNamespace+"__"+local] = target
			aliases[name] = target
		}
	}
	return aliases
}

// collectResponsesToolGroups gathers the top-level tools plus any declared
// inside an additional_tools input item.
func collectResponsesToolGroups(body any) [][]any {
	document, ok := body.(map[string]any)
	if !ok {
		return nil
	}
	var groups [][]any
	if tools, ok := document["tools"].([]any); ok {
		groups = append(groups, tools)
	}
	input, ok := document["input"].([]any)
	if !ok {
		return groups
	}
	for _, entry := range input {
		item, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		if kind, _ := item["type"].(string); kind != "additional_tools" {
			continue
		}
		if tools, ok := item["tools"].([]any); ok {
			groups = append(groups, tools)
		}
	}
	return groups
}

// restoreImageGenCalls rewrites only exact function-call aliases, reporting
// whether anything actually changed.
func restoreImageGenCalls(value any, aliases map[string]NamespacedTool) (any, bool) {
	switch typed := value.(type) {
	case []any:
		changed := false
		restored := make([]any, len(typed))
		for index, entry := range typed {
			next, entryChanged := restoreImageGenCalls(entry, aliases)
			restored[index] = next
			changed = changed || entryChanged
		}
		if !changed {
			return value, false
		}
		return restored, true
	case *orderedObject:
		changed := false
		restored := &orderedObject{values: make(map[string]any, len(typed.values))}
		for _, key := range typed.keys {
			next, entryChanged := restoreImageGenCalls(typed.values[key], aliases)
			restored.set(key, next)
			changed = changed || entryChanged
		}
		// Only a function_call is a restore target. A message carrying the same
		// string in its name field must be left alone, which is why this is a
		// structural rewrite rather than a textual one.
		if kind, _ := typed.get("type"); stringValue(kind) == "function_call" {
			if raw, ok := typed.get("name"); ok {
				// Read through preservedString: a value wrapped for byte
				// fidelity is still the string it decoded to.
				if name := stringValue(raw); name != "" {
					if target, found := aliases[name]; found {
						restored.set("name", target.Name)
						restored.set("namespace", target.Namespace)
						changed = true
					}
				}
			}
		}
		if !changed {
			return value, false
		}
		return restored, true
	}
	return value, false
}

// RestoreImageGenCallsInJSON rewrites a non-streaming Responses document.
//
// Unparseable input and documents that need no change are returned as the
// ORIGINAL text, so this cannot reformat a payload merely by inspecting it.
//
// Decoding preserves key order. Go's json.Marshal sorts map keys while the
// oracle preserves insertion order, so a plain map round trip would reorder
// every field of every event that passes through here.
func RestoreImageGenCallsInJSON(text string, aliases map[string]NamespacedTool) string {
	if len(aliases) == 0 {
		return text
	}
	payload, err := decodeOrdered(text)
	if err != nil {
		return text
	}
	restored, changed := restoreImageGenCalls(payload, aliases)
	if !changed {
		return text
	}
	encoded, err := encodeJSONValue(restored)
	if err != nil {
		return text
	}
	return string(encoded)
}

// orderedObject is a JSON object that remembers its key order.
//
// Go's map-based decode loses insertion order and json.Marshal then emits keys
// alphabetically, which would reorder every field of every event that passes
// through here. The oracle preserves order, so a byte-level differential
// requires preserving it too.
type orderedObject struct {
	keys   []string
	values map[string]any
}

func (o *orderedObject) get(key string) (any, bool) {
	value, found := o.values[key]
	return value, found
}

func (o *orderedObject) set(key string, value any) {
	if _, exists := o.values[key]; !exists {
		o.keys = append(o.keys, key)
	}
	o.values[key] = value
}

func (o *orderedObject) MarshalJSON() ([]byte, error) {
	var buffer bytes.Buffer
	buffer.WriteByte('{')
	for index, key := range o.keys {
		if index > 0 {
			buffer.WriteByte(',')
		}
		encodedKey, err := encodeJSONValue(key)
		if err != nil {
			return nil, err
		}
		buffer.Write(encodedKey)
		buffer.WriteByte(':')
		encodedValue, err := encodeJSONValue(o.values[key])
		if err != nil {
			return nil, err
		}
		buffer.Write(encodedValue)
	}
	buffer.WriteByte('}')
	return buffer.Bytes(), nil
}

// encodeJSONValue encodes without Go's default HTML escaping.
//
// json.Marshal turns `<`, `>` and `&` into \u003c, \u003e and \u0026, while
// JSON.stringify leaves them alone. Image prompts and tool arguments routinely
// contain those characters, so the default would rewrite payload bytes on every
// event that merely passes through here.
func encodeJSONValue(value any) ([]byte, error) {
	// A string carrying a lone surrogate is emitted from its ORIGINAL escape
	// rather than re-encoded. Go's decoder replaces an unpaired \ud800 with
	// U+FFFD, which silently changes what the client receives; the oracle
	// preserves it.
	if preserved, ok := value.(preservedString); ok {
		return []byte(preserved.raw), nil
	}
	// Negative zero is the one number Go and JSON.stringify disagree on: Go
	// emits -0, JavaScript emits 0. Normalized here rather than at decode time
	// so the difference stays visible next to the reason for it.
	if number, ok := value.(float64); ok && number == 0 {
		value = float64(0)
	}
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	// Encode appends a newline that Marshal does not.
	return bytes.TrimRight(buffer.Bytes(), "\n"), nil
}

// preservedString is a string whose original JSON text must be re-emitted
// verbatim, because decoding and re-encoding it would not round-trip.
type preservedString struct {
	value string
	raw   string
}

// MarshalJSON emits the original bytes.
//
// Required because a preservedString can sit anywhere a value can, including
// inside a slice that json.Marshal encodes itself. Without this the struct
// would serialize as {} and the string would vanish.
func (p preservedString) MarshalJSON() ([]byte, error) {
	return []byte(p.raw), nil
}

// preserveLoneSurrogate returns a plain string when decoding was lossless, and
// a preservedString carrying the original escape when it was not.
//
// Go's decoder substitutes U+FFFD for an unpaired surrogate, so the only way to
// tell is that the decoded text now contains a replacement character. Payloads
// that legitimately contain U+FFFD re-encode to the same bytes and are
// unaffected.
func preserveLoneSurrogate(text, raw string) any {
	if !strings.ContainsRune(text, utf8.RuneError) || raw == "" {
		return text
	}
	// The replacement character is only evidence of loss when the source did
	// not actually contain one. An escaped or literal U+FFFD is re-encoded
	// normally, because that is what the oracle does; only a lone surrogate
	// that the decoder destroyed is re-emitted from its original bytes.
	if strings.ContainsRune(unescapeJSONString(raw), utf8.RuneError) {
		return text
	}
	// The escape is lowercased, because the oracle normalizes it: measured,
	// \uD800 comes back as \ud800. Preserving the input's spelling would be
	// more faithful to the source and less faithful to the oracle.
	return preservedString{value: text, raw: lowerUnicodeEscapes(raw)}
}

// lowerUnicodeEscapes lowercases the hex digits of every \uXXXX escape while
// leaving the rest of the string untouched.
func lowerUnicodeEscapes(raw string) string {
	var builder strings.Builder
	for index := 0; index < len(raw); index++ {
		if raw[index] == '\\' && index+5 < len(raw) && (raw[index+1] == 'u' || raw[index+1] == 'U') {
			builder.WriteString(`\u`)
			builder.WriteString(strings.ToLower(raw[index+2 : index+6]))
			index += 5
			continue
		}
		builder.WriteByte(raw[index])
	}
	return builder.String()
}

// unescapeJSONString decodes a JSON string literal, tolerating the lone
// surrogate that makes the strict decoder lossy.
func unescapeJSONString(raw string) string {
	var decoded string
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		return ""
	}
	// A literal U+FFFD in the source survives this round trip; a lone
	// surrogate becomes one, so the two are told apart by looking for the
	// escape in the raw text instead.
	if strings.Contains(strings.ToLower(raw), `\ufffd`) || strings.ContainsRune(raw, utf8.RuneError) {
		return decoded
	}
	return ""
}

// stringValue reads a decoded string whether or not it was wrapped to preserve
// its original bytes.
func stringValue(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case preservedString:
		return typed.value
	}
	return ""
}

// rawSlice returns the original source bytes of one token, or "" when the
// offsets are unusable.
func rawSlice(source string, start, end int64) string {
	if start < 0 || end > int64(len(source)) || start >= end {
		return ""
	}
	// InputOffset points at the position BEFORE the token was read, which for
	// an object value sits on the preceding colon and any whitespace. Trim back
	// to the opening quote so only the string literal itself is captured.
	segment := strings.TrimSpace(source[start:end])
	if quote := strings.IndexByte(segment, '"'); quote > 0 {
		segment = segment[quote:]
	}
	if !strings.HasPrefix(segment, `"`) || !strings.HasSuffix(segment, `"`) {
		return ""
	}
	return segment
}

// decodeOrdered parses JSON while retaining object key order.
//
// Numbers go through float64 rather than being preserved verbatim, because
// that is what the oracle does and matching it matters more than being more
// precise than it. JSON.parse is float64-backed too, so 1.5e10 becomes
// 15000000000 and a twenty-digit integer loses its tail on BOTH sides. Keeping
// the original text would have made Go disagree with the oracle on every
// exponent-form number.
func decodeOrdered(text string) (any, error) {
	decoder := json.NewDecoder(strings.NewReader(text))
	value, err := decodeOrderedValue(decoder, text)
	if err != nil {
		return nil, err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return nil, errTrailingJSON
	}
	return value, nil
}

var errTrailingJSON = errors.New("trailing JSON content")

func decodeOrderedValue(decoder *json.Decoder, source string) (any, error) {
	// The offsets bracket the raw bytes of this token, which is the only way to
	// recover an escape the decoder has already normalized away.
	start := decoder.InputOffset()
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	end := decoder.InputOffset()
	return decodeOrderedFromToken(decoder, token, source, start, end)
}

func decodeOrderedFromToken(decoder *json.Decoder, token json.Token, source string, start, end int64) (any, error) {
	delimiter, isDelimiter := token.(json.Delim)
	if !isDelimiter {
		if text, isString := token.(string); isString {
			return preserveLoneSurrogate(text, rawSlice(source, start, end)), nil
		}
		return token, nil
	}
	switch delimiter {
	case '{':
		object := &orderedObject{values: map[string]any{}}
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return nil, err
			}
			key, ok := keyToken.(string)
			if !ok {
				return nil, errTrailingJSON
			}
			value, err := decodeOrderedValue(decoder, source)
			if err != nil {
				return nil, err
			}
			object.set(key, value)
		}
		if _, err := decoder.Token(); err != nil {
			return nil, err
		}
		return object, nil
	case '[':
		items := []any{}
		for decoder.More() {
			value, err := decodeOrderedValue(decoder, source)
			if err != nil {
				return nil, err
			}
			items = append(items, value)
		}
		if _, err := decoder.Token(); err != nil {
			return nil, err
		}
		return items, nil
	}
	return nil, errTrailingJSON
}

// CreateImageGenCallRestoreRewrite returns nil when there is nothing to
// restore, so the caller can skip wrapping the stream entirely.
func CreateImageGenCallRestoreRewrite(aliases map[string]NamespacedTool) protocol.SSEPayloadRewrite {
	if len(aliases) == 0 {
		return nil
	}
	return func(payload string) string {
		return RestoreImageGenCallsInJSON(payload, aliases)
	}
}

// imageGenAliases derives the restore targets for one request.
//
// Returns nothing when the request declares no image-gen tools, which is the
// common case, so an ordinary stream is never wrapped.
func (core *ResponsesCore) imageGenAliases(normalized *types.NormalizedRequest) map[string]NamespacedTool {
	if normalized == nil {
		return nil
	}
	namespaced := map[string]NamespacedTool{}
	for _, tool := range normalized.Context.Tools {
		if tool.Namespace == "" {
			continue
		}
		namespaced[tool.Namespace+"__"+tool.Name] = NamespacedTool{Namespace: tool.Namespace, Name: tool.Name}
	}
	var body any
	if len(normalized.RawBody) > 0 {
		if err := json.Unmarshal(normalized.RawBody, &body); err != nil {
			body = nil
		}
	}
	aliases := ImageGenToolCallAliases(namespaced, body)
	if len(aliases) == 0 {
		return nil
	}
	return aliases
}
