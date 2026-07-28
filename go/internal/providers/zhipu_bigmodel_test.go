package providers

import "testing"

func zhipuEntry(t *testing.T) ProviderRegistryEntry {
	t.Helper()
	for _, entry := range ListRegistryEntries() {
		if entry.ID == "zhipu-bigmodel" {
			return entry
		}
	}
	t.Fatal("zhipu-bigmodel is missing from the registry")
	return ProviderRegistryEntry{}
}

// Every field below was measured by running the oracle registry, not read off
// the source.
func TestZhipuBigmodelMatchesTheOracleEntry(t *testing.T) {
	entry := zhipuEntry(t)
	if entry.Label != "Zhipu AI — BigModel" || entry.Adapter != "openai-chat" || entry.AuthKind != AuthKey {
		t.Fatalf("entry = %#v", entry)
	}
	if entry.BaseURL != "https://open.bigmodel.cn/api/paas/v4" {
		t.Fatalf("base url = %s", entry.BaseURL)
	}
	if entry.DashboardURL != "https://bigmodel.cn/console/usercenter/apikeys" {
		t.Fatalf("dashboard = %s", entry.DashboardURL)
	}
	if entry.DefaultModel != "glm-4.6" || entry.JawcodeBundle != "zai" {
		t.Fatalf("default=%s bundle=%s", entry.DefaultModel, entry.JawcodeBundle)
	}
	want := []string{"glm-4.6", "glm-4.7", "glm-4.7-flash", "glm-5", "glm-5.1", "glm-4.6v"}
	if len(entry.Models) != len(want) {
		t.Fatalf("models = %v", entry.Models)
	}
	for index, model := range want {
		if entry.Models[index] != model {
			t.Fatalf("models = %v, want %v", entry.Models, want)
		}
	}
	// EVERY model needs its own window. Go has no jawcode-bundle resolver, so
	// a model left without one is advertised with a generic 128k fallback and
	// starts compacting a third of the way through the real context.
	for _, model := range want {
		if entry.ModelContextWindows[model] != 204_800 {
			t.Fatalf("%s context window = %d, want 204800", model, entry.ModelContextWindows[model])
		}
	}
	if entry.Note == "" {
		t.Fatal("the entry carries no note")
	}
}

// Only glm-4.6v accepts images. Advertising vision on the text models would
// send images to models that reject them.
func TestOnlyTheVisionModelAcceptsImages(t *testing.T) {
	entry := zhipuEntry(t)
	for _, model := range []string{"glm-4.6", "glm-4.7", "glm-4.7-flash", "glm-5", "glm-5.1"} {
		modalities := entry.ModelInputModalities[model]
		if len(modalities) != 1 || modalities[0] != "text" {
			t.Fatalf("%s modalities = %v, want text only", model, modalities)
		}
	}
	vision := entry.ModelInputModalities["glm-4.6v"]
	if len(vision) != 2 || vision[0] != "text" || vision[1] != "image" {
		t.Fatalf("glm-4.6v modalities = %v", vision)
	}
}

// GLM exposes a binary thinking knob. Without the toggle map the adapter would
// send a reasoning_effort BigModel rejects, and every reasoning request would
// fail.
func TestTheThinkingToggleCoversTheReasoningModels(t *testing.T) {
	entry := zhipuEntry(t)
	toggles := map[string]bool{}
	for _, model := range entry.ThinkingToggleModels {
		toggles[model] = true
	}
	for _, model := range []string{"glm-4.6", "glm-4.7", "glm-5", "glm-5.1"} {
		if !toggles[model] {
			t.Fatalf("%s is not a thinking-toggle model: %v", model, entry.ThinkingToggleModels)
		}
		wire := entry.ModelReasoningEffortMap[model]
		// Both halves: a one-sided assertion still passes when the map is
		// stuck on a single value.
		if wire["low"] != "disabled" || wire["high"] != "enabled" {
			t.Fatalf("%s wire map = %v", model, wire)
		}
		if len(entry.ModelReasoningEfforts[model]) != 5 {
			t.Fatalf("%s efforts = %v", model, entry.ModelReasoningEfforts[model])
		}
	}
	// glm-4.7-flash and the vision model are NOT toggle models; giving them a
	// map would send a knob they do not have.
	for _, model := range []string{"glm-4.7-flash", "glm-4.6v"} {
		if toggles[model] {
			t.Fatalf("%s was declared a thinking-toggle model", model)
		}
	}
}

// A live-discovery claim that does not answer leaves the user with an empty
// picker instead of the static list.
func TestNoLiveModelClaimIsMade(t *testing.T) {
	if zhipuEntry(t).LiveModels {
		t.Fatal("the entry claims live model discovery, which has not been observed to answer on this host")
	}
}

// Provider ids must be unique across the registry. The oracle has a stronger
// version of this rule because its FREE_PROVIDER_DIRECTORY can canonicalize a
// saved config onto a builtin base URL, which is why the id is not `glm` or
// `glm-cn` there. Go has no such directory and a saved config keeps its own
// base URL, so the credential-misdirection risk does NOT transfer — what
// remains, and what this checks, is that a duplicate id cannot make provider
// lookup ambiguous.
func TestProviderIDsAreUnique(t *testing.T) {
	seen := map[string]string{}
	for _, entry := range ListRegistryEntries() {
		if previous, duplicate := seen[entry.ID]; duplicate {
			t.Fatalf("duplicate provider id %q (%s and %s)", entry.ID, previous, entry.BaseURL)
		}
		seen[entry.ID] = entry.BaseURL
	}
	// The Z.AI coding plan keeps its own destination: these are two different
	// products on two different hosts, and collapsing them would send a key to
	// the wrong one.
	if seen["zai"] != "https://api.z.ai/api/coding/paas/v4" {
		t.Fatalf("the Z.AI coding entry moved to %s", seen["zai"])
	}
	if seen["zhipu-bigmodel"] == seen["zai"] {
		t.Fatal("BigModel and the Z.AI coding plan resolve to the same host")
	}
}
