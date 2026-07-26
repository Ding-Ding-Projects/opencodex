package search

import (
	"context"
	"errors"
	"testing"
)

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

type plannedExecutor struct{}

func (plannedExecutor) Search(context.Context, string, map[string]any) (Result, error) {
	return Result{}, nil
}

func TestBuildSidecarLoopUsesCanonicalPlan(t *testing.T) {
	hosted := map[string]any{"type": "web_search", "search_context_size": "high"}
	var received SidecarPlan
	loop, plan, ok, err := BuildSidecarLoop(PlanInput{
		HostedTool: hosted, OpenAIAvailable: true, MaxSearches: 5,
		SidecarTimeoutMS: 75_000, RoutedModelStallTimeoutMS: 410_000, ConnectTimeoutMS: 220_000,
	}, nil, func(value SidecarPlan) (Executor, error) {
		received = value
		return plannedExecutor{}, nil
	})
	if err != nil || !ok || loop == nil {
		t.Fatalf("BuildSidecarLoop() = %#v, %#v, %t, %v", loop, plan, ok, err)
	}
	if received.Model != DefaultOpenAISidecarModel || received.TimeoutMS != 75_000 || received.RoutedModelStallTimeoutMS != 410_000 || received.StallTimeoutSec != 440 {
		t.Fatalf("factory plan = %#v", received)
	}
	if loop.MaxSearches != 5 || loop.Executor == nil || loop.HostedTool["search_context_size"] != "high" {
		t.Fatalf("planned loop = %#v", loop)
	}
	runner, ok := loop.Runner.(HTTPRunner)
	if !ok || runner.Progress.InactivityTimeout.String() != "6m50s" {
		t.Fatalf("planned runner = %#v", loop.Runner)
	}
	hosted["search_context_size"] = "mutated"
	if plan.HostedTool["search_context_size"] != "high" || loop.HostedTool["search_context_size"] != "high" {
		t.Fatal("planned loop retained caller-owned hosted tool aliases")
	}
}

func TestBuildSidecarLoopFailsClosedBeforeExecutorResolution(t *testing.T) {
	calls := 0
	loop, _, ok, err := BuildSidecarLoop(PlanInput{
		HostedTool: map[string]any{"type": "web_search"}, Backend: "anthropic", OpenAIAvailable: true,
	}, nil, func(SidecarPlan) (Executor, error) {
		calls++
		return plannedExecutor{}, nil
	})
	if err != nil || ok || loop != nil || calls != 0 {
		t.Fatalf("unavailable backend = %#v, %t, calls=%d, err=%v", loop, ok, calls, err)
	}
	want := errors.New("credential resolution failed")
	_, _, ok, err = BuildSidecarLoop(PlanInput{
		HostedTool: map[string]any{"type": "web_search"}, OpenAIAvailable: true,
	}, nil, func(SidecarPlan) (Executor, error) { return nil, want })
	if ok || !errors.Is(err, want) {
		t.Fatalf("factory failure = ok=%t err=%v", ok, err)
	}
}

func TestSyntheticToolCarriesInterceptionMarker(t *testing.T) {
	tool := SyntheticTool()
	if !tool.WebSearch || tool.Name != ToolName {
		t.Fatalf("SyntheticTool() = %#v", tool)
	}
}
