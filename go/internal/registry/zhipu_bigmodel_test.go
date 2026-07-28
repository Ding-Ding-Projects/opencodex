package registry

import "testing"

// Id uniqueness on the layer that actually resolves a selector to a transport.
//
// MEASURED CORRECTION: the oracle's reason for avoiding the `glm` id is that
// its FREE_PROVIDER_DIRECTORY can canonicalize a saved config onto a builtin
// base URL, which would send that config's API key to a host the user never
// chose. Go has no such directory — configuredRegistry lets a saved provider's
// own base URL win — so that credential risk does not transfer. The invariant
// that does hold here is that BigModel and the Z.AI coding plan stay distinct
// entries pointing at their own hosts.
func TestBigModelResolvesToItsOwnHost(t *testing.T) {
	const bigModel = "https://open.bigmodel.cn/api/paas/v4"
	seen := map[string]string{}
	for _, entry := range Providers {
		if previous, duplicate := seen[entry.ID]; duplicate {
			t.Fatalf("duplicate provider id %q (%s and %s)", entry.ID, previous, entry.BaseURL)
		}
		seen[entry.ID] = entry.BaseURL
	}
	if seen["zhipu-bigmodel"] != bigModel {
		t.Fatalf("zhipu-bigmodel resolves to %q, want the BigModel endpoint", seen["zhipu-bigmodel"])
	}
	// The Z.AI coding plan keeps its own destination, unaffected by this entry.
	if seen["zai"] != "https://api.z.ai/api/coding/paas/v4" {
		t.Fatalf("the Z.AI coding entry moved to %q", seen["zai"])
	}
	if seen["zai"] == bigModel {
		t.Fatal("the Z.AI coding plan and BigModel collapsed onto one host")
	}
}

// The static roster and default the picker shows when live discovery is not
// claimed.
func TestBigModelStaticModelsMatchTheOracle(t *testing.T) {
	registry := New()
	entry, ok := registry.Lookup("zhipu-bigmodel")
	if !ok {
		t.Fatal("zhipu-bigmodel is missing")
	}
	if entry.DefaultModel != "glm-4.6" {
		t.Fatalf("default model = %q", entry.DefaultModel)
	}
	if entry.LiveModels {
		t.Fatal("the entry claims live discovery, which would leave an empty picker when it does not answer")
	}
	want := []string{"glm-4.6", "glm-4.7", "glm-4.7-flash", "glm-5", "glm-5.1", "glm-4.6v"}
	if len(entry.Models) != len(want) {
		t.Fatalf("models = %#v", entry.Models)
	}
	for index, id := range want {
		if entry.Models[index].ID != id {
			t.Fatalf("model %d = %q, want %q", index, entry.Models[index].ID, id)
		}
	}
	if entry.Models[0].ContextWindow != 204_800 {
		t.Fatalf("glm-4.6 context window = %d, want 204800", entry.Models[0].ContextWindow)
	}
}
