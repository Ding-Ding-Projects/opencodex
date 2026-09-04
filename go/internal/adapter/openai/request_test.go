package openai

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

func TestResponsesBuildRequest(t *testing.T) {
	adapter := &ResponsesAdapter{
		BaseURL: "https://api.openai.com/v1/",
		APIKey:  "secret-key",
		Headers: map[string]string{"OpenAI-Beta": "responses=experimental"},
	}
	req := &types.NormalizedRequest{
		ModelID: "gpt-test", Stream: true,
		RawBody: json.RawMessage(`{"model":"old","input":"hello","stream":false}`),
	}
	httpReq, err := adapter.BuildRequest(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	if got := httpReq.URL.String(); got != "https://api.openai.com/v1/responses" {
		t.Fatalf("URL = %q", got)
	}
	if httpReq.Header.Get("Authorization") != "Bearer secret-key" || httpReq.Header.Get("Accept") != "text/event-stream" {
		t.Fatalf("unexpected headers: %#v", httpReq.Header)
	}
	body := decodeRequestBody(t, httpReq.Body)
	if body["model"] != "gpt-test" || body["stream"] != true || body["input"] != "hello" {
		t.Fatalf("unexpected Responses body: %#v", body)
	}
}

func TestResponsesBuildRequestPreservesTranslatedChatOptions(t *testing.T) {
	temperature := 0.2
	request := &types.NormalizedRequest{
		ModelID: "gpt-test", Context: types.RequestContext{Messages: []types.Message{{Role: "user", Content: json.RawMessage(`"hello"`)}}},
		Options: types.RequestOptions{
			Temperature: &temperature, StopSequences: []string{"END"}, PromptCacheKey: "cache-1", User: "user-1",
			ResponseText: json.RawMessage(`{"format":{"type":"json_object"}}`), RequestMetadata: json.RawMessage(`{"attempt":2}`),
		},
	}
	built, err := (&ResponsesAdapter{BaseURL: "https://api.openai.com/v1", APIKey: "key"}).BuildRequest(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	body := decodeRequestBody(t, built.Body)
	if body["prompt_cache_key"] != "cache-1" || body["user"] != "user-1" || body["stop"].([]any)[0] != "END" {
		t.Fatalf("translated options = %#v", body)
	}
	if body["text"].(map[string]any)["format"].(map[string]any)["type"] != "json_object" || body["metadata"].(map[string]any)["attempt"] != float64(2) {
		t.Fatalf("structured metadata = %#v", body)
	}
}

func TestForwardResponsesBuildRequestStripsUnsupportedTranslatedChatOptions(t *testing.T) {
	temperature := 0.2
	request := &types.NormalizedRequest{
		ModelID: "gpt-test", Context: types.RequestContext{Messages: []types.Message{{Role: "user", Content: json.RawMessage(`"hello"`)}}},
		Options: types.RequestOptions{Temperature: &temperature, StopSequences: []string{"END"}, User: "user-1", RequestMetadata: json.RawMessage(`{"attempt":2}`)},
	}
	built, err := (&ResponsesAdapter{BaseURL: "https://chatgpt.com/backend-api/codex", ForwardAuth: true}).BuildRequest(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	body := decodeRequestBody(t, built.Body)
	for _, key := range []string{"temperature", "stop", "user", "metadata"} {
		if _, exists := body[key]; exists {
			t.Fatalf("forward body retained %s: %#v", key, body)
		}
	}
}

func TestChatBuildRequestShape(t *testing.T) {
	temperature := 0.2
	parallel := false
	adapter := &ChatAdapter{BaseURL: "https://provider.test/v1", APIKey: "key"}
	req := &types.NormalizedRequest{
		ModelID: "model-a", Stream: true,
		Context: types.RequestContext{
			SystemPrompt: []string{CodexGPT5IdentityLine},
			Messages:     []types.Message{{Role: "user", Content: json.RawMessage(`"hello"`)}},
			Tools:        []types.Tool{{Name: "read", Namespace: "fs", Parameters: map[string]any{"type": "object"}}},
		},
		Options: types.RequestOptions{MaxOutputTokens: 256, Temperature: &temperature, ParallelToolCalls: &parallel, Reasoning: "high"},
	}
	httpReq, err := adapter.BuildRequest(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	if got := httpReq.URL.String(); got != "https://provider.test/v1/chat/completions" {
		t.Fatalf("URL = %q", got)
	}
	body := decodeRequestBody(t, httpReq.Body)
	if body["model"] != "model-a" || body["max_tokens"].(float64) != 256 || body["reasoning_effort"] != "high" {
		t.Fatalf("unexpected Chat body: %#v", body)
	}
	if body["parallel_tool_calls"] != false {
		t.Fatalf("parallel_tool_calls = %#v", body["parallel_tool_calls"])
	}
	messages := body["messages"].([]any)
	system := messages[0].(map[string]any)["content"].(string)
	if strings.Contains(system, CodexGPT5IdentityLine) || !strings.Contains(system, NeutralIdentityLine) {
		t.Fatalf("system identity not neutralized: %q", system)
	}
	tools := body["tools"].([]any)
	function := tools[0].(map[string]any)["function"].(map[string]any)
	if function["name"] != "fs__read" {
		t.Fatalf("tool name = %#v", function["name"])
	}
}

func TestChatCredentialHardening(t *testing.T) {
	request := &types.NormalizedRequest{ModelID: "model", Context: types.RequestContext{Messages: []types.Message{{Role: "user", Content: json.RawMessage(`"hi"`)}}}}
	optional := true
	for _, test := range []struct {
		name     string
		provider config.ProviderConfig
		key      string
		wantErr  bool
	}{
		{name: "blank key", provider: config.ProviderConfig{BaseURL: "https://provider.test/v1", AuthMode: "key"}, key: "   ", wantErr: true},
		{name: "blank oauth", provider: config.ProviderConfig{BaseURL: "https://provider.test/v1", AuthMode: "oauth"}, wantErr: true},
		{name: "key optional", provider: config.ProviderConfig{BaseURL: "https://provider.test/v1", AuthMode: "key", KeyOptional: &optional}},
		{name: "unspecified mode", provider: config.ProviderConfig{BaseURL: "https://provider.test/v1"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			built, err := NewChatAdapter(test.provider, test.key, nil).BuildRequest(context.Background(), request)
			if test.wantErr {
				if err == nil || !strings.Contains(err.Error(), "requires a non-empty credential") {
					t.Fatalf("error = %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if built.Header.Get("Authorization") != "" {
				t.Fatalf("unexpected authorization: %q", built.Header.Get("Authorization"))
			}
		})
	}
}

func TestChatUnaryHardeningRejectsErrorAndMissingChoices(t *testing.T) {
	adapter := &ChatAdapter{}
	for _, test := range []struct {
		name string
		body string
		want string
	}{
		{name: "error envelope", body: `{"error":{"message":"upstream quota exhausted","code":"quota_exceeded"}}`, want: "upstream quota exhausted"},
		{name: "empty choices", body: `{"choices":[]}`, want: "upstream response contained no choices"},
		{name: "missing message", body: `{"choices":[{}]}`, want: "upstream response contained no choices"},
	} {
		t.Run(test.name, func(t *testing.T) {
			events, err := adapter.ParseUnary(context.Background(), []byte(test.body))
			if err != nil {
				t.Fatal(err)
			}
			if len(events) != 1 || events[0].Type != types.EventError || events[0].Error != test.want {
				t.Fatalf("events = %#v", events)
			}
		})
	}
}

func TestAzureBuildRequest(t *testing.T) {
	adapter := &AzureAdapter{BaseURL: "https://resource.openai.azure.com", Deployment: "gpt-4o", APIKey: "azure-key", APIVersion: "2025-01-01-preview"}
	req := &types.NormalizedRequest{ModelID: "gpt-4o", Context: types.RequestContext{Messages: []types.Message{{Role: "user", Content: json.RawMessage(`"hello"`)}}}}
	httpReq, err := adapter.BuildRequest(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	if httpReq.Header.Get("api-key") != "azure-key" || httpReq.Header.Get("Authorization") != "" {
		t.Fatalf("unexpected Azure auth headers: %#v", httpReq.Header)
	}
	if httpReq.URL.Query().Get("api-version") != "2025-01-01-preview" {
		t.Fatalf("Azure URL = %q", httpReq.URL.String())
	}
}

func TestChatParseStreamAssemblesToolCall(t *testing.T) {
	stream := strings.Join([]string{
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"lookup","arguments":"{\"q\":"}}]}}]}`,
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"go\"}"}}]},"finish_reason":"tool_calls"}]}`,
		`data: [DONE]`, "",
	}, "\n\n")
	events := collectEvents((&ChatAdapter{}).ParseStream(context.Background(), io.NopCloser(strings.NewReader(stream))))
	if len(events) != 2 || events[0].Type != types.EventToolCall || events[1].Type != types.EventDone {
		t.Fatalf("unexpected events: %#v", events)
	}
	if events[0].ToolCall == nil || string(events[0].ToolCall.Arguments) != `{"q":"go"}` {
		t.Fatalf("unexpected tool call: %#v", events[0].ToolCall)
	}
}

func TestChatParseStreamCommentEmitsHeartbeat(t *testing.T) {
	stream := strings.Join([]string{
		`: keepalive`,
		`data: [DONE]`, "",
	}, "\n\n")
	events := collectEvents((&ChatAdapter{}).ParseStream(context.Background(), io.NopCloser(strings.NewReader(stream))))
	if len(events) != 2 || events[0].Type != types.EventHeartbeat || events[1].Type != types.EventDone {
		t.Fatalf("unexpected events: %#v", events)
	}
}

func TestChatParseStreamUsageOnlyEOFIsDone(t *testing.T) {
	stream := `data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1}}` + "\n\n"
	events := collectEvents((&ChatAdapter{}).ParseStream(context.Background(), io.NopCloser(strings.NewReader(stream))))
	if len(events) != 1 || events[0].Type != types.EventDone {
		t.Fatalf("unexpected events: %#v", events)
	}
	if events[0].Usage == nil || events[0].Usage.InputTokens != 2 || events[0].Usage.OutputTokens != 1 {
		t.Fatalf("unexpected usage: %#v", events[0].Usage)
	}
}

func TestChatParseStreamWaitsForDecoderReleaseBeforeClosing(t *testing.T) {
	body := newTerminalThenBlockingBody("data: [DONE]\n\n")
	events := collectEvents((&ChatAdapter{}).ParseStream(context.Background(), body))
	if len(events) != 1 || events[0].Type != types.EventDone {
		t.Fatalf("events = %#v", events)
	}
	select {
	case <-body.readExited:
	default:
		t.Fatal("adapter output closed before the SSE reader goroutine exited")
	}
}

func TestChatParseStreamEOFWithoutTerminalSignalIsError(t *testing.T) {
	stream := `data: {"choices":[{"delta":{"content":"hi"}}]}` + "\n\n"
	events := collectEvents((&ChatAdapter{}).ParseStream(context.Background(), io.NopCloser(strings.NewReader(stream))))
	if len(events) != 2 || events[0].Type != types.EventTextDelta || events[1].Type != types.EventError {
		t.Fatalf("unexpected events: %#v", events)
	}
	const want = "upstream stream ended without a terminal signal ([DONE] or finish_reason) — possible truncation"
	if events[1].Error != want {
		t.Fatalf("error = %q, want %q", events[1].Error, want)
	}
}

func TestOpenAIStreamsSurfaceTransportFailureForPreflight(t *testing.T) {
	for _, test := range []struct {
		name  string
		parse func(io.ReadCloser) <-chan types.AdapterEvent
	}{
		{name: "chat", parse: func(body io.ReadCloser) <-chan types.AdapterEvent {
			return (&ChatAdapter{}).ParseStream(context.Background(), body)
		}},
		{name: "responses", parse: func(body io.ReadCloser) <-chan types.AdapterEvent {
			return (&ResponsesAdapter{}).ParseStream(context.Background(), body)
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			stream := test.parse(io.NopCloser(errorReader{err: errors.New("invalid byte in chunk length")}))
			preflight := PreflightAdapterEvents(context.Background(), stream)
			if preflight.Error == nil || preflight.Error.Type != types.EventError {
				t.Fatalf("preflight = %#v", preflight)
			}
			if preflight.Error.StatusCode != 502 || !strings.Contains(preflight.Error.Error, "invalid byte in chunk length") {
				t.Fatalf("preflight error = %#v", preflight.Error)
			}
		})
	}
}

func TestChatMalformedSSEIsTerminalBeforeDoneMarker(t *testing.T) {
	stream := strings.Join([]string{
		`data: {"choices":[{"delta":{"content":"partial"}}]}`,
		`data: {not-json}`,
		`data: [DONE]`, "",
	}, "\n\n")
	events := collectEvents((&ChatAdapter{}).ParseStream(context.Background(), io.NopCloser(strings.NewReader(stream))))
	if len(events) == 0 || events[len(events)-1].Type != types.EventError || events[len(events)-1].Error != "malformed upstream SSE data frame" {
		t.Fatalf("events = %#v", events)
	}
	for _, event := range events {
		if event.Type == types.EventDone {
			t.Fatalf("malformed stream emitted done: %#v", events)
		}
	}
}

func TestResponsesParseStream(t *testing.T) {
	stream := "data: {\"type\":\"response.output_text.delta\",\"delta\":\"hi\"}\n\n" +
		"data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"usage\":{\"input_tokens\":2,\"output_tokens\":1}}}\n\n"
	events := collectEvents((&ResponsesAdapter{}).ParseStream(context.Background(), io.NopCloser(strings.NewReader(stream))))
	if len(events) != 2 || events[0].Text != "hi" || events[1].Type != types.EventDone || events[1].Usage.InputTokens != 2 {
		t.Fatalf("unexpected events: %#v", events)
	}
}

func TestResponsesParseStreamCommentEmitsHeartbeat(t *testing.T) {
	stream := strings.Join([]string{
		`: keepalive`,
		`data: {"type":"response.completed","response":{"status":"completed"}}`, "",
	}, "\n\n")
	events := collectEvents((&ResponsesAdapter{}).ParseStream(context.Background(), io.NopCloser(strings.NewReader(stream))))
	if len(events) != 2 || events[0].Type != types.EventHeartbeat || events[1].Type != types.EventDone {
		t.Fatalf("unexpected events: %#v", events)
	}
}

func TestResponsesParseStreamIncomplete(t *testing.T) {
	stream := "data: {\"type\":\"response.incomplete\",\"response\":{\"status\":\"incomplete\",\"incomplete_details\":{\"reason\":\"max_output_tokens\"},\"usage\":{\"input_tokens\":2,\"output_tokens\":3}}}\n\n"
	events := collectEvents((&ResponsesAdapter{}).ParseStream(context.Background(), io.NopCloser(strings.NewReader(stream))))
	if len(events) != 1 || events[0].Type != types.EventIncomplete || events[0].Reason != "max_output_tokens" {
		t.Fatalf("unexpected events: %#v", events)
	}
	if events[0].Usage == nil || events[0].Usage.TotalTokens != 0 || events[0].Usage.OutputTokens != 3 {
		t.Fatalf("unexpected usage: %#v", events[0].Usage)
	}
}

func TestResponsesParseStreamAbortsWhenConsumerBacklogExceedsPolicy(t *testing.T) {
	var stream strings.Builder
	for range 1100 {
		stream.WriteString("data: {\"type\":\"response.output_text.delta\",\"delta\":\"x\"}\n\n")
	}
	body := newCloseTrackingBody(stream.String())
	events := (&ResponsesAdapter{}).ParseStream(context.Background(), body)
	select {
	case <-body.closed:
	case <-time.After(2 * time.Second):
		t.Fatal("stalled consumer did not trigger bounded body cancellation")
	}
	collected := collectEvents(events)
	if len(collected) == 0 {
		t.Fatal("backlogged stream emitted no terminal event")
	}
	last := collected[len(collected)-1]
	if last.Type != types.EventError || last.Error != "consumer backlog exceeded — turn aborted" {
		t.Fatalf("terminal event = %#v", last)
	}
}

type closeTrackingBody struct {
	*strings.Reader
	closed    chan struct{}
	closeOnce sync.Once
}

func newCloseTrackingBody(payload string) *closeTrackingBody {
	return &closeTrackingBody{Reader: strings.NewReader(payload), closed: make(chan struct{})}
}

func (body *closeTrackingBody) Close() error {
	body.closeOnce.Do(func() { close(body.closed) })
	return nil
}

type terminalThenBlockingBody struct {
	payload    []byte
	closed     chan struct{}
	readExited chan struct{}
	closeOnce  sync.Once
	exitOnce   sync.Once
}

func newTerminalThenBlockingBody(payload string) *terminalThenBlockingBody {
	return &terminalThenBlockingBody{
		payload: []byte(payload), closed: make(chan struct{}), readExited: make(chan struct{}),
	}
}

func (body *terminalThenBlockingBody) Read(target []byte) (int, error) {
	if len(body.payload) > 0 {
		count := copy(target, body.payload)
		body.payload = body.payload[count:]
		return count, nil
	}
	<-body.closed
	time.Sleep(25 * time.Millisecond)
	body.exitOnce.Do(func() { close(body.readExited) })
	return 0, io.EOF
}

func (body *terminalThenBlockingBody) Close() error {
	body.closeOnce.Do(func() { close(body.closed) })
	return nil
}

func decodeRequestBody(t *testing.T, reader io.Reader) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.NewDecoder(reader).Decode(&body); err != nil {
		t.Fatal(err)
	}
	return body
}

func collectEvents(stream <-chan types.AdapterEvent) []types.AdapterEvent {
	var events []types.AdapterEvent
	for event := range stream {
		events = append(events, event)
	}
	return events
}

type errorReader struct{ err error }

func (r errorReader) Read([]byte) (int, error) { return 0, r.err }
