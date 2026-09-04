package chat

import (
	"bytes"
	"encoding/json"
	"reflect"
	"sort"
)

// marshalAnthropicJSON mirrors JSON.stringify insertion order for the stable
// Anthropic Messages wire vocabulary. Dynamic keys fall back to lexical order.
func marshalAnthropicJSON(value any) ([]byte, error) {
	var output bytes.Buffer
	if err := appendAnthropicJSON(&output, reflect.ValueOf(value), nil); err != nil {
		return nil, err
	}
	return output.Bytes(), nil
}

func appendAnthropicJSON(output *bytes.Buffer, value reflect.Value, preferred []string) error {
	if !value.IsValid() {
		output.WriteString("null")
		return nil
	}
	for value.Kind() == reflect.Interface || value.Kind() == reflect.Pointer {
		if value.IsNil() {
			output.WriteString("null")
			return nil
		}
		value = value.Elem()
	}
	if value.Kind() == reflect.Map {
		keys := make([]string, 0, value.Len())
		iterator := value.MapRange()
		for iterator.Next() {
			keys = append(keys, iterator.Key().String())
		}
		keys = anthropicKeyOrder(keys, preferred)
		output.WriteByte('{')
		for index, key := range keys {
			if index > 0 {
				output.WriteByte(',')
			}
			encodedKey, _ := json.Marshal(key)
			output.Write(encodedKey)
			output.WriteByte(':')
			child := value.MapIndex(reflect.ValueOf(key).Convert(value.Type().Key()))
			if err := appendAnthropicJSON(output, child, anthropicNestedOrder(key)); err != nil {
				return err
			}
		}
		output.WriteByte('}')
		return nil
	}
	if value.Kind() == reflect.Slice || value.Kind() == reflect.Array {
		output.WriteByte('[')
		for index := 0; index < value.Len(); index++ {
			if index > 0 {
				output.WriteByte(',')
			}
			if err := appendAnthropicJSON(output, value.Index(index), nil); err != nil {
				return err
			}
		}
		output.WriteByte(']')
		return nil
	}
	encoded, err := json.Marshal(value.Interface())
	if err == nil {
		output.Write(encoded)
	}
	return err
}

func anthropicKeyOrder(keys, preferred []string) []string {
	if preferred == nil {
		preferred = []string{"type", "index", "message", "content_block", "delta", "usage", "error"}
	}
	remaining := make(map[string]bool, len(keys))
	for _, key := range keys {
		remaining[key] = true
	}
	ordered := make([]string, 0, len(keys))
	for _, key := range preferred {
		if remaining[key] {
			ordered = append(ordered, key)
			delete(remaining, key)
		}
	}
	keys = keys[:0]
	for key := range remaining {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return append(ordered, keys...)
}

func anthropicNestedOrder(parent string) []string {
	switch parent {
	case "message":
		return []string{"id", "type", "role", "content", "model", "stop_reason", "stop_sequence", "usage"}
	case "content_block":
		return []string{"type", "text", "thinking", "signature", "id", "name", "input"}
	case "delta":
		return []string{"type", "text", "thinking", "signature", "partial_json", "stop_reason", "stop_sequence"}
	case "usage":
		return []string{"input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "server_tool_use"}
	case "error":
		return []string{"type", "message"}
	default:
		return nil
	}
}
