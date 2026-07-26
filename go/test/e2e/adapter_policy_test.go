package e2e

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/adapter/anthropic"
	openaiadapter "github.com/lidge-jun/opencodex-go/internal/adapter/openai"
	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

func TestProviderAwareConstructorsApplyRequestPolicy(t *testing.T) {
	strip := true
	chat := openaiadapter.NewChatAdapter(config.ProviderConfig{
		Adapter: "openai-chat", BaseURL: "https://chat.test/v1", DefaultMaxOutputTokens: 321,
		ModelSuffixBracketStrip: &strip, NoTemperatureModels: []string{"gpt-policy[1m]"},
	}, "chat-key", nil)
	temperature := 0.4
	request := &types.NormalizedRequest{
		ModelID: "gpt-policy[1m]", Context: types.RequestContext{Messages: []types.Message{{Role: "user", Content: json.RawMessage(`"hello"`)}}},
		Options: types.RequestOptions{Temperature: &temperature},
	}
	httpRequest, err := chat.BuildRequest(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	var chatBody map[string]any
	if err := json.NewDecoder(httpRequest.Body).Decode(&chatBody); err != nil {
		t.Fatal(err)
	}
	if chatBody["model"] != "gpt-policy" || chatBody["max_tokens"] != float64(321) || chatBody["temperature"] != nil {
		t.Fatalf("chat constructor policy was not applied: %#v", chatBody)
	}

	responses := openaiadapter.NewResponsesAdapter(config.ProviderConfig{
		Adapter: "openai-responses", BaseURL: "https://responses.test", ResponsesPath: "/custom/responses",
	}, "responses-key", nil)
	responsesRequest, err := responses.BuildRequest(context.Background(), &types.NormalizedRequest{
		ModelID: "gpt-responses", Context: types.RequestContext{Messages: []types.Message{{Role: "user", Content: json.RawMessage(`"hello"`)}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if responsesRequest.URL.String() != "https://responses.test/custom/responses" {
		t.Fatalf("ResponsesPath constructor policy = %s", responsesRequest.URL)
	}

	anthropicAdapter := anthropic.NewAdapter(config.ProviderConfig{Adapter: "anthropic", BaseURL: "https://api.anthropic.com", AuthMode: "oauth"}, "oauth-token", nil, "long")
	anthropicRequest, err := anthropicAdapter.BuildRequest(context.Background(), &types.NormalizedRequest{
		ModelID: "claude-opus-4-7", Context: types.RequestContext{Messages: []types.Message{{Role: "user", Content: json.RawMessage(`"hello"`)}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if anthropicRequest.Header.Get("Authorization") != "Bearer oauth-token" || anthropicRequest.Header.Get("anthropic-beta") != anthropic.AnthropicOAuthBeta {
		t.Fatalf("Anthropic constructor policy headers = %#v", anthropicRequest.Header)
	}
}

func TestMimoFetchPathRefreshesJWTAndRetriesUnauthorized(t *testing.T) {
	var bootstraps atomic.Int32
	var chats atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/bootstrap":
			attempt := bootstraps.Add(1)
			_ = json.NewEncoder(writer).Encode(map[string]string{"jwt": "jwt-" + string(rune('0'+attempt))})
		case "/chat":
			attempt := chats.Add(1)
			body, _ := io.ReadAll(request.Body)
			if !strings.Contains(string(body), openaiadapter.MimoSystemMarker) {
				t.Errorf("MiMo marker missing: %s", body)
			}
			if attempt == 1 {
				writer.WriteHeader(http.StatusUnauthorized)
				return
			}
			writer.Header().Set("Content-Type", "application/json")
			_, _ = writer.Write([]byte(`{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}`))
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()

	adapter := openaiadapter.NewMimoAdapter()
	adapter.Client = server.Client()
	adapter.BootstrapURL = server.URL + "/bootstrap"
	adapter.ChatURL = server.URL + "/chat"
	adapter.ConfigDir = t.TempDir()
	request, err := adapter.BuildRequest(context.Background(), &types.NormalizedRequest{
		ModelID: "mimo", Context: types.RequestContext{Messages: []types.Message{{Role: "user", Content: json.RawMessage(`"hello"`)}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	response, err := adapter.Do(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || bootstraps.Load() != 2 || chats.Load() != 2 {
		t.Fatalf("MiMo fetch path status=%d bootstrap=%d chat=%d", response.StatusCode, bootstraps.Load(), chats.Load())
	}
}

func TestAdapterStreamsCloseUpstreamBodyAfterTerminal(t *testing.T) {
	tests := []struct {
		name    string
		payload string
		parse   func(context.Context, io.ReadCloser) <-chan types.AdapterEvent
	}{
		{name: "chat", payload: "data: [DONE]\n\n", parse: (&openaiadapter.ChatAdapter{}).ParseStream},
		{name: "responses", payload: "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n", parse: (&openaiadapter.ResponsesAdapter{}).ParseStream},
		{name: "anthropic", payload: "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n", parse: (&anthropic.Adapter{}).ParseStream},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			body := newTerminalBlockingBody(test.payload)
			events := test.parse(context.Background(), body)
			for range events {
			}
			select {
			case <-body.closed:
			case <-time.After(time.Second):
				t.Fatal("adapter returned terminal event without closing upstream body")
			}
		})
	}
}

func TestAdapterStreamCancellationClosesBlockedBody(t *testing.T) {
	tests := []struct {
		name  string
		parse func(context.Context, io.ReadCloser) <-chan types.AdapterEvent
	}{
		{name: "chat", parse: (&openaiadapter.ChatAdapter{}).ParseStream},
		{name: "responses", parse: (&openaiadapter.ResponsesAdapter{}).ParseStream},
		{name: "anthropic", parse: (&anthropic.Adapter{}).ParseStream},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			body := newTerminalBlockingBody("")
			events := test.parse(ctx, body)
			cancel()
			for range events {
			}
			select {
			case <-body.closed:
			case <-time.After(time.Second):
				t.Fatal("context cancellation did not close blocked upstream body")
			}
		})
	}
}

type terminalBlockingBody struct {
	payload []byte
	once    sync.Once
	closed  chan struct{}
}

func newTerminalBlockingBody(payload string) *terminalBlockingBody {
	return &terminalBlockingBody{payload: []byte(payload), closed: make(chan struct{})}
}

func (body *terminalBlockingBody) Read(target []byte) (int, error) {
	if len(body.payload) > 0 {
		count := copy(target, body.payload)
		body.payload = body.payload[count:]
		return count, nil
	}
	<-body.closed
	return 0, io.EOF
}

func (body *terminalBlockingBody) Close() error {
	body.once.Do(func() { close(body.closed) })
	return nil
}
