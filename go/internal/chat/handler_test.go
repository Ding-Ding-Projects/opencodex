package chat

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	cursoradapter "github.com/lidge-jun/opencodex-go/internal/adapter/cursor"
	"github.com/lidge-jun/opencodex-go/internal/claude"
	"github.com/lidge-jun/opencodex-go/internal/combos"
	"github.com/lidge-jun/opencodex-go/internal/registry"
	"github.com/lidge-jun/opencodex-go/internal/search"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

type handlerAdapter struct {
	endpoint string
	onBuild  func(*types.NormalizedRequest)
}

type incompleteHandlerAdapter struct {
	handlerAdapter
	events []types.AdapterEvent
}

type handlerAuth struct{ context *types.AuthContext }

type chatSearchRunner struct{ usage *types.Usage }

type retryingChatSearchRunner struct{ calls int }

func (runner *retryingChatSearchRunner) Run(context.Context, *types.NormalizedRequest, types.Adapter) (search.TurnResult, error) {
	runner.calls++
	if runner.calls == 1 {
		return search.TurnResult{StatusCode: http.StatusOK, Events: []types.AdapterEvent{{Type: types.EventError, Code: cursoradapter.ContinuityRetryCode}}}, nil
	}
	return search.TurnResult{StatusCode: http.StatusOK, Events: []types.AdapterEvent{{Type: types.EventDone}}}, nil
}

type failingComboSearchRunner struct{ calls int }

func (runner *failingComboSearchRunner) Run(context.Context, *types.NormalizedRequest, types.Adapter) (search.TurnResult, error) {
	runner.calls++
	if runner.calls == 1 {
		return search.TurnResult{StatusCode: http.StatusOK, Events: []types.AdapterEvent{{Type: types.EventError, StatusCode: http.StatusBadGateway, Code: "upstream_server_error", Error: "temporary"}}}, nil
	}
	return search.TurnResult{StatusCode: http.StatusOK, Events: []types.AdapterEvent{{Type: types.EventTextDelta, Text: "recovered"}, {Type: types.EventDone}}}, nil
}

type continuityRetryAdapter struct {
	endpoint    string
	builds      int
	streamCalls int
	unaryCalls  int
}

func (adapter *continuityRetryAdapter) BuildRequest(ctx context.Context, _ *types.NormalizedRequest) (*http.Request, error) {
	adapter.builds++
	return http.NewRequestWithContext(ctx, http.MethodPost, adapter.endpoint, strings.NewReader(`{}`))
}

func (adapter *continuityRetryAdapter) ParseStream(context.Context, io.ReadCloser) <-chan types.AdapterEvent {
	adapter.streamCalls++
	events := make(chan types.AdapterEvent, 1)
	if adapter.streamCalls == 1 {
		events <- types.AdapterEvent{Type: types.EventError, Error: "invalid_argument", Code: cursoradapter.ContinuityRetryCode, Retryable: true}
	} else {
		events <- types.AdapterEvent{Type: types.EventDone}
	}
	close(events)
	return events
}

func (adapter *continuityRetryAdapter) ParseUnary(context.Context, []byte) ([]types.AdapterEvent, error) {
	adapter.unaryCalls++
	if adapter.unaryCalls == 1 {
		return nil, &cursoradapter.ContinuityRetryError{Err: errors.New("invalid_argument")}
	}
	return []types.AdapterEvent{{Type: types.EventTextDelta, Text: "recovered"}, {Type: types.EventDone}}, nil
}

func (runner chatSearchRunner) Run(context.Context, *types.NormalizedRequest, types.Adapter) (search.TurnResult, error) {
	return search.TurnResult{StatusCode: http.StatusOK, Events: []types.AdapterEvent{
		{Type: types.EventTextDelta, Text: "searched"},
		{Type: types.EventDone, Usage: runner.usage},
	}}, nil
}

func (a handlerAuth) ResolveAuth(context.Context, string, string) (*types.AuthContext, error) {
	return a.context, nil
}
func (handlerAuth) RecordOutcome(string, types.OutcomeStatus, *types.RetryMeta) {}

func (a handlerAdapter) BuildRequest(ctx context.Context, req *types.NormalizedRequest) (*http.Request, error) {
	if a.onBuild != nil {
		a.onBuild(req)
	}
	return http.NewRequestWithContext(ctx, http.MethodPost, a.endpoint, strings.NewReader(`{}`))
}
func (handlerAdapter) ParseStream(context.Context, io.ReadCloser) <-chan types.AdapterEvent {
	events := make(chan types.AdapterEvent, 2)
	events <- types.AdapterEvent{Type: types.EventTextDelta, Text: "streamed"}
	events <- types.AdapterEvent{Type: types.EventDone, Usage: &types.Usage{InputTokens: 1, OutputTokens: 1}}
	close(events)
	return events
}
func (handlerAdapter) ParseUnary(context.Context, []byte) ([]types.AdapterEvent, error) {
	return []types.AdapterEvent{{Type: types.EventTextDelta, Text: "unary"}, {Type: types.EventDone, Usage: &types.Usage{InputTokens: 2, OutputTokens: 1}}}, nil
}

func (a incompleteHandlerAdapter) ParseStream(context.Context, io.ReadCloser) <-chan types.AdapterEvent {
	events := make(chan types.AdapterEvent, len(a.events))
	for _, event := range a.events {
		events <- event
	}
	close(events)
	return events
}

func (a incompleteHandlerAdapter) ParseUnary(context.Context, []byte) ([]types.AdapterEvent, error) {
	return a.events, nil
}

func TestHandlerFoldsProductionStreamForNonStreamingChatCompletion(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(`{}`)) }))
	defer upstream.Close()
	reg := registry.New(registry.Provider{ID: "acme", BaseURL: upstream.URL, DefaultModel: "wire", Models: []registry.ModelDefinition{{ID: "wire"}}})
	handler := NewHandler(HandlerConfig{Registry: reg, ResolveAdapter: func(model *types.ResolvedModel, transport *types.Transport, _ *types.AuthContext, _ http.Header) (types.Adapter, error) {
		if model.Model != "wire" || transport.BaseURL != upstream.URL {
			t.Fatalf("route = %+v %+v", model, transport)
		}
		return handlerAdapter{endpoint: upstream.URL, onBuild: func(request *types.NormalizedRequest) {
			if !request.Stream {
				t.Fatal("routed Chat Completions request did not force the internal stream")
			}
		}}, nil
	}})
	request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"acme/wire","messages":[{"role":"user","content":"hi"}]}`))
	response := httptest.NewRecorder()
	handler.Handle(response, request)
	if response.Code != 200 || !strings.Contains(response.Body.String(), `"content":"streamed"`) || !strings.Contains(response.Body.String(), `"total_tokens":2`) {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
}

func TestMessagesHandlerFoldsProductionStreamForNonStreamingClient(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(`{}`)) }))
	defer upstream.Close()
	reg := registry.New(registry.Provider{ID: "acme", BaseURL: upstream.URL, DefaultModel: "wire", Models: []registry.ModelDefinition{{ID: "wire"}}})
	handler := NewMessagesHandler(HandlerConfig{Registry: reg, ResolveAdapter: func(*types.ResolvedModel, *types.Transport, *types.AuthContext, http.Header) (types.Adapter, error) {
		return handlerAdapter{endpoint: upstream.URL, onBuild: func(request *types.NormalizedRequest) {
			if !request.Stream {
				t.Fatal("routed Messages request did not force the internal stream")
			}
		}}, nil
	}})
	request := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(`{"model":"acme/wire","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}`))
	response := httptest.NewRecorder()
	handler.Handle(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"text":"streamed"`) {
		t.Fatalf("response=%d %s", response.Code, response.Body.String())
	}
}

func TestHandlerWiresProductionCursorContinuityFields(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(`{}`)) }))
	defer upstream.Close()
	reg := registry.New(registry.Provider{ID: "cursor", BaseURL: upstream.URL, DefaultModel: "wire", Models: []registry.ModelDefinition{{ID: "wire"}}})
	var observed *types.NormalizedRequest
	handler := NewHandler(HandlerConfig{
		Registry: reg, Auth: handlerAuth{context: &types.AuthContext{AccountID: "cursor-account"}},
		ResolveAdapter: func(*types.ResolvedModel, *types.Transport, *types.AuthContext, http.Header) (types.Adapter, error) {
			return handlerAdapter{endpoint: upstream.URL, onBuild: func(request *types.NormalizedRequest) {
				clone := *request
				observed = &clone
			}}, nil
		},
	})
	request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"cursor/wire","messages":[{"role":"user","content":"hi"}]}`))
	request.Header.Set("X-Codex-Parent-Thread-Id", "parent-thread")
	response := httptest.NewRecorder()
	handler.Handle(response, request)
	if response.Code != http.StatusOK || observed == nil || observed.ClientThreadID != "parent-thread" || observed.CursorIdentity != "cursor-account" {
		t.Fatalf("response=%d observed=%#v", response.Code, observed)
	}
}

func TestHandlerReplaysSafeCursorContinuityFailureOnce(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(`{}`)) }))
	defer upstream.Close()
	reg := registry.New(registry.Provider{ID: "cursor", BaseURL: upstream.URL, DefaultModel: "wire", Models: []registry.ModelDefinition{{ID: "wire"}}})
	for _, stream := range []bool{false, true} {
		t.Run(fmt.Sprintf("stream=%v", stream), func(t *testing.T) {
			adapter := &continuityRetryAdapter{endpoint: upstream.URL}
			handler := NewHandler(HandlerConfig{Registry: reg, ResolveAdapter: func(*types.ResolvedModel, *types.Transport, *types.AuthContext, http.Header) (types.Adapter, error) {
				return adapter, nil
			}})
			request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(fmt.Sprintf(`{"model":"cursor/wire","stream":%v,"messages":[{"role":"user","content":"hi"}]}`, stream)))
			response := httptest.NewRecorder()
			handler.Handle(response, request)
			if response.Code != http.StatusOK || adapter.builds != 2 {
				t.Fatalf("response=%d body=%s builds=%d", response.Code, response.Body.String(), adapter.builds)
			}
		})
	}
}

func TestSearchRunnerReplaysSafeCursorContinuityFailureOnce(t *testing.T) {
	inner := &retryingChatSearchRunner{}
	runner := continuityRetryTurnRunner{inner: inner}
	result, err := runner.Run(context.Background(), &types.NormalizedRequest{}, handlerAdapter{})
	if err != nil || inner.calls != 2 || len(result.Events) != 1 || result.Events[0].Type != types.EventDone {
		t.Fatalf("calls=%d result=%#v err=%v", inner.calls, result, err)
	}
}

func TestChatAndMessagesHandlersUseComboFailover(t *testing.T) {
	failed := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = io.WriteString(w, `{"error":{"message":"temporary","code":"upstream_server_error"}}`)
	}))
	defer failed.Close()
	healthy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, `{}`) }))
	defer healthy.Close()
	reg := registry.New(
		registry.Provider{ID: "first", BaseURL: failed.URL, DefaultModel: "one", Models: []registry.ModelDefinition{{ID: "one"}}},
		registry.Provider{ID: "second", BaseURL: healthy.URL, DefaultModel: "two", Models: []registry.ModelDefinition{{ID: "two"}}},
	)
	definitions := map[string]combos.Combo{"balanced": {
		Strategy: combos.StrategyFailover, MaxHops: 1,
		Targets: []combos.Target{{Provider: "first", Model: "one"}, {Provider: "second", Model: "two"}},
	}}
	providers := map[string]combos.Provider{"first": {}, "second": {}}
	for _, test := range []struct {
		name string
		body string
	}{
		{name: "chat", body: `{"model":"combo/balanced","messages":[{"role":"user","content":"hi"}]}`},
		{name: "messages", body: `{"model":"combo/balanced","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			resolver, err := combos.New(definitions, providers)
			if err != nil {
				t.Fatal(err)
			}
			config := HandlerConfig{Registry: reg, Combos: resolver, ResolveAdapter: func(_ *types.ResolvedModel, transport *types.Transport, _ *types.AuthContext, _ http.Header) (types.Adapter, error) {
				return handlerAdapter{endpoint: transport.BaseURL}, nil
			}}
			run := NewHandler(config).Handle
			if test.name == "messages" {
				run = NewMessagesHandler(config).Handle
			}
			request := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(test.body))
			response := httptest.NewRecorder()
			run(response, request)
			if response.Code != http.StatusOK {
				t.Fatalf("response=%d body=%s", response.Code, response.Body.String())
			}
		})
	}
}

func TestHostedSearchTurnUsesComboFailover(t *testing.T) {
	reg := registry.New(
		registry.Provider{ID: "first", BaseURL: "https://first.test", DefaultModel: "one", Models: []registry.ModelDefinition{{ID: "one"}}},
		registry.Provider{ID: "second", BaseURL: "https://second.test", DefaultModel: "two", Models: []registry.ModelDefinition{{ID: "two"}}},
	)
	resolver, err := combos.New(map[string]combos.Combo{"balanced": {
		Strategy: combos.StrategyFailover, MaxHops: 1,
		Targets: []combos.Target{{Provider: "first", Model: "one"}, {Provider: "second", Model: "two"}},
	}}, map[string]combos.Provider{"first": {}, "second": {}})
	if err != nil {
		t.Fatal(err)
	}
	runner := &failingComboSearchRunner{}
	loop := &search.Loop{Runner: runner}
	handler := NewHandler(HandlerConfig{
		Registry: reg, Combos: resolver, SearchLoop: loop,
		ResolveAdapter: func(_ *types.ResolvedModel, transport *types.Transport, _ *types.AuthContext, _ http.Header) (types.Adapter, error) {
			return handlerAdapter{endpoint: transport.BaseURL}, nil
		},
	})
	request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{
		"model":"combo/balanced","messages":[{"role":"user","content":"search"}],"tools":[{"type":"web_search"}]
	}`))
	response := httptest.NewRecorder()
	handler.Handle(response, request)
	if response.Code != http.StatusOK || runner.calls != 2 || !strings.Contains(response.Body.String(), "recovered") {
		t.Fatalf("response=%d body=%s calls=%d", response.Code, response.Body.String(), runner.calls)
	}
}

func TestHandlerRejectsOversizedBody(t *testing.T) {
	handler := NewHandler(HandlerConfig{BodyLimit: 16})
	request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"m","messages":[{"role":"user","content":"too long"}]}`))
	response := httptest.NewRecorder()
	handler.Handle(response, request)
	if response.Code != 400 || !strings.Contains(response.Body.String(), "request body too large") {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
}

func TestChatHandlersPreserveUpstreamRetryAfter(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "17")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = io.WriteString(w, `{"error":{"message":"quota exhausted"}}`)
	}))
	defer upstream.Close()
	reg := registry.New(registry.Provider{ID: "acme", BaseURL: upstream.URL, DefaultModel: "wire", Models: []registry.ModelDefinition{{ID: "wire"}}})
	config := HandlerConfig{Registry: reg, ResolveAdapter: func(*types.ResolvedModel, *types.Transport, *types.AuthContext, http.Header) (types.Adapter, error) {
		return handlerAdapter{endpoint: upstream.URL}, nil
	}}
	tests := []struct {
		name      string
		body      string
		wantRetry string
		run       func(http.ResponseWriter, *http.Request)
	}{
		{name: "chat completions", body: `{"model":"acme/wire","messages":[{"role":"user","content":"hi"}]}`, wantRetry: "17", run: NewHandler(config).Handle},
		{name: "Claude messages", body: `{"model":"acme/wire","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}`, run: NewMessagesHandler(config).Handle},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(test.body))
			response := httptest.NewRecorder()
			test.run(response, request)
			if response.Code != http.StatusTooManyRequests || response.Header().Get("Retry-After") != test.wantRetry {
				t.Fatalf("response = %d headers=%v body=%s", response.Code, response.Header(), response.Body.String())
			}
			if test.name == "chat completions" {
				want := `{"error":{"message":"quota exhausted","type":"insufficient_quota","param":null,"code":"insufficient_quota"}}`
				if response.Body.String() != want {
					t.Fatalf("chat upstream envelope = %q, want %q", response.Body.String(), want)
				}
			} else {
				want := `{"type":"error","error":{"type":"rate_limit_error","message":"Provider error 429: {\"error\":{\"message\":\"quota exhausted\"}}"}}`
				if response.Body.String() != want || response.Header().Get("Retry-After") != "" {
					t.Fatalf("Messages 429 bytes=%q headers=%v, want %q", response.Body.String(), response.Header(), want)
				}
			}
		})
	}
}

func TestChatHandlerPreservesStructuredCyberAndModelErrors(t *testing.T) {
	tests := []struct {
		name, code, wantType string
		upstreamStatus       int
		wantStatus           int
	}{
		{name: "cyber policy overrides 5xx", code: "cyber_policy", wantType: "invalid_request_error", upstreamStatus: 502, wantStatus: 400},
		{name: "model not found survives classifier", code: "model_not_found", wantType: "invalid_request_error", upstreamStatus: 502, wantStatus: 502},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(test.upstreamStatus)
				_, _ = io.WriteString(w, `{"error":{"message":"structured failure","type":"server_error","code":"`+test.code+`"}}`)
			}))
			defer upstream.Close()
			reg := registry.New(registry.Provider{ID: "acme", BaseURL: upstream.URL, DefaultModel: "wire", Models: []registry.ModelDefinition{{ID: "wire"}}})
			handler := NewHandler(HandlerConfig{Registry: reg, ResolveAdapter: func(*types.ResolvedModel, *types.Transport, *types.AuthContext, http.Header) (types.Adapter, error) {
				return handlerAdapter{endpoint: upstream.URL}, nil
			}})
			request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"acme/wire","messages":[{"role":"user","content":"hi"}]}`))
			response := httptest.NewRecorder()
			handler.Handle(response, request)
			want := `{"error":{"message":"structured failure","type":"` + test.wantType + `","param":null,"code":"` + test.code + `"}}`
			if response.Code != test.wantStatus || response.Body.String() != want {
				t.Fatalf("response=%d body=%s want=%d %s", response.Code, response.Body.String(), test.wantStatus, want)
			}
		})
	}
}

func TestMessagesHandlerReclassifiesTransientUpstreamAsOverloaded(t *testing.T) {
	tests := []struct {
		name       string
		status     int
		retryAfter string
		wantRetry  string
	}{
		{name: "default retry", status: http.StatusInternalServerError, wantRetry: "2"},
		{name: "replace hidden upstream retry", status: http.StatusBadGateway, retryAfter: "9", wantRetry: "2"},
		{name: "cloudflare unknown", status: 520, wantRetry: "2"},
		{name: "cloudflare offline", status: 521, wantRetry: "2"},
		{name: "cloudflare timeout", status: 522, wantRetry: "2"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				if test.retryAfter != "" {
					w.Header().Set("Retry-After", test.retryAfter)
				}
				w.WriteHeader(test.status)
				_, _ = io.WriteString(w, `{"error":{"message":"provider temporarily unavailable"}}`)
			}))
			defer upstream.Close()
			reg := registry.New(registry.Provider{ID: "acme", BaseURL: upstream.URL, DefaultModel: "wire", Models: []registry.ModelDefinition{{ID: "wire"}}})
			handler := NewMessagesHandler(HandlerConfig{Registry: reg, ResolveAdapter: func(*types.ResolvedModel, *types.Transport, *types.AuthContext, http.Header) (types.Adapter, error) {
				return handlerAdapter{endpoint: upstream.URL}, nil
			}})
			request := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(`{"model":"acme/wire","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}`))
			response := httptest.NewRecorder()
			handler.Handle(response, request)
			if response.Code != 529 || response.Header().Get("Retry-After") != test.wantRetry || !strings.Contains(response.Body.String(), `"type":"overloaded_error"`) {
				t.Fatalf("response=%d headers=%v body=%s", response.Code, response.Header(), response.Body.String())
			}
		})
	}
}

func TestMessagesHandlerPreservesAnthropicBillingAndConflictTaxonomy(t *testing.T) {
	for _, test := range []struct {
		status int
		kind   string
	}{
		{status: http.StatusPaymentRequired, kind: "billing_error"},
		{status: http.StatusConflict, kind: "conflict_error"},
	} {
		t.Run(test.kind, func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(test.status)
				_, _ = io.WriteString(w, `{"error":{"message":"classified"}}`)
			}))
			defer upstream.Close()
			reg := registry.New(registry.Provider{ID: "acme", BaseURL: upstream.URL, DefaultModel: "wire", Models: []registry.ModelDefinition{{ID: "wire"}}})
			handler := NewMessagesHandler(HandlerConfig{Registry: reg, ResolveAdapter: func(*types.ResolvedModel, *types.Transport, *types.AuthContext, http.Header) (types.Adapter, error) {
				return handlerAdapter{endpoint: upstream.URL}, nil
			}})
			request := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(`{"model":"acme/wire","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}`))
			response := httptest.NewRecorder()
			handler.Handle(response, request)
			if response.Code != test.status || !strings.Contains(response.Body.String(), `"type":"`+test.kind+`"`) {
				t.Fatalf("response=%d body=%s", response.Code, response.Body.String())
			}
		})
	}
}

func TestMessagesHandlerRecordsDesktopRequestAndErrorAfterAliasResolution(t *testing.T) {
	claude.BuildDesktop3pRegistry(nil, []claude.Desktop3pRoutedModel{{Provider: "acme", ID: "wire"}})
	alias := claude.ActiveDesktop3pAlias("acme", "wire")
	before := claude.GetDesktopHealth()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = io.WriteString(w, `{"error":{"message":"offline"}}`)
	}))
	defer upstream.Close()
	reg := registry.New(registry.Provider{ID: "acme", BaseURL: upstream.URL, DefaultModel: "wire", Models: []registry.ModelDefinition{{ID: "wire"}}})
	handler := NewMessagesHandler(HandlerConfig{Registry: reg, ResolveAdapter: func(*types.ResolvedModel, *types.Transport, *types.AuthContext, http.Header) (types.Adapter, error) {
		return handlerAdapter{endpoint: upstream.URL}, nil
	}})
	request := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(`{"model":"`+alias+`","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}`))
	response := httptest.NewRecorder()
	handler.Handle(response, request)

	after := claude.GetDesktopHealth()
	if response.Code != 529 || after.RequestCount != before.RequestCount+1 || after.ErrorCount != before.ErrorCount+1 || after.LastRequestAt == nil {
		t.Fatalf("response=%d before=%#v after=%#v body=%s", response.Code, before, after, response.Body.String())
	}
}

func TestMessagesHandlerConnectsSearchLoopUsageCallback(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{}`)
	}))
	defer upstream.Close()
	reg := registry.New(registry.Provider{ID: "acme", BaseURL: upstream.URL, DefaultModel: "wire", Models: []registry.ModelDefinition{{ID: "wire"}}})
	rawUsage := &types.Usage{InputTokens: 13, OutputTokens: 4, CachedInputTokens: 3}
	var recorded *types.Usage
	loop := &search.Loop{Runner: chatSearchRunner{usage: rawUsage}}
	handler := NewMessagesHandler(HandlerConfig{
		Registry: reg, SearchLoop: loop, OnUsage: func(value *types.Usage) { recorded = value },
		ResolveAdapter: func(*types.ResolvedModel, *types.Transport, *types.AuthContext, http.Header) (types.Adapter, error) {
			return handlerAdapter{endpoint: upstream.URL}, nil
		},
	})
	request := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(`{
		"model":"acme/wire","max_tokens":10,
		"tools":[{"type":"web_search_20250305"}],
		"messages":[{"role":"user","content":"hi"}]
	}`))
	response := httptest.NewRecorder()
	handler.Handle(response, request)
	if response.Code != http.StatusOK || recorded == nil || recorded.InputTokens != 13 || recorded.CachedInputTokens != 3 {
		t.Fatalf("response=%d body=%s usage=%#v", response.Code, response.Body.String(), recorded)
	}
}

func TestChatHandlerConnectsHostedSearchLoopUsageCallback(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{}`)
	}))
	defer upstream.Close()
	reg := registry.New(registry.Provider{ID: "acme", BaseURL: upstream.URL, DefaultModel: "wire", Models: []registry.ModelDefinition{{ID: "wire"}}})
	rawUsage := &types.Usage{InputTokens: 9, OutputTokens: 2, CachedInputTokens: 1}
	var recorded *types.Usage
	loop := &search.Loop{Runner: chatSearchRunner{usage: rawUsage}}
	handler := NewHandler(HandlerConfig{
		Registry: reg, SearchLoop: loop, OnUsage: func(value *types.Usage) { recorded = value },
		ResolveAdapter: func(*types.ResolvedModel, *types.Transport, *types.AuthContext, http.Header) (types.Adapter, error) {
			return handlerAdapter{endpoint: upstream.URL}, nil
		},
	})
	request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{
		"model":"acme/wire","messages":[{"role":"user","content":"search"}],
		"tools":[{"type":"web_search_preview"}]
	}`))
	response := httptest.NewRecorder()
	handler.Handle(response, request)
	if response.Code != http.StatusOK || recorded == nil || recorded.InputTokens != 9 || !strings.Contains(response.Body.String(), "searched") {
		t.Fatalf("response=%d body=%s usage=%#v", response.Code, response.Body.String(), recorded)
	}
}

func TestMessagesHandlerWiresMetadataPromptCacheSessionHeaderOnly(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{}`)
	}))
	defer upstream.Close()
	reg := registry.New(registry.Provider{ID: "acme", BaseURL: upstream.URL, DefaultModel: "wire", Models: []registry.ModelDefinition{{ID: "wire"}}})
	for _, test := range []struct {
		name, extra string
		wantSession bool
	}{
		{name: "metadata key", extra: `,"metadata":{"user_id":"session-1"}`, wantSession: true},
		{name: "system cohort", extra: `,"system":"stable cohort"`, wantSession: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			var sessionID string
			handler := NewMessagesHandler(HandlerConfig{
				Registry: reg,
				ResolveAdapter: func(_ *types.ResolvedModel, _ *types.Transport, _ *types.AuthContext, incoming http.Header) (types.Adapter, error) {
					sessionID = incoming.Get("session_id")
					return incompleteHandlerAdapter{handlerAdapter: handlerAdapter{endpoint: upstream.URL}, events: []types.AdapterEvent{{Type: types.EventDone}}}, nil
				},
			})
			request := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(`{"model":"acme/wire","max_tokens":10,"messages":[{"role":"user","content":"hi"}]`+test.extra+`}`))
			response := httptest.NewRecorder()
			handler.Handle(response, request)
			if response.Code != http.StatusOK {
				t.Fatalf("response=%d body=%s", response.Code, response.Body.String())
			}
			matched, _ := regexp.MatchString(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$`, sessionID)
			if matched != test.wantSession {
				t.Fatalf("session_id=%q want=%v", sessionID, test.wantSession)
			}
		})
	}
}

func TestMessagesHandlerNativeAnthropicPassthrough(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/messages" || r.Header.Get("x-api-key") != "native-key" {
			t.Fatalf("request = %s headers=%v", r.URL.Path, r.Header)
		}
		payload, _ := io.ReadAll(r.Body)
		if !strings.Contains(string(payload), `"model":"claude-wire"`) {
			t.Fatalf("payload = %s", payload)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"type":"message","content":[{"type":"text","text":"native"}]}`))
	}))
	defer upstream.Close()
	reg := registry.New(registry.Provider{ID: "anthropic", BaseURL: upstream.URL, DefaultModel: "claude-wire", Models: []registry.ModelDefinition{{ID: "claude-wire"}}})
	handler := NewMessagesHandler(HandlerConfig{
		Registry: reg,
		Auth:     handlerAuth{context: &types.AuthContext{APIKey: "native-key"}},
		ResolveAdapter: func(*types.ResolvedModel, *types.Transport, *types.AuthContext, http.Header) (types.Adapter, error) {
			return handlerAdapter{endpoint: upstream.URL}, nil
		},
	})
	request := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(`{"model":"anthropic/claude-wire","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}`))
	response := httptest.NewRecorder()
	handler.Handle(response, request)
	if response.Code != 200 || !strings.Contains(response.Body.String(), `"native"`) {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
}

func TestMessagesHandlerReturns529ForIncompleteUnaryResponse(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(`{}`)) }))
	defer upstream.Close()
	reg := registry.New(registry.Provider{ID: "acme", BaseURL: upstream.URL, DefaultModel: "claude-wire", Models: []registry.ModelDefinition{{ID: "claude-wire"}}})
	handler := NewMessagesHandler(HandlerConfig{Registry: reg, ResolveAdapter: func(*types.ResolvedModel, *types.Transport, *types.AuthContext, http.Header) (types.Adapter, error) {
		return incompleteHandlerAdapter{
			handlerAdapter: handlerAdapter{endpoint: upstream.URL},
			events:         []types.AdapterEvent{{Type: types.EventIncomplete, Reason: "adapter_eof"}},
		}, nil
	}})
	request := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(`{"model":"acme/claude-wire","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}`))
	response := httptest.NewRecorder()
	handler.Handle(response, request)
	if response.Code != 529 || !strings.Contains(response.Body.String(), `"type":"overloaded_error"`) || !strings.Contains(response.Body.String(), `upstream response was incomplete (adapter_eof)`) {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
}

func TestCompactHandlerNativePassthroughUsesCompactEndpoint(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/responses/compact" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"output":[]}`))
	}))
	defer upstream.Close()
	reg := registry.New(registry.Provider{ID: "openai", BaseURL: upstream.URL + "/v1", DefaultModel: "wire", Models: []registry.ModelDefinition{{ID: "wire"}}})
	handler := NewCompactHandler(HandlerConfig{Registry: reg, ResolveAdapter: func(*types.ResolvedModel, *types.Transport, *types.AuthContext, http.Header) (types.Adapter, error) {
		return handlerAdapter{endpoint: upstream.URL}, nil
	}})
	request := httptest.NewRequest(http.MethodPost, "/v1/responses/compact", strings.NewReader(`{"model":"openai/wire","input":[]}`))
	response := httptest.NewRecorder()
	handler.Handle(response, request)
	if response.Code != 200 || !strings.Contains(response.Body.String(), `"output"`) {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
}
