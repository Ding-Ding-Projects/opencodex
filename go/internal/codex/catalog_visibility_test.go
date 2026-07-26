package codex

import (
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

func TestFilterVisibleRuntimeModelsUsesNativeAndConfiguredProvidersOnly(t *testing.T) {
	cfg := config.Default()
	cfg.Providers = map[string]config.ProviderConfig{
		"configured": {SelectedModels: []string{"kept"}},
		"disabled":   {Disabled: true},
	}
	cfg.DisabledModels = []string{"gpt-5.4-mini", "configured/hidden"}
	models := []types.ModelEntry{
		{ID: "registry/unconfigured", Provider: "registry"},
		{ID: "configured/kept", Provider: "configured", ContextWindow: 42},
		{ID: "configured/hidden", Provider: "configured"},
		{ID: "disabled/model", Provider: "disabled"},
	}
	got := FilterVisibleRuntimeModels(models, cfg)
	foundConfigured, foundUnconfigured, foundDisabledNative := false, false, false
	for _, model := range got {
		foundConfigured = foundConfigured || model.ID == "configured/kept"
		foundUnconfigured = foundUnconfigured || model.ID == "registry/unconfigured"
		foundDisabledNative = foundDisabledNative || model.ID == "gpt-5.4-mini"
	}
	if !foundConfigured || foundUnconfigured || foundDisabledNative {
		t.Fatalf("visible models=%#v", got)
	}
	if got[0].ID != NativeOpenAIModels[0] {
		t.Fatalf("native models must lead in canonical order: %#v", got)
	}
}
