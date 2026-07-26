package claude_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/chat"
	"github.com/lidge-jun/opencodex-go/internal/claude"
	"github.com/lidge-jun/opencodex-go/internal/registry"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

type reachabilityAdapter struct {
	endpoint string
	request  **types.NormalizedRequest
	events   []types.AdapterEvent
}

func (adapter reachabilityAdapter) BuildRequest(ctx context.Context, request *types.NormalizedRequest) (*http.Request, error) {
	if adapter.request != nil {
		*adapter.request = request
	}
	return http.NewRequestWithContext(ctx, http.MethodPost, adapter.endpoint, strings.NewReader(`{}`))
}

func (adapter reachabilityAdapter) ParseStream(context.Context, io.ReadCloser) <-chan types.AdapterEvent {
	events := make(chan types.AdapterEvent, len(adapter.events))
	for _, event := range adapter.events {
		events <- event
	}
	close(events)
	return events
}

func (adapter reachabilityAdapter) ParseUnary(context.Context, []byte) ([]types.AdapterEvent, error) {
	return adapter.events, nil
}

func TestProductionMessagesUsesClaudeIngressForAliasesAndRouteDirective(t *testing.T) {
	for _, test := range []struct {
		name   string
		model  string
		system string
	}{
		{name: "readable alias", model: claude.ClaudeCodeAlias("acme", "wire")},
		{name: "route directive", model: "acme/fallback", system: "<!-- ocx-route: acme/wire -->"},
	} {
		t.Run(test.name, func(t *testing.T) {
			var captured *types.NormalizedRequest
			handler, upstream := productionMessagesHandler(t, &captured, []types.AdapterEvent{
				{Type: types.EventTextDelta, Text: "ok"},
				{Type: types.EventDone},
			})
			defer upstream.Close()
			body := map[string]any{
				"model": test.model, "max_tokens": 32,
				"messages": []any{map[string]any{"role": "user", "content": "hello"}},
			}
			if test.system != "" {
				body["system"] = test.system
			}
			response := invokeMessages(t, handler, body)
			if response.Code != http.StatusOK {
				t.Fatalf("response = %d %s", response.Code, response.Body.String())
			}
			if captured == nil || captured.ModelID != "wire" {
				t.Fatalf("production normalized model = %#v", captured)
			}
		})
	}
}

func TestProductionMessagesActivatesClaudeInboundPolicies(t *testing.T) {
	var captured *types.NormalizedRequest
	handler, upstream := productionMessagesHandler(t, &captured, []types.AdapterEvent{{Type: types.EventDone}})
	defer upstream.Close()
	response := invokeMessages(t, handler, map[string]any{
		"model": "acme/wire", "max_tokens": 32, "system": "stable cache cohort",
		"tools": []any{map[string]any{"type": "web_search_20250305"}},
		"messages": []any{
			map[string]any{"role": "assistant", "content": []any{
				map[string]any{"type": "tool_use", "id": "skill-call", "name": "Skill", "input": map[string]any{"skill": "claude-api"}},
				map[string]any{"type": "tool_use", "id": "other-call", "name": "lookup", "input": map[string]any{}},
			}},
			map[string]any{"role": "user", "content": []any{
				map[string]any{"type": "tool_result", "tool_use_id": "skill-call", "content": "large reference bundle"},
				map[string]any{"type": "tool_result", "tool_use_id": "other-call", "is_error": true, "content": []any{
					map[string]any{"type": "text", "text": "failed"},
					map[string]any{"type": "image", "source": map[string]any{"type": "base64", "media_type": "image/png", "data": "AAAA"}},
				}},
			}},
		},
	})
	if response.Code != http.StatusOK {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
	if captured == nil {
		t.Fatal("production adapter did not receive a normalized request")
	}
	if captured.Options.PromptCacheKey == "" {
		t.Fatal("production request did not receive Claude prompt-cache affinity")
	}
	if captured.WebSearch == nil || captured.WebSearch["type"] != "web_search" {
		t.Fatalf("production WebSearch = %#v", captured.WebSearch)
	}
	wire, err := json.Marshal(captured.Context.Messages)
	if err != nil {
		t.Fatal(err)
	}
	text := string(wire)
	for _, want := range []string{"Skill document bundle elided", "[tool error]", "data:image/png;base64,AAAA"} {
		if !strings.Contains(text, want) {
			t.Fatalf("production normalized messages missing %q: %s", want, text)
		}
	}
}

func TestProductionBufferedMessagesUsesClaudeOutboundStateMachine(t *testing.T) {
	events := []types.AdapterEvent{
		{Type: types.EventReasoningRawDelta, Text: "private thought"},
		{Type: types.EventThinkingSignature, Signature: "signed-thinking"},
		{Type: types.EventRedactedThinking, Data: "redacted-payload"},
		{Type: types.EventWebSearchCallBegin, ID: "search-1", Queries: []string{"query"}},
		{Type: types.EventWebSearchCallEnd, ID: "search-1", Sources: []types.URLCitation{{URL: "https://example.com", Title: "Example"}}},
		{Type: types.EventDone, Usage: &types.Usage{InputTokens: 10, OutputTokens: 2}},
	}
	handler, upstream := productionMessagesHandler(t, nil, events)
	defer upstream.Close()
	response := invokeMessages(t, handler, map[string]any{
		"model": "acme/wire", "max_tokens": 32,
		"messages": []any{map[string]any{"role": "user", "content": "hello"}},
	})
	if response.Code != http.StatusOK {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
	wire := response.Body.String()
	for _, want := range []string{"private thought", "signed-thinking", "redacted-payload", "server_tool_use", "web_search_result", "https://example.com", "web_search_requests"} {
		if !strings.Contains(wire, want) {
			t.Fatalf("production buffered Anthropic message missing %q: %s", want, wire)
		}
	}
}

func TestProductionDesktopAliasRecordsHealthAndRoutes(t *testing.T) {
	models := []claude.Desktop3pRoutedModel{{Provider: "acme", ID: "wire"}}
	claude.BuildDesktop3pRegistry(nil, models)
	alias := claude.Desktop3pAlias("acme", "wire")
	before := claude.GetDesktopHealth()
	var captured *types.NormalizedRequest
	handler, upstream := productionMessagesHandler(t, &captured, []types.AdapterEvent{{Type: types.EventDone}})
	defer upstream.Close()
	response := invokeMessages(t, handler, map[string]any{
		"model": alias, "max_tokens": 32,
		"messages": []any{map[string]any{"role": "user", "content": "hello"}},
	})
	if response.Code != http.StatusOK {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
	after := claude.GetDesktopHealth()
	if captured == nil || captured.ModelID != "wire" {
		t.Fatalf("Desktop normalized model = %#v", captured)
	}
	if after.RequestCount != before.RequestCount+1 || after.LastRequestAt == nil {
		t.Fatalf("Desktop health before=%#v after=%#v", before, after)
	}
}

func productionMessagesHandler(t *testing.T, captured **types.NormalizedRequest, events []types.AdapterEvent) (*chat.MessagesHandler, *httptest.Server) {
	t.Helper()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{}`)
	}))
	providers := []registry.Provider{
		{ID: "acme", BaseURL: upstream.URL, DefaultModel: "fallback", Models: []registry.ModelDefinition{{ID: "fallback"}, {ID: "wire"}}},
	}
	reg := registry.New(providers...)
	adapter := reachabilityAdapter{endpoint: upstream.URL, request: captured, events: events}
	handler := chat.NewMessagesHandler(chat.HandlerConfig{
		Registry: reg,
		ResolveAdapter: func(_ *types.ResolvedModel, _ *types.Transport, _ *types.AuthContext, _ http.Header) (types.Adapter, error) {
			return adapter, nil
		},
	})
	return handler, upstream
}

func invokeMessages(t *testing.T, handler *chat.MessagesHandler, body map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	payload, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(string(payload)))
	response := httptest.NewRecorder()
	handler.Handle(response, request)
	return response
}
