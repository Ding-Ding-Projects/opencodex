package cli

import (
	"bytes"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/config"
)

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
