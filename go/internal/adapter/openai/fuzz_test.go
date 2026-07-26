package openai

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

func FuzzOpenAIStreamParsers(f *testing.F) {
	for _, seed := range []string{
		"",
		": keepalive\n\n",
		"data: {broken\n\n",
		"data: {\"choices\":[{\"delta\":{\"content\":\"안녕 🌍\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n",
		"data: {\"type\":\"response.output_text.delta\",\"delta\":\"안녕 🌍\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n",
	} {
		f.Add([]byte(seed), false)
		f.Add([]byte(seed), true)
	}
	f.Fuzz(func(t *testing.T, data []byte, responses bool) {
		if len(data) > 512<<10 {
			t.Skip()
		}
		var stream <-chan types.AdapterEvent
		body := io.NopCloser(bytes.NewReader(data))
		if responses {
			stream = (&ResponsesAdapter{}).ParseStream(context.Background(), body)
		} else {
			stream = (&ChatAdapter{}).ParseStream(context.Background(), body)
		}
		count := 0
		for range stream {
			count++
			if count > len(data)+4 {
				t.Fatalf("event count %d exceeds input-derived bound", count)
			}
		}
	})
}

func FuzzChatSchemaNormalizer(f *testing.F) {
	for _, seed := range []string{
		`{}`,
		`{"type":"object","properties":{"이름":{"type":["string","null"]}}}`,
		`{"oneOf":[{"type":"object","properties":{"a":{"type":"string"}}},{"anyOf":[{"type":"object","properties":{"b":{"type":"number"}}}]}]}`,
	} {
		f.Add([]byte(seed), uint8(0))
	}
	f.Fuzz(func(t *testing.T, raw []byte, targetIndex uint8) {
		if len(raw) > 256<<10 {
			t.Skip()
		}
		var schema map[string]any
		if json.Unmarshal(raw, &schema) != nil {
			return
		}
		targets := [...]string{"", "zen", "xai", "kimi"}
		normalized, ok := normalizeChatToolParameters(schema, targets[int(targetIndex)%len(targets)])
		if !ok {
			return
		}
		encoded, err := json.Marshal(normalized)
		if err != nil || !json.Valid(encoded) {
			t.Fatalf("normalized schema is not JSON: %#v err=%v", normalized, err)
		}
	})
}
