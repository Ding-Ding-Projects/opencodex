package cli

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	anthropicadapter "github.com/lidge-jun/opencodex-go/internal/adapter/anthropic"
	googleadapter "github.com/lidge-jun/opencodex-go/internal/adapter/google"
	openaiadapter "github.com/lidge-jun/opencodex-go/internal/adapter/openai"
	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/oauth"
	"github.com/lidge-jun/opencodex-go/internal/providers"
	"github.com/lidge-jun/opencodex-go/internal/registry"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

func resolveTestAdapter(t *testing.T, provider string, cfg config.ProviderConfig) types.Adapter {
	t.Helper()
	all := config.Default()
	all.Providers[provider] = cfg
	reg := configuredRegistry(all)
	adapter, err := adapterResolver(reg, all)(
		&types.ResolvedModel{Provider: provider, Model: cfg.DefaultModel},
		&types.Transport{BaseURL: cfg.BaseURL, Headers: cfg.Headers},
		&types.AuthContext{APIKey: "test-key", AccessToken: "test-token"},
		http.Header{"X-Codex-Turn-Metadata": {"metadata"}},
	)
	if err != nil {
		t.Fatal(err)
	}
	return adapter
}

func TestAdapterResolverUsesProviderAwareAnthropicConstructor(t *testing.T) {
	cfg := config.Default()
	cfg.CacheRetention = "long"
	cfg.Providers["anthropic"] = config.ProviderConfig{Adapter: "anthropic", BaseURL: "https://api.anthropic.com", AuthMode: "oauth", DefaultModel: "claude-opus-4-7"}
	reg := configuredRegistry(cfg)
	resolved, err := adapterResolver(reg, cfg)(
		&types.ResolvedModel{Provider: "anthropic", Model: "claude-opus-4-7"},
		&types.Transport{BaseURL: "https://api.anthropic.com"},
		&types.AuthContext{AccessToken: "oauth-token"}, nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	adapter, ok := unwrapAdapter(resolved).(*anthropicadapter.Adapter)
	if !ok {
		t.Fatalf("Anthropic factory returned %T", resolved)
	}
	request, err := adapter.BuildRequest(context.Background(), &types.NormalizedRequest{
		ModelID: "claude-opus-4-7",
		Context: types.RequestContext{
			Messages: []types.Message{{Role: "user", Content: json.RawMessage(`"hello"`)}},
			Tools:    []types.Tool{{Name: "lookup", Description: "Lookup", Parameters: map[string]any{"type": "object"}}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	tools, _ := body["tools"].([]any)
	if len(tools) != 1 {
		t.Fatalf("Anthropic tools = %#v", body["tools"])
	}
	tool, _ := tools[0].(map[string]any)
	if adapter.CacheRetention != "long" || request.Header.Get("Authorization") != "Bearer oauth-token" || tool["name"] != "custom_lookup" || body["cache_control"] == nil {
		t.Fatalf("Anthropic factory policy missing: retention=%q headers=%#v body=%#v", adapter.CacheRetention, request.Header, body)
	}
}

func TestAdapterResolverUsesProviderAwareOpenAIConstructors(t *testing.T) {
	chatCfg := config.ProviderConfig{
		Adapter: "openai-chat", BaseURL: "https://chat.example/v1", DefaultModel: "reasoner",
		AutoToolChoiceOnlyModels: []string{"reasoner"}, ModelReasoningEffortMap: map[string]map[string]string{"reasoner": {"high": "enabled"}},
		PreserveReasoningContentModels: []string{"reasoner"}, NoTemperatureModels: []string{"reasoner"},
	}
	chat, ok := unwrapAdapter(resolveTestAdapter(t, "custom-chat", chatCfg)).(*openaiadapter.ChatAdapter)
	if !ok {
		t.Fatalf("chat factory returned %T", chat)
	}
	if chat.Provider.BaseURL != chatCfg.BaseURL || len(chat.Provider.AutoToolChoiceOnlyModels) != 1 || chat.Provider.ModelReasoningEffortMap["reasoner"]["high"] != "enabled" || len(chat.Provider.PreserveReasoningContentModels) != 1 {
		t.Fatalf("chat provider policy was dropped: %#v", chat.Provider)
	}
	temperature := 0.7
	chatRequest, err := chat.BuildRequest(context.Background(), &types.NormalizedRequest{
		ModelID: "reasoner", Context: types.RequestContext{Messages: []types.Message{{Role: "user", Content: json.RawMessage(`"hello"`)}}},
		Options: types.RequestOptions{Temperature: &temperature, Reasoning: "high"},
	})
	if err != nil {
		t.Fatal(err)
	}
	var chatBody map[string]any
	if err := json.NewDecoder(chatRequest.Body).Decode(&chatBody); err != nil {
		t.Fatal(err)
	}
	if _, present := chatBody["temperature"]; present || chatBody["reasoning_effort"] != "enabled" {
		t.Fatalf("chat request did not apply provider policy: %#v", chatBody)
	}

	responsesCfg := config.ProviderConfig{Adapter: "openai-responses", BaseURL: "https://responses.example", ResponsesPath: "/custom/responses", NoReasoningModels: []string{"plain"}}
	responses, ok := unwrapAdapter(resolveTestAdapter(t, "custom-responses", responsesCfg)).(*openaiadapter.ResponsesAdapter)
	if !ok {
		t.Fatalf("responses factory returned %T", responses)
	}
	if responses.ResponsesPath != "/custom/responses" || len(responses.Provider.NoReasoningModels) != 1 || responses.IncomingHeaders.Get("X-Codex-Turn-Metadata") != "metadata" {
		t.Fatalf("responses provider policy was dropped: %#v", responses)
	}
	responsesRequest, err := responses.BuildRequest(context.Background(), &types.NormalizedRequest{ModelID: "plain", Context: types.RequestContext{Messages: []types.Message{{Role: "user", Content: json.RawMessage(`"hello"`)}}}})
	if err != nil {
		t.Fatal(err)
	}
	if responsesRequest.URL.String() != "https://responses.example/custom/responses" {
		t.Fatalf("responses path policy = %s", responsesRequest.URL)
	}
}

func TestAdapterResolverAppliesOpenRouterRoutingPolicy(t *testing.T) {
	allowFallbacks := false
	cfg := config.ProviderConfig{
		Adapter: "openai-chat", BaseURL: "https://openrouter.ai/api/v1", DefaultModel: "vendor/model",
		OpenRouterRouting: &providers.OpenRouterProviderRouting{Order: []string{"anthropic"}},
		ModelOpenRouterRouting: map[string]providers.OpenRouterProviderRouting{
			"vendor/model": {Only: []string{"google"}, AllowFallbacks: &allowFallbacks},
		},
	}
	adapter, ok := unwrapAdapter(resolveTestAdapter(t, "openrouter", cfg)).(*openaiadapter.ChatAdapter)
	if !ok {
		t.Fatalf("OpenRouter factory returned %T", adapter)
	}
	request, err := adapter.BuildRequest(context.Background(), &types.NormalizedRequest{
		ModelID: "vendor/model", Context: types.RequestContext{Messages: []types.Message{{Role: "user", Content: json.RawMessage(`"hello"`)}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	routing, _ := body["provider"].(map[string]any)
	only, _ := routing["only"].([]any)
	if len(only) != 1 || only[0] != "google" || routing["allow_fallbacks"] != false {
		t.Fatalf("OpenRouter routing policy = %#v", routing)
	}
}

func TestConfiguredRegistryAppliesStaticHeadersAndDefaultProvider(t *testing.T) {
	cfg := config.Default()
	cfg.DefaultProvider = "custom"
	cfg.Providers["custom"] = config.ProviderConfig{
		Adapter: "openai-chat", BaseURL: "https://custom.example/v1", DefaultModel: "custom-default",
		Headers: map[string]string{"X-Provider-Policy": "enabled"},
	}
	reg := configuredRegistry(cfg)
	resolved, err := reg.ResolveModel("unqualified-model")
	if err != nil || resolved.Provider != "custom" {
		t.Fatalf("configured default provider was not applied: resolved=%#v err=%v", resolved, err)
	}
	entry, ok := reg.Lookup("custom")
	if !ok {
		t.Fatal("custom provider missing")
	}
	transport, err := registry.ResolveProviderTransport(entry, &types.AuthContext{APIKey: "secret"})
	if err != nil {
		t.Fatal(err)
	}
	adapter, err := adapterResolver(reg, cfg)(resolved, transport, &types.AuthContext{APIKey: "secret"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	request, err := adapter.BuildRequest(context.Background(), &types.NormalizedRequest{
		ModelID: resolved.Model, Context: types.RequestContext{Messages: []types.Message{{Role: "user", Content: json.RawMessage(`"hello"`)}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if request.Header.Get("X-Provider-Policy") != "enabled" {
		t.Fatalf("static provider headers were not applied: %#v", request.Header)
	}
}

func TestConfiguredAuthHonorsExplicitKeyModeForOAuthRegistryProvider(t *testing.T) {
	cfg := config.FreshInstall()
	cfg.Providers["kiro"] = config.ProviderConfig{Adapter: "kiro", BaseURL: "https://example.test", AuthMode: "key", APIKey: "configured-key"}
	resolver, err := configuredAuthWithStore(cfg, oauth.NewCredentialStore(filepath.Join(t.TempDir(), "auth.json")))
	if err != nil {
		t.Fatal(err)
	}
	auth, err := resolver.ResolveAuth(context.Background(), "kiro", "")
	if err != nil {
		t.Fatal(err)
	}
	if auth.APIKey != "configured-key" || auth.Kind != "api-key" {
		t.Fatalf("auth = %#v", auth)
	}
}

func TestAdapterResolverMimoUsesProviderDoForBootstrapAnd401Retry(t *testing.T) {
	var bootstraps, chats atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/bootstrap":
			attempt := bootstraps.Add(1)
			_ = json.NewEncoder(writer).Encode(map[string]string{"jwt": "jwt-" + string(rune('0'+attempt))})
		case "/chat":
			attempt := chats.Add(1)
			if request.Header.Get("Authorization") != "Bearer jwt-"+string(rune('0'+attempt)) {
				t.Errorf("chat attempt %d used %q", attempt, request.Header.Get("Authorization"))
			}
			if attempt == 1 {
				writer.WriteHeader(http.StatusUnauthorized)
				return
			}
			_, _ = writer.Write([]byte(`{"ok":true}`))
		default:
			http.NotFound(writer, request)
		}
	}))
	defer upstream.Close()

	resolved := resolveTestAdapter(t, "mimo-free", config.ProviderConfig{Adapter: "mimo-free", BaseURL: upstream.URL, DefaultModel: "mimo-auto"})
	mimo, ok := unwrapAdapter(resolved).(*openaiadapter.MimoAdapter)
	if !ok {
		t.Fatalf("MiMo factory returned %T", unwrapAdapter(resolved))
	}
	mimo.Client = upstream.Client()
	mimo.BootstrapURL = upstream.URL + "/bootstrap"
	mimo.ChatURL = upstream.URL + "/chat"
	mimo.ConfigDir = t.TempDir()
	request, err := resolved.BuildRequest(context.Background(), &types.NormalizedRequest{ModelID: "mimo-auto", Context: types.RequestContext{Messages: []types.Message{{Role: "user", Content: json.RawMessage(`"hello"`)}}}})
	if err != nil {
		t.Fatal(err)
	}
	response, err := newAdapterAwareClient(upstream.Client()).Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || bootstraps.Load() != 2 || chats.Load() != 2 {
		t.Fatalf("status=%d bootstraps=%d chats=%d", response.StatusCode, bootstraps.Load(), chats.Load())
	}
}

func TestAdapterResolverGoogleBindsRetryingDoPath(t *testing.T) {
	resolved := resolveTestAdapter(t, "google-vertex", config.ProviderConfig{Adapter: "google", BaseURL: "https://vertex.example", GoogleMode: "vertex", Project: "project", Location: "global"})
	bound, ok := resolved.(*fetchBoundAdapter)
	if !ok {
		t.Fatalf("Google factory returned unbound %T", resolved)
	}
	google, ok := bound.Adapter.(*googleadapter.Adapter)
	if !ok || google.Mode != googleadapter.ModeVertex || google.Project != "project" || google.Location != "global" {
		t.Fatalf("Google policy was dropped: %#v", google)
	}
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		if calls.Add(1) == 1 {
			writer.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		_, _ = io.WriteString(writer, "ok")
	}))
	defer upstream.Close()
	google.Client = upstream.Client()
	request, _ := http.NewRequest(http.MethodPost, upstream.URL, strings.NewReader("{}"))
	request.GetBody = func() (io.ReadCloser, error) { return io.NopCloser(strings.NewReader("{}")), nil }
	response, err := bound.fetch(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || calls.Load() != 2 {
		t.Fatalf("status=%d calls=%d", response.StatusCode, calls.Load())
	}
}

func TestAdapterAwareClientFallsBackForOrdinaryRequests(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) { writer.WriteHeader(http.StatusNoContent) }))
	defer upstream.Close()
	request, _ := http.NewRequest(http.MethodGet, upstream.URL, nil)
	response, err := newAdapterAwareClient(upstream.Client()).Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusNoContent {
		t.Fatalf("status=%d", response.StatusCode)
	}
}
