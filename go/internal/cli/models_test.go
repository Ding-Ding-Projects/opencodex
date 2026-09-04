package cli

import (
	"bytes"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/config"
)

func TestCustomModelCRUDPersistsSeparatelyFromProviderModels(t *testing.T) {
	home := t.TempDir()
	t.Setenv("OPENCODEX_HOME", home)
	cfg := config.Default()
	cfg.DefaultProvider = "test"
	cfg.Providers["test"] = config.ProviderConfig{Adapter: "openai-chat", BaseURL: "https://example.test/v1", Models: []string{"built-in"}}
	if err := config.Save(filepath.Join(home, "config.json"), &cfg); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	streams := IO{Out: &output, Err: &output}
	if err := runModels([]string{"add", "test", "custom-v1", "--display-name", "Custom", "--context-window", "128000", "--modalities", "text,image,text"}, streams); err != nil {
		t.Fatal(err)
	}
	loaded, err := config.Load(filepath.Join(home, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(loaded.CustomModels) != 1 || loaded.CustomModels[0].ModelID != "custom-v1" || strings.Join(loaded.CustomModels[0].InputModalities, ",") != "text,image" {
		t.Fatalf("custom models = %#v", loaded.CustomModels)
	}
	if strings.Join(loaded.Providers["test"].Models, ",") != "built-in" {
		t.Fatal("custom add changed provider.Models")
	}
	output.Reset()
	if err := runModels([]string{"list-custom", "--json"}, streams); err != nil || !strings.Contains(output.String(), `"modelId": "custom-v1"`) {
		t.Fatalf("list-custom output=%q err=%v", output.String(), err)
	}
	if err := runModels([]string{"remove", "test/custom-v1", "--yes"}, streams); err != nil {
		t.Fatal(err)
	}
	loaded, err = config.Load(filepath.Join(home, "config.json"))
	if err != nil || len(loaded.CustomModels) != 0 {
		t.Fatalf("custom model not removed: %#v, %v", loaded.CustomModels, err)
	}
}

func TestCollectConfiguredModelsIncludesEffortLadder(t *testing.T) {
	cfg := config.Default()
	cfg.DefaultProvider = "test"
	cfg.Providers["test"] = config.ProviderConfig{
		Adapter: "openai-chat", BaseURL: "https://example.test/v1",
		DefaultModel: "reasoner", Models: []string{"reasoner", "plain"},
		ModelContextWindows:   map[string]int{"reasoner": 200_000},
		ModelInputModalities:  map[string][]string{"reasoner": {"text", "image"}},
		ModelReasoningEfforts: map[string][]string{"reasoner": {"high", "low", "max"}},
		NoReasoningModels:     []string{"plain"}, NoVisionModels: []string{"plain"},
	}
	rows := collectConfiguredModels(cfg, "test")
	if len(rows) != 2 {
		t.Fatalf("models = %#v", rows)
	}
	if !rows[0].Default || rows[0].ContextWindow == nil || *rows[0].ContextWindow != 200_000 {
		t.Fatalf("reasoner = %#v", rows[0])
	}
	if got := strings.Join(rows[0].ReasoningEfforts, ","); got != "low,high,max" {
		t.Fatalf("efforts = %q", got)
	}
	if len(rows[1].ReasoningEfforts) != 0 || strings.Join(rows[1].InputModalities, ",") != "text" {
		t.Fatalf("plain model = %#v", rows[1])
	}
}

func TestModelsEffortsPrintsCanonicalLadder(t *testing.T) {
	var output bytes.Buffer
	if err := modelsEfforts(nil, IO{Out: &output, Err: &output}); err != nil {
		t.Fatal(err)
	}
	for _, effort := range []string{"none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"} {
		if !strings.Contains(output.String(), effort) {
			t.Fatalf("effort %q missing from %q", effort, output.String())
		}
	}
}
