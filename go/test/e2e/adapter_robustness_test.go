package e2e

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/adapter/anthropic"
	googleadapter "github.com/lidge-jun/opencodex-go/internal/adapter/google"
	"github.com/lidge-jun/opencodex-go/internal/adapter/kiro"
	openaiadapter "github.com/lidge-jun/opencodex-go/internal/adapter/openai"
	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

type streamParser func(context.Context, io.ReadCloser) <-chan types.AdapterEvent

func TestAdaptersRejectMissingResponseBodies(t *testing.T) {
	parsers := map[string]streamParser{
		"anthropic":        (&anthropic.Adapter{}).ParseStream,
		"openai-chat":      (&openaiadapter.ChatAdapter{}).ParseStream,
		"openai-responses": (&openaiadapter.ResponsesAdapter{}).ParseStream,
		"google":           (&googleadapter.Adapter{}).ParseStream,
		"kiro":             kiro.NewAdapter("https://runtime.test", "token").ParseStream,
		"mimo":             openaiadapter.NewMimoAdapter().ParseStream,
	}
	for name, parse := range parsers {
		t.Run(name, func(t *testing.T) {
			events := collectStressEvents(parse(context.Background(), nil))
			if len(events) != 1 || events[0].Type != types.EventError || strings.TrimSpace(events[0].Error) == "" {
				t.Fatalf("missing body events = %#v", events)
			}
		})
	}
}

func TestJSONAdaptersHandleMalformedUnknownEmptyAndDisconnect(t *testing.T) {
	tests := []struct {
		name              string
		parse             streamParser
		malformed         string
		unknownThenFinish string
	}{
		{name: "anthropic", parse: (&anthropic.Adapter{}).ParseStream,
			malformed:         "data: {bad\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
			unknownThenFinish: "event: future_event\ndata: {\"type\":\"future_event\"}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"},
		{name: "openai-chat", parse: (&openaiadapter.ChatAdapter{}).ParseStream,
			malformed:         "data: {bad\n\ndata: [DONE]\n\n",
			unknownThenFinish: "data: {\"future\":true}\n\ndata: [DONE]\n\n"},
		{name: "openai-responses", parse: (&openaiadapter.ResponsesAdapter{}).ParseStream,
			malformed:         "data: {bad\n\ndata: {\"type\":\"response.completed\",\"response\":{}}\n\n",
			unknownThenFinish: "data: {\"type\":\"response.future\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{}}\n\n"},
		{name: "google", parse: (&googleadapter.Adapter{}).ParseStream,
			malformed:         "data: {bad\n\n",
			unknownThenFinish: "data: {\"future\":true}\n\ndata: {\"usageMetadata\":{\"promptTokenCount\":1}}\n\n"},
		{name: "mimo", parse: openaiadapter.NewMimoAdapter().ParseStream,
			malformed:         "data: {bad\n\ndata: [DONE]\n\n",
			unknownThenFinish: "data: {\"future\":true}\n\ndata: [DONE]\n\n"},
	}
	for _, test := range tests {
		t.Run(test.name+"/malformed", func(t *testing.T) {
			events := collectStressEvents(test.parse(context.Background(), io.NopCloser(strings.NewReader(test.malformed))))
			if len(events) == 0 {
				t.Fatal("malformed stream was silently swallowed")
			}
			terminal := events[len(events)-1].Type
			if terminal != types.EventDone && terminal != types.EventError && terminal != types.EventIncomplete {
				t.Fatalf("malformed stream has no terminal event: %#v", events)
			}
		})
		t.Run(test.name+"/unknown", func(t *testing.T) {
			events := collectStressEvents(test.parse(context.Background(), io.NopCloser(strings.NewReader(test.unknownThenFinish))))
			if len(events) == 0 || events[len(events)-1].Type != types.EventDone {
				t.Fatalf("unknown event broke a later terminal event: %#v", events)
			}
		})
		t.Run(test.name+"/empty", func(t *testing.T) {
			events := collectStressEvents(test.parse(context.Background(), io.NopCloser(strings.NewReader(""))))
			if len(events) == 0 || events[len(events)-1].Type != types.EventError {
				t.Fatalf("empty stream did not fail closed: %#v", events)
			}
		})
		t.Run(test.name+"/disconnect", func(t *testing.T) {
			events := collectStressEvents(test.parse(context.Background(), &faultReadCloser{
				payload: []byte("data: {\"partial\":"), err: errors.New("connection reset by peer"),
			}))
			if len(events) == 0 || events[len(events)-1].Type != types.EventError {
				t.Fatalf("mid-stream disconnect was silently swallowed: %#v", events)
			}
		})
	}
}

func TestAdaptersHandleOversizedUpstreamRecordsWithoutPanic(t *testing.T) {
	large := strings.Repeat("x", 9<<20)
	tests := []struct {
		name    string
		parse   streamParser
		payload string
	}{
		{name: "anthropic", parse: (&anthropic.Adapter{}).ParseStream, payload: "data: " + large + "\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"},
		{name: "openai-chat", parse: (&openaiadapter.ChatAdapter{}).ParseStream, payload: "data: " + large + "\n\n"},
		{name: "openai-responses", parse: (&openaiadapter.ResponsesAdapter{}).ParseStream, payload: "data: " + large + "\n\n"},
		{name: "google", parse: (&googleadapter.Adapter{}).ParseStream, payload: "data: " + large},
		{name: "mimo", parse: openaiadapter.NewMimoAdapter().ParseStream, payload: "data: " + large + "\n\n"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			events := collectStressEvents(test.parse(context.Background(), io.NopCloser(strings.NewReader(test.payload))))
			if len(events) == 0 {
				t.Fatal("oversized upstream record produced no terminal outcome")
			}
			terminal := events[len(events)-1].Type
			if terminal != types.EventDone && terminal != types.EventError {
				t.Fatalf("oversized record terminal = %q: %#v", terminal, events)
			}
		})
	}
}

func TestAdapterRequestBuildersAreRaceSafeUnderParallelLoad(t *testing.T) {
	newRequest := func() *types.NormalizedRequest {
		return &types.NormalizedRequest{
			ModelID: "model", Context: types.RequestContext{Messages: []types.Message{{Role: "user", Content: json.RawMessage(`"hello"`)}}},
		}
	}
	builders := map[string]types.Adapter{
		"anthropic":        anthropic.NewAdapter(config.ProviderConfig{Adapter: "anthropic", BaseURL: "https://proxy.test"}, "key", nil, "short"),
		"openai-chat":      openaiadapter.NewChatAdapter(config.ProviderConfig{Adapter: "openai-chat", BaseURL: "https://chat.test/v1"}, "key", nil),
		"openai-responses": openaiadapter.NewResponsesAdapter(config.ProviderConfig{Adapter: "openai-responses", BaseURL: "https://responses.test"}, "key", nil),
		"google":           googleadapter.NewAdapter(googleadapter.ModeAIStudio, &types.Transport{BaseURL: "https://google.test"}, &types.AuthContext{APIKey: "key"}),
		"kiro":             kiro.NewAdapter("https://runtime.test", "token"),
	}
	for name, adapter := range builders {
		t.Run(name, func(t *testing.T) {
			var wait sync.WaitGroup
			errors := make(chan error, 24)
			for index := 0; index < 24; index++ {
				wait.Add(1)
				go func() {
					defer wait.Done()
					built, err := adapter.BuildRequest(context.Background(), newRequest())
					if err == nil {
						err = built.Body.Close()
					}
					errors <- err
				}()
			}
			wait.Wait()
			close(errors)
			for err := range errors {
				if err != nil {
					t.Fatal(err)
				}
			}
		})
	}
}

func TestAdapterStreamParsersAreRaceSafeUnderParallelLoad(t *testing.T) {
	tests := []struct {
		name    string
		parse   streamParser
		payload string
	}{
		{name: "anthropic", parse: (&anthropic.Adapter{}).ParseStream, payload: "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"},
		{name: "openai-chat", parse: (&openaiadapter.ChatAdapter{}).ParseStream, payload: "data: [DONE]\n\n"},
		{name: "openai-responses", parse: (&openaiadapter.ResponsesAdapter{}).ParseStream, payload: "data: {\"type\":\"response.completed\",\"response\":{}}\n\n"},
		{name: "google", parse: (&googleadapter.Adapter{}).ParseStream, payload: "data: {\"usageMetadata\":{\"promptTokenCount\":1}}\n\n"},
		{name: "mimo", parse: openaiadapter.NewMimoAdapter().ParseStream, payload: "data: [DONE]\n\n"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			const workers = 24
			start := make(chan struct{})
			errors := make(chan string, workers)
			var wait sync.WaitGroup
			for index := 0; index < workers; index++ {
				wait.Add(1)
				go func() {
					defer wait.Done()
					<-start
					events := collectStressEvents(test.parse(context.Background(), io.NopCloser(strings.NewReader(test.payload))))
					if len(events) == 0 || events[len(events)-1].Type != types.EventDone {
						errors <- "stream did not finish with done"
					}
				}()
			}
			close(start)
			wait.Wait()
			close(errors)
			for message := range errors {
				t.Error(message)
			}
		})
	}
}

func collectStressEvents(events <-chan types.AdapterEvent) []types.AdapterEvent {
	out := make([]types.AdapterEvent, 0)
	for event := range events {
		out = append(out, event)
	}
	return out
}

type faultReadCloser struct {
	payload []byte
	err     error
}

func (reader *faultReadCloser) Read(target []byte) (int, error) {
	if len(reader.payload) > 0 {
		count := copy(target, reader.payload)
		reader.payload = reader.payload[count:]
		return count, nil
	}
	return 0, reader.err
}
func (*faultReadCloser) Close() error { return nil }
