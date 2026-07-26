package anthropic

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"testing"
)

func FuzzAnthropicStreamParser(f *testing.F) {
	for _, seed := range []string{
		"",
		": keepalive\n\n",
		"event: content_block_delta\ndata: {broken\n\n",
		"event: content_block_delta\ndata: {\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"안녕 🌍\"}}\n\nevent: message_stop\ndata: {}\n\n",
	} {
		f.Add([]byte(seed))
	}
	f.Fuzz(func(t *testing.T, data []byte) {
		if len(data) > 512<<10 {
			t.Skip()
		}
		count := 0
		for range (&Adapter{}).ParseStream(context.Background(), io.NopCloser(bytes.NewReader(data))) {
			count++
			if count > len(data)+4 {
				t.Fatalf("event count %d exceeds input-derived bound", count)
			}
		}
	})
}

func FuzzAnthropicSchemaNormalizer(f *testing.F) {
	for _, seed := range []string{
		`null`,
		`{"type":"object","properties":{"encrypted":{"const":{"encrypted":true}},"x":{"encrypted":true,"type":"string"}}}`,
		`{"oneOf":[{"properties":{"a":{"type":"string"}}}],"allOf":[{"properties":{"b":{"type":"number"}},"required":["b"]}]}`,
	} {
		f.Add([]byte(seed))
	}
	deep := []byte(`{}`)
	for range 256 {
		deep = append([]byte(`{"items":`), append(deep, '}')...)
	}
	f.Add(deep)
	f.Fuzz(func(t *testing.T, raw []byte) {
		if len(raw) > 256<<10 {
			t.Skip()
		}
		var schema any
		if json.Unmarshal(raw, &schema) != nil {
			return
		}
		normalized := normalizeAnthropicInputSchema(schema)
		encoded, err := json.Marshal(normalized)
		if err != nil || !json.Valid(encoded) || normalized["type"] != "object" {
			t.Fatalf("normalized schema is invalid: %#v err=%v", normalized, err)
		}
	})
}
