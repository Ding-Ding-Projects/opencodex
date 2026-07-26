package cli

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/search"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

type routedSearchExecutor struct {
	registry  types.Registry
	auth      types.AuthProvider
	client    *http.Client
	backend   string
	model     string
	reasoning string
	timeout   time.Duration
}

func configuredSearchLoop(cfg config.Config, registry types.Registry, auth types.AuthProvider, client *http.Client) *search.Loop {
	settings := config.WebSearchSidecarConfig{}
	if cfg.WebSearchSidecar != nil {
		settings = *cfg.WebSearchSidecar
	}
	if cfg.ClaudeCode != nil && cfg.ClaudeCode.WebSearchSidecar != nil {
		override := cfg.ClaudeCode.WebSearchSidecar
		if override.Backend != "" {
			settings.Backend = override.Backend
		}
		if override.Model != "" {
			settings.Model = override.Model
		}
	}
	backend := search.ResolveSidecarBackend(settings.Backend)
	model := strings.TrimSpace(settings.Model)
	available := searchBackendAvailable(registry, auth, backend, model)
	input := search.PlanInput{
		HostedTool: map[string]any{"type": "web_search"}, Enabled: settings.Enabled,
		Backend: settings.Backend, Model: model, Reasoning: settings.Reasoning,
		MaxSearches: settings.MaxSearchesPerTurn, SidecarTimeoutMS: settings.TimeoutMS,
		RoutedModelStallTimeoutMS: settings.RoutedModelStallTimeoutMS,
		ConnectTimeoutMS:          cfg.ConnectTimeoutMS, BridgeStallTimeoutSec: cfg.StallTimeoutSec,
		OpenAIAvailable: backend == "openai" && available, AnthropicAvailable: backend == "anthropic" && available,
	}
	loop, _, ok, err := search.BuildSidecarLoop(input, client, func(plan search.SidecarPlan) (search.Executor, error) {
		return &routedSearchExecutor{registry: registry, auth: auth, client: client, backend: plan.Backend, model: plan.Model, reasoning: plan.Reasoning, timeout: time.Duration(plan.TimeoutMS) * time.Millisecond}, nil
	})
	if err != nil || !ok {
		return nil
	}
	return loop
}

func searchBackendAvailable(registry types.Registry, auth types.AuthProvider, backend, model string) bool {
	if registry == nil || auth == nil {
		return false
	}
	if strings.TrimSpace(model) == "" {
		if backend == "anthropic" {
			model = search.DefaultAnthropicSidecarModel
		} else {
			model = search.DefaultOpenAISidecarModel
		}
	}
	resolved, err := registry.ResolveModel(model)
	if err != nil && backend == "anthropic" && !strings.Contains(model, "/") {
		resolved, err = registry.ResolveModel("anthropic/" + model)
	}
	if err != nil || resolved == nil {
		return false
	}
	if projection, ok := auth.(interface{ SearchCredentialAvailable(string) bool }); ok && !projection.SearchCredentialAvailable(resolved.Provider) {
		return false
	}
	_, err = registry.ResolveTransport(resolved.Provider, nil)
	return err == nil
}

func (executor *routedSearchExecutor) Search(ctx context.Context, query string, hostedTool map[string]any) (search.Result, error) {
	if executor == nil || executor.registry == nil {
		return search.Result{}, fmt.Errorf("web search sidecar registry is unavailable")
	}
	resolved, err := executor.registry.ResolveModel(executor.model)
	if err != nil && executor.backend == "anthropic" && !strings.Contains(executor.model, "/") {
		resolved, err = executor.registry.ResolveModel("anthropic/" + executor.model)
	}
	if err != nil {
		return search.Result{}, err
	}
	var credential *types.AuthContext
	if executor.auth != nil {
		credential, err = executor.auth.ResolveAuth(ctx, resolved.Provider, "")
		if err != nil {
			return search.Result{}, err
		}
	}
	transport, err := executor.registry.ResolveTransport(resolved.Provider, credential)
	if err != nil {
		return search.Result{}, err
	}
	headers := make(http.Header)
	for name, value := range transport.Headers {
		headers.Set(name, value)
	}
	if credential != nil {
		for name, value := range credential.Headers {
			headers.Set(name, value)
		}
	}
	if executor.backend == "anthropic" {
		return (&search.AnthropicExecutor{Client: executor.client, BaseURL: transport.BaseURL, Model: resolved.Model, Headers: headers, Timeout: executor.timeout}).Search(ctx, query, hostedTool)
	}
	baseURL := transport.BaseURL
	if resolved.Provider == "openai" && strings.Contains(baseURL, "/backend-api/codex") {
		baseURL = strings.TrimRight(baseURL, "/") + "/responses"
	}
	return (&search.OpenAIExecutor{Client: executor.client, BaseURL: baseURL, Model: resolved.Model, Reasoning: executor.reasoning, Headers: headers, Timeout: executor.timeout}).Search(ctx, query, hostedTool)
}
