package anthropic

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/types"
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

func FuzzAnthropicBuildRequestBoundary(f *testing.F) {
	f.Add(byte(0), []byte(`"hello"`), []byte(`"auto"`))
	f.Add(byte(1), []byte(`[{"type":"thinking","thinking":"x","signature":"reasoning_fake"},{"type":"toolCall","id":"c","name":"run"}]`), []byte(`{"mode":"required","allowedTools":["run"]}`))
	f.Add(byte(2), []byte(`[{"type":"image","imageUrl":"data:image/png;base64,broken"}]`), []byte(`null`))
	f.Fuzz(func(t *testing.T, roleByte byte, content, toolChoice []byte) {
		if len(content) > 128<<10 || len(toolChoice) > 32<<10 || !json.Valid(content) {
			t.Skip()
		}
		roles := [...]string{"user", "assistant", "toolResult", "developer"}
		request := &types.NormalizedRequest{
			ModelID: "claude-sonnet-5", Stream: roleByte&1 == 1,
			Context: types.RequestContext{Messages: []types.Message{{Role: roles[int(roleByte)%len(roles)], Content: append(json.RawMessage(nil), content...), ToolCallID: "call-1"}}},
		}
		if json.Valid(toolChoice) {
			request.Options.ToolChoice = append(json.RawMessage(nil), toolChoice...)
		}
		adapter := NewAdapter(config.ProviderConfig{BaseURL: "https://api.anthropic.com"}, "key", nil, "short")
		httpRequest, err := adapter.BuildRequest(context.Background(), request)
		if err != nil {
			return
		}
		payload, err := io.ReadAll(httpRequest.Body)
		if err != nil || !json.Valid(payload) {
			t.Fatalf("invalid built request: err=%v payload=%q", err, payload)
		}
	})
}

func FuzzAnthropicImageSnifferAndGuard(f *testing.F) {
	for _, seed := range [][]byte{
		{},
		{0x89, 'P', 'N', 'G'},
		pngHeader(8000, 2000),
		jpegHeader(2000, 2000),
		[]byte("GIF89a\x00\x00\x00\x00"),
	} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, raw []byte) {
		if len(raw) > 128<<10 {
			t.Skip()
		}
		encoded := base64.StdEncoding.EncodeToString(raw)
		dimensions, ok := SniffImageDimensions(encoded)
		if ok && (dimensions.Width < 0 || dimensions.Height < 0) {
			t.Fatalf("negative dimensions: %#v", dimensions)
		}
		nested := []any{map[string]any{
			"role": "user", "content": []any{map[string]any{
				"type": "tool_result", "tool_use_id": "call-1", "content": []any{imageBlock(encoded)},
			}},
		}}
		EnforceAnthropicImageLimits(nested)
		if _, err := json.Marshal(nested); err != nil {
			t.Fatalf("guard produced non-JSON state: %v", err)
		}
	})
}
