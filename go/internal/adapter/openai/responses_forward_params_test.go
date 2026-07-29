package openai

import (
	"encoding/json"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

func forwardBodyKeys(t *testing.T, raw []byte, forward bool) map[string]any {
	t.Helper()
	request := &types.NormalizedRequest{ModelID: "gpt-5.6-sol", RawBody: raw}
	provider := config.ProviderConfig{Adapter: "openai-responses"}
	if forward {
		provider.AuthMode = "forward"
	}
	encoded, err := responsesRequestBodyForProvider(request, forward, provider)
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	if err := json.Unmarshal(encoded, &body); err != nil {
		t.Fatal(err)
	}
	return body
}

// The native ChatGPT backend rejects these outright with
// {"detail":"Unsupported parameter: …"}, and the Anthropic wire translation puts them in
// every Claude Code turn (max_tokens becomes max_output_tokens, plus the sampling params).
// The client-supplied body reaches the adapter as RawBody, which used to bypass the strip
// the synthesized path already performed, so every subagent on a native model got a 400.
func TestForwardRequestStripsParametersTheNativeBackendRejects(t *testing.T) {
	raw := []byte(`{"input":[],"max_output_tokens":4096,"temperature":0.7,"top_p":0.9,"stop":["x"],"user":"u","metadata":{"user_id":"u"},"reasoning":{"effort":"high"}}`)
	body := forwardBodyKeys(t, raw, true)
	// The adapter layer removes exactly what the oracle's adapter removes; the sampling
	// params are the Claude route's job (StripClaudeWireSamplingParams), so a direct
	// Responses client keeps what it sent.
	for _, key := range []string{"max_output_tokens", "metadata"} {
		if _, present := body[key]; present {
			t.Fatalf("forward body still carries %q: %v", key, body)
		}
	}
	if body["temperature"] == nil {
		t.Fatalf("adapter must not strip sampling params a direct client sent: %v", body)
	}
	if reasoning, ok := body["reasoning"].(map[string]any); !ok || reasoning["effort"] != "high" {
		t.Fatalf("reasoning must survive the strip: %v", body["reasoning"])
	}
	if body["model"] != "gpt-5.6-sol" {
		t.Fatalf("model = %v", body["model"])
	}
}

// A routed provider that accepts sampling parameters must keep receiving them.
func TestRoutedRequestKeepsSamplingParameters(t *testing.T) {
	raw := []byte(`{"input":[],"max_output_tokens":4096,"temperature":0.7}`)
	body := forwardBodyKeys(t, raw, false)
	if body["max_output_tokens"] == nil || body["temperature"] == nil {
		t.Fatalf("routed body lost sampling parameters: %v", body)
	}
}

// The Anthropic wire adds these, and the Responses wire rejects the first one it meets.
// Keyed on the wire rather than on authMode, exactly as the oracle is.
func TestClaudeWireStripsSamplingParamsForAResponsesRoute(t *testing.T) {
	raw := []byte(`{"input":[],"max_output_tokens":4096,"temperature":0.7,"top_p":0.9,"stop":["x"],"user":"u","metadata":{"user_id":"u"}}`)
	stripped := StripClaudeWireSamplingParams(raw)
	var body map[string]any
	if err := json.Unmarshal(stripped, &body); err != nil {
		t.Fatal(err)
	}
	for _, key := range claudeWireSamplingParams {
		if _, present := body[key]; present {
			t.Fatalf("claude-wire body still carries %q: %v", key, body)
		}
	}
	// metadata is the adapter's to remove, and only for a forward route.
	if body["metadata"] == nil {
		t.Fatalf("claude-wire strip must leave metadata to the adapter: %v", body)
	}
}

func TestClaudeWireStripIsANoOpWhenNothingMatches(t *testing.T) {
	raw := []byte(`{"input":[],"reasoning":{"effort":"high"}}`)
	if got := string(StripClaudeWireSamplingParams(raw)); got != string(raw) {
		t.Fatalf("no-op strip rewrote the body: %s", got)
	}
	if got := string(StripClaudeWireSamplingParams(nil)); got != "" {
		t.Fatalf("nil body = %q", got)
	}
}
