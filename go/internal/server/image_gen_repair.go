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

	"github.com/lidge-jun/opencodex-go/internal/protocol"
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
		if kind, _ := typed.get("type"); kind == "function_call" {
			if raw, ok := typed.get("name"); ok {
				if name, isString := raw.(string); isString && name != "" {
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
	encoded, err := json.Marshal(restored)
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
		encodedKey, err := json.Marshal(key)
		if err != nil {
			return nil, err
		}
		buffer.Write(encodedKey)
		buffer.WriteByte(':')
		encodedValue, err := json.Marshal(o.values[key])
		if err != nil {
			return nil, err
		}
		buffer.Write(encodedValue)
	}
	buffer.WriteByte('}')
	return buffer.Bytes(), nil
}

// decodeOrdered parses JSON while retaining object key order. Numbers are kept
// as json.Number so a large integer is not re-emitted in scientific notation.
func decodeOrdered(text string) (any, error) {
	decoder := json.NewDecoder(strings.NewReader(text))
	decoder.UseNumber()
	value, err := decodeOrderedValue(decoder)
	if err != nil {
		return nil, err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return nil, errTrailingJSON
	}
	return value, nil
}

var errTrailingJSON = errors.New("trailing JSON content")

func decodeOrderedValue(decoder *json.Decoder) (any, error) {
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	return decodeOrderedFromToken(decoder, token)
}

func decodeOrderedFromToken(decoder *json.Decoder, token json.Token) (any, error) {
	delimiter, isDelimiter := token.(json.Delim)
	if !isDelimiter {
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
			value, err := decodeOrderedValue(decoder)
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
			value, err := decodeOrderedValue(decoder)
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
