package openai

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/providers"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

// BigModel's GLM models reject reasoning_effort outright, so an entry without
// the thinking-toggle map makes every reasoning request fail. This drives the
// REAL registry seed through the adapter rather than a hand-built config, so
// the two cannot drift apart.
//
// It uses the same seeding function the CLI provider/login paths use, which is
// what makes it a claim about production rather than about the test's own
// setup. The management API does NOT seed this way — see
// TestTheManagementAPIDoesNotSeedRegistryCapabilities for the recorded gap.
func TestZhipuBigmodelSendsTheThinkingToggleNotReasoningEffort(t *testing.T) {
	provider := seededZhipuProvider(t)

	// Both halves. A one-sided assertion still passes when the map is stuck on
	// a single value, which is exactly the defect that would send every
	// request the wrong knob.
	for effort, want := range map[string]string{"low": "disabled", "high": "enabled"} {
		body := buildZhipuBody(t, provider, "glm-4.6", effort)
		thinking, isMap := body["thinking"].(map[string]any)
		if !isMap || thinking["type"] != want {
			t.Fatalf("effort %q produced thinking=%#v, want type=%q", effort, body["thinking"], want)
		}
		if _, present := body["reasoning_effort"]; present {
			t.Fatalf("effort %q also sent reasoning_effort, which BigModel rejects: %#v", effort, body)
		}
	}

	// A model outside the toggle list keeps the ordinary ladder, so the
	// special case stays scoped to the models that actually need it.
	flash := buildZhipuBody(t, provider, "glm-4.7-flash", "high")
	if _, present := flash["thinking"]; present {
		t.Fatalf("glm-4.7-flash was sent a thinking toggle: %#v", flash)
	}
	if flash["reasoning_effort"] != "high" {
		t.Fatalf("glm-4.7-flash reasoning_effort = %#v", flash["reasoning_effort"])
	}
}

// seededZhipuProvider builds the config exactly as the CLI paths do: registry
// entry -> ProviderConfigSeed -> stored provider. Copying fields by hand here
// would let the test pass while the real seeding dropped them.
func seededZhipuProvider(t *testing.T) config.ProviderConfig {
	t.Helper()
	entry, ok := providers.GetProviderRegistryEntry("zhipu-bigmodel")
	if !ok {
		t.Fatal("zhipu-bigmodel is not in the registry")
	}
	seed := providers.ProviderConfigSeed(entry)
	return config.ProviderConfig{
		BaseURL:                        seed.BaseURL,
		Models:                         append([]string(nil), seed.Models...),
		DefaultModel:                   seed.DefaultModel,
		ThinkingToggleModels:           append([]string(nil), seed.ThinkingToggleModels...),
		ModelReasoningEffortMap:        cloneEffortMap(seed.ModelReasoningEffortMap),
		ModelReasoningEfforts:          cloneEffortLists(seed.ModelReasoningEfforts),
		ModelContextWindows:            cloneWindows(seed.ModelContextWindows),
		PreserveReasoningContentModels: append([]string(nil), seed.PreserveReasoningContentModels...),
	}
}

// The seed has to carry the capabilities, not just the endpoint. If
// ProviderConfigSeed drops them, every path that stores a provider stores a
// broken one and the failure only shows up as rejected upstream requests.
func TestTheSeedCarriesTheBigModelCapabilities(t *testing.T) {
	provider := seededZhipuProvider(t)
	if len(provider.ThinkingToggleModels) != 4 {
		t.Fatalf("seeded toggle models = %v", provider.ThinkingToggleModels)
	}
	if provider.ModelReasoningEffortMap["glm-4.6"]["high"] != "enabled" {
		t.Fatalf("seeded wire map = %v", provider.ModelReasoningEffortMap)
	}
	// Reasoning content has to survive the history rebuild for these models,
	// or a multi-turn conversation loses the model's own thinking.
	if len(provider.PreserveReasoningContentModels) != 4 {
		t.Fatalf("seeded preserve list = %v", provider.PreserveReasoningContentModels)
	}
	for _, model := range provider.Models {
		if provider.ModelContextWindows[model] != 204_800 {
			t.Fatalf("seeded window for %s = %d", model, provider.ModelContextWindows[model])
		}
	}
}

// PRE-EXISTING GAP, recorded rather than widened into this slice: Go has no
// equivalent of the oracle's routedProviderConfig (src/router.ts:229), which
// merges registry capabilities over the stored provider on every request. Go
// only seeds at write time, through the CLI. A provider added through the
// management API therefore stores whatever the client sent and never gains
// thinkingToggleModels, so its reasoning requests go out with a
// reasoning_effort BigModel rejects.
//
// This affects every thinking-toggle provider already in the registry
// (minimax, opencode-go, mimo), not only BigModel, which is why it belongs in
// its own slice rather than here. The test pins the current behaviour so the
// day someone fixes it, this fails and points at the fix.
func TestTheManagementAPIDoesNotSeedRegistryCapabilities(t *testing.T) {
	// What a management POST stores: exactly the client's payload.
	stored := config.ProviderConfig{
		Adapter: "openai-chat", BaseURL: "https://open.bigmodel.cn/api/paas/v4", APIKey: "key",
	}
	body := buildZhipuBody(t, stored, "glm-4.6", "high")
	if _, present := body["thinking"]; present {
		t.Fatal("the management path now seeds the thinking toggle; remove this test and the recorded gap with it")
	}
	if body["reasoning_effort"] != "high" {
		t.Fatalf("unseeded provider body = %#v", body)
	}
}

func cloneEffortLists(source map[string][]string) map[string][]string {
	if source == nil {
		return nil
	}
	out := make(map[string][]string, len(source))
	for model, efforts := range source {
		out[model] = append([]string(nil), efforts...)
	}
	return out
}

func cloneWindows(source map[string]int) map[string]int {
	if source == nil {
		return nil
	}
	out := make(map[string]int, len(source))
	for model, window := range source {
		out[model] = window
	}
	return out
}

func buildZhipuBody(t *testing.T, provider config.ProviderConfig, model, effort string) map[string]any {
	t.Helper()
	request := &types.NormalizedRequest{
		ModelID: model,
		Options: types.RequestOptions{Reasoning: effort},
		Context: types.RequestContext{Messages: []types.Message{{Role: "user", Content: json.RawMessage(`"hello"`)}}},
	}
	httpRequest, err := NewChatAdapter(provider, "secret", nil).BuildRequest(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	return decodeRequestBody(t, httpRequest.Body)
}

func cloneEffortMap(source map[string]map[string]string) map[string]map[string]string {
	if source == nil {
		return nil
	}
	out := make(map[string]map[string]string, len(source))
	for model, wire := range source {
		inner := make(map[string]string, len(wire))
		for effort, value := range wire {
			inner[effort] = value
		}
		out[model] = inner
	}
	return out
}
