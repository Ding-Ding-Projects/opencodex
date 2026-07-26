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
	if settings.Enabled != nil && !*settings.Enabled {
		return nil
	}
	backend := search.ResolveSidecarBackend(settings.Backend)
	model := strings.TrimSpace(settings.Model)
	if model == "" {
		if backend == "anthropic" {
			model = search.DefaultAnthropicSidecarModel
		} else {
			model = search.DefaultOpenAISidecarModel
		}
	}
	timeoutMS := settings.TimeoutMS
	if timeoutMS <= 0 {
		timeoutMS = search.DefaultSidecarTimeoutMS
	}
	return &search.Loop{
		Executor:    &routedSearchExecutor{registry: registry, auth: auth, client: client, backend: backend, model: model, reasoning: settings.Reasoning, timeout: time.Duration(timeoutMS) * time.Millisecond},
		MaxSearches: settings.MaxSearchesPerTurn,
	}
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
