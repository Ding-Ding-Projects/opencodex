package cursor

import (
	"bytes"
	"encoding/json"
)

func parseCursorJSONText(text string) any {
	var value any
	if json.Unmarshal([]byte(text), &value) == nil {
		return value
	}
	return text
}

// DecodeCursorArgValue accepts canonical google.protobuf.Value bytes. Cursor
// also emits raw UTF-8/JSON argument bytes in some tool paths, so non-canonical
// protobuf payloads fall back to text decoding exactly as the TS adapter does.
func DecodeCursorArgValue(data []byte) any {
	if value, err := UnmarshalValue(data); err == nil {
		if encoded, marshalErr := MarshalValue(value); marshalErr == nil && bytes.Equal(encoded, data) {
			if text, ok := value.(string); ok {
				return parseCursorJSONText(text)
			}
			return value
		}
	}
	return parseCursorJSONText(string(data))
}

func DecodeCursorArgsMap(arguments map[string][]byte) map[string]any {
	decoded := make(map[string]any, len(arguments))
	for key, value := range arguments {
		decoded[key] = DecodeCursorArgValue(value)
	}
	return decoded
}
