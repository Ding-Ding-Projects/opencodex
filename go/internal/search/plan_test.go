package search

import "testing"

func boolPointer(value bool) *bool { return &value }

func TestWebSearchTimeoutPlanning(t *testing.T) {
	if got := ResolveRoutedModelStallTimeoutMS(0); got != DefaultRoutedModelStallTimeoutMS {
		t.Fatalf("ResolveRoutedModelStallTimeoutMS(0) = %d", got)
	}
	if got := WebSearchStallTimeoutSec(100, 200_000, 400_001, 60_000); got != 431 {
		t.Fatalf("WebSearchStallTimeoutSec() = %d, want 431", got)
	}
}

func TestBuildSidecarPlanPrecedenceAndDefaults(t *testing.T) {
	hosted := map[string]any{"type": "web_search", "search_context_size": "high"}
	plan, ok := BuildSidecarPlan(PlanInput{
		HostedTool: hosted, Backend: "anthropic", AnthropicAvailable: true,
		ProviderNoVisionModels: []string{"text-model"}, ModelID: "text-model",
	})
	if !ok || plan.Backend != "anthropic" || plan.Model != DefaultAnthropicSidecarModel || !plan.DescribeImages {
		t.Fatalf("BuildSidecarPlan() = %#v, %t", plan, ok)
	}
	if plan.HostedTool["search_context_size"] != "high" || plan.MaxSearches != DefaultMaxSearches {
		t.Fatalf("hosted config/defaults were not preserved: %#v", plan)
	}
	if _, ok := BuildSidecarPlan(PlanInput{HostedTool: hosted, Backend: "anthropic", OpenAIAvailable: true}); ok {
		t.Fatal("explicit anthropic backend must fail closed without Anthropic credentials")
	}
	if ShouldResolveOpenAISidecar(hosted, false, boolPointer(false), "openai") {
		t.Fatal("disabled sidecar should not resolve")
	}
}

func TestSyntheticToolCarriesInterceptionMarker(t *testing.T) {
	tool := SyntheticTool()
	if !tool.WebSearch || tool.Name != ToolName {
		t.Fatalf("SyntheticTool() = %#v", tool)
	}
}
