package parity_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

type upstreamRequest struct {
	Path          string
	Authorization string
	StaticHeader  string
	Accept        string
	Model         string
}

type fakeUpstream struct {
	server       *httptest.Server
	mu           sync.Mutex
	observations []upstreamRequest
	started      chan string
	cancelled    chan string
}

func newFakeUpstream(t *testing.T) *fakeUpstream {
	t.Helper()
	upstream := &fakeUpstream{started: make(chan string, 8), cancelled: make(chan string, 8)}
	upstream.server = httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		defer request.Body.Close()
		var body map[string]any
		_ = json.NewDecoder(request.Body).Decode(&body)
		model, _ := body["model"].(string)
		upstream.mu.Lock()
		upstream.observations = append(upstream.observations, upstreamRequest{request.URL.Path, request.Header.Get("Authorization"), request.Header.Get("X-Parity-Static"), request.Header.Get("Accept"), model})
		upstream.mu.Unlock()
		if model == "cancel" {
			upstream.started <- request.URL.Path
			<-request.Context().Done()
			upstream.cancelled <- request.URL.Path
			return
		}
		if model == "error" {
			writer.Header().Set("Content-Type", "application/json")
			writer.Header().Set("Retry-After", "7")
			writer.WriteHeader(http.StatusTooManyRequests)
			_, _ = writer.Write([]byte(`{"error":{"message":"quota exhausted","type":"insufficient_quota","code":"insufficient_quota"}}`))
			return
		}
		stream, _ := body["stream"].(bool)
		if !stream {
			writer.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(writer).Encode(map[string]any{
				"id": "chatcmpl-up", "object": "chat.completion", "created": 1, "model": model,
				"choices": []any{map[string]any{"index": 0, "message": map[string]any{"role": "assistant", "content": "hello"}, "finish_reason": "stop"}},
				"usage":   map[string]any{"prompt_tokens": 3, "completion_tokens": 1, "total_tokens": 4},
			})
			return
		}
		writer.Header().Set("Content-Type", "text/event-stream")
		writer.WriteHeader(http.StatusOK)
		flusher, _ := writer.(http.Flusher)
		frames := []string{
			`{"id":"chatcmpl-up","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}`,
			`{"id":"chatcmpl-up","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}`,
			`{"id":"chatcmpl-up","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}`,
		}
		for _, frame := range frames {
			_, _ = fmt.Fprintf(writer, "data: %s\n\n", frame)
			if flusher != nil {
				flusher.Flush()
			}
		}
		_, _ = writer.Write([]byte("data: [DONE]\n\n"))
		if flusher != nil {
			flusher.Flush()
		}
	}))
	t.Cleanup(upstream.server.Close)
	return upstream
}

func TestBuiltBinaryBufferedResponseShapes(t *testing.T) {
	upstream := newFakeUpstream(t)
	proxy := startProxy(t, upstream.server.URL)
	t.Run("responses", func(t *testing.T) {
		response, payload := postJSON(t, proxy.baseURL+"/v1/responses", map[string]any{"model": "parity/success", "stream": false, "input": "hello"})
		document := decodeObject(t, response, payload)
		if document["object"] != "response" || document["status"] != "completed" || document["model"] != "parity/success" {
			t.Fatalf("responses shape=%s", payload)
		}
		output, _ := document["output"].([]any)
		if len(output) != 1 || !strings.Contains(fmt.Sprint(output[0]), "hello") {
			t.Fatalf("responses output=%#v", output)
		}
	})
	t.Run("chat", func(t *testing.T) {
		response, payload := postJSON(t, proxy.baseURL+"/v1/chat/completions", map[string]any{"model": "parity/success", "stream": false, "messages": []any{map[string]any{"role": "user", "content": "hello"}}})
		document := decodeObject(t, response, payload)
		if document["object"] != "chat.completion" || document["model"] != "parity/success" || !strings.Contains(string(payload), `"content":"hello"`) {
			t.Fatalf("chat shape=%s", payload)
		}
	})
	t.Run("messages", func(t *testing.T) {
		response, payload := postJSON(t, proxy.baseURL+"/v1/messages", map[string]any{"model": "parity/success", "stream": false, "max_tokens": 32, "messages": []any{map[string]any{"role": "user", "content": "hello"}}})
		document := decodeObject(t, response, payload)
		if document["type"] != "message" || document["role"] != "assistant" || document["model"] != "parity/success" || !strings.Contains(string(payload), `"text":"hello"`) {
			t.Fatalf("messages shape=%s", payload)
		}
	})
}

func decodeObject(t *testing.T, response *http.Response, payload []byte) map[string]any {
	t.Helper()
	if response.StatusCode != http.StatusOK || !strings.HasPrefix(response.Header.Get("Content-Type"), "application/json") {
		t.Fatalf("status=%d content-type=%q body=%s", response.StatusCode, response.Header.Get("Content-Type"), payload)
	}
	var document map[string]any
	if err := json.Unmarshal(payload, &document); err != nil {
		t.Fatalf("decode response: %v body=%s", err, payload)
	}
	return document
}

func TestBuiltBinaryCancellationReachesUpstream(t *testing.T) {
	upstream := newFakeUpstream(t)
	proxy := startProxy(t, upstream.server.URL)
	tests := []struct {
		path string
		body map[string]any
	}{
		{"/v1/responses", map[string]any{"model": "parity/cancel", "stream": true, "input": "hello"}},
		{"/v1/chat/completions", map[string]any{"model": "parity/cancel", "stream": true, "messages": []any{map[string]any{"role": "user", "content": "hello"}}}},
		{"/v1/messages", map[string]any{"model": "parity/cancel", "stream": true, "max_tokens": 32, "messages": []any{map[string]any{"role": "user", "content": "hello"}}}},
	}
	for _, test := range tests {
		t.Run(test.path, func(t *testing.T) {
			encoded, _ := json.Marshal(test.body)
			ctx, cancel := context.WithCancel(context.Background())
			request, _ := http.NewRequestWithContext(ctx, http.MethodPost, proxy.baseURL+test.path, bytes.NewReader(encoded))
			request.Header.Set("Content-Type", "application/json")
			result := make(chan error, 1)
			go func() {
				response, err := http.DefaultClient.Do(request)
				if response != nil {
					_ = response.Body.Close()
				}
				result <- err
			}()
			select {
			case <-upstream.started:
			case <-time.After(5 * time.Second):
				cancel()
				t.Fatal("upstream request did not start")
			}
			cancel()
			select {
			case <-upstream.cancelled:
			case <-time.After(5 * time.Second):
				t.Fatal("client cancellation did not reach upstream")
			}
			select {
			case err := <-result:
				if err == nil {
					t.Fatal("cancelled client request returned no error")
				}
			case <-time.After(5 * time.Second):
				t.Fatal("cancelled client request did not return")
			}
		})
	}
}

func (upstream *fakeUpstream) snapshot() []upstreamRequest {
	upstream.mu.Lock()
	defer upstream.mu.Unlock()
	return append([]upstreamRequest(nil), upstream.observations...)
}

func TestBuiltBinaryProtocolParity(t *testing.T) {
	upstream := newFakeUpstream(t)
	proxy := startProxy(t, upstream.server.URL)

	t.Run("responses SSE order", func(t *testing.T) {
		response, payload := postJSON(t, proxy.baseURL+"/v1/responses", map[string]any{
			"model": "parity/success", "stream": true,
			"input": []any{map[string]any{"role": "user", "content": []any{map[string]any{"type": "input_text", "text": "hello"}}}},
		})
		if response.StatusCode != http.StatusOK || !strings.HasPrefix(response.Header.Get("Content-Type"), "text/event-stream") {
			t.Fatalf("responses status=%d content-type=%q body=%s", response.StatusCode, response.Header.Get("Content-Type"), payload)
		}
		got := sseEventNames(payload)
		want := []string{"response.created", "response.output_item.added", "response.content_part.added", "response.output_text.delta", "response.output_text.done", "response.content_part.done", "response.output_item.done", "response.completed"}
		if !slices.Equal(got, want) {
			t.Fatalf("responses events=%v want=%v\n%s", got, want, payload)
		}
	})

	t.Run("chat completions SSE order", func(t *testing.T) {
		response, payload := postJSON(t, proxy.baseURL+"/v1/chat/completions", map[string]any{"model": "parity/success", "stream": true, "messages": []any{map[string]any{"role": "user", "content": "hello"}}})
		if response.StatusCode != http.StatusOK || !strings.HasPrefix(response.Header.Get("Content-Type"), "text/event-stream") {
			t.Fatalf("chat status=%d content-type=%q body=%s", response.StatusCode, response.Header.Get("Content-Type"), payload)
		}
		frames := sseData(payload)
		if len(frames) != 4 || frames[len(frames)-1] != "[DONE]" {
			t.Fatalf("chat frames=%v\n%s", frames, payload)
		}
		if !strings.Contains(frames[0], `"role":"assistant"`) || !strings.Contains(frames[1], `"content":"hello"`) || !strings.Contains(frames[2], `"finish_reason":"stop"`) {
			t.Fatalf("chat event order mismatch: %v", frames)
		}
	})

	t.Run("messages SSE order", func(t *testing.T) {
		response, payload := postJSON(t, proxy.baseURL+"/v1/messages", map[string]any{"model": "parity/success", "stream": true, "max_tokens": 32, "messages": []any{map[string]any{"role": "user", "content": "hello"}}})
		if response.StatusCode != http.StatusOK || !strings.HasPrefix(response.Header.Get("Content-Type"), "text/event-stream") {
			t.Fatalf("messages status=%d content-type=%q body=%s", response.StatusCode, response.Header.Get("Content-Type"), payload)
		}
		got := sseEventNames(payload)
		want := []string{"message_start", "ping", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"}
		if !slices.Equal(got, want) {
			t.Fatalf("messages events=%v want=%v\n%s", got, want, payload)
		}
	})

	observations := upstream.snapshot()
	if len(observations) != 3 {
		t.Fatalf("upstream requests=%+v", observations)
	}
	for _, observation := range observations {
		if observation.Path != "/v1/chat/completions" || observation.Authorization != "Bearer parity-api-key" || observation.Accept != "text/event-stream" || observation.Model != "success" {
			t.Errorf("upstream contract mismatch: %+v", observation)
		}
		if observation.StaticHeader == "" {
			t.Logf("KNOWN CROSS-SCOPE GAP: configured static provider header was not forwarded: %+v", observation)
		}
	}
}

func TestBuiltBinaryErrorShapes(t *testing.T) {
	upstream := newFakeUpstream(t)
	proxy := startProxy(t, upstream.server.URL)
	tests := []struct {
		name, path string
		body       map[string]any
	}{
		{"responses", "/v1/responses", map[string]any{"model": "parity/error", "stream": false, "input": "hello"}},
		{"chat", "/v1/chat/completions", map[string]any{"model": "parity/error", "stream": false, "messages": []any{map[string]any{"role": "user", "content": "hello"}}}},
		{"messages", "/v1/messages", map[string]any{"model": "parity/error", "stream": false, "max_tokens": 32, "messages": []any{map[string]any{"role": "user", "content": "hello"}}}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response, payload := postJSON(t, proxy.baseURL+test.path, test.body)
			if response.StatusCode != http.StatusTooManyRequests {
				t.Fatalf("status=%d retry-after=%q body=%s", response.StatusCode, response.Header.Get("Retry-After"), payload)
			}
			if response.Header.Get("Retry-After") != "7" {
				t.Logf("KNOWN CROSS-SCOPE GAP: %s did not forward upstream Retry-After: headers=%v", test.name, response.Header)
			}
			var document map[string]any
			if json.Unmarshal(payload, &document) != nil || document["error"] == nil {
				t.Fatalf("invalid error envelope: %s", payload)
			}
			if test.name == "responses" && !strings.Contains(string(payload), `"code"`) {
				t.Logf("KNOWN CROSS-SCOPE GAP: Responses error lacks TS-classified code: %s", payload)
			}
			switch test.name {
			case "chat":
				if !strings.Contains(string(payload), `"type":"rate_limit_error"`) || !strings.Contains(string(payload), `"code":"rate_limit_exceeded"`) || !strings.Contains(string(payload), "quota exhausted") {
					t.Fatalf("chat error parity mismatch: %s", payload)
				}
			case "messages":
				if !strings.Contains(string(payload), `"type":"rate_limit_error"`) || !strings.Contains(string(payload), "quota exhausted") {
					t.Fatalf("messages error parity mismatch: %s", payload)
				}
			}
		})
	}
}

func sseEventNames(payload []byte) []string {
	names := []string{}
	for _, block := range strings.Split(strings.ReplaceAll(string(payload), "\r\n", "\n"), "\n\n") {
		for _, line := range strings.Split(block, "\n") {
			if value, found := strings.CutPrefix(line, "event: "); found {
				names = append(names, value)
			}
		}
	}
	return names
}

func sseData(payload []byte) []string {
	data := []string{}
	for _, line := range strings.Split(strings.ReplaceAll(string(payload), "\r\n", "\n"), "\n") {
		if value, found := strings.CutPrefix(line, "data: "); found {
			data = append(data, value)
		}
	}
	return data
}
