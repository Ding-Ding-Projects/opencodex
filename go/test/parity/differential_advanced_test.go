package parity_test

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

type advancedDifferentialUpstream struct {
	server   *httptest.Server
	requests chan map[string]any
	mu       sync.Mutex
	peers    map[string]bool
}

func newAdvancedDifferentialUpstream(t *testing.T) *advancedDifferentialUpstream {
	t.Helper()
	upstream := &advancedDifferentialUpstream{requests: make(chan map[string]any, 64), peers: map[string]bool{}}
	upstream.server = httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		upstream.mu.Lock()
		upstream.peers[request.RemoteAddr] = true
		upstream.mu.Unlock()
		var body map[string]any
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Errorf("decode advanced upstream request: %v", err)
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		upstream.requests <- body
		model, _ := body["model"].(string)
		writer.Header().Set("Content-Type", "text/event-stream")
		writer.WriteHeader(http.StatusOK)
		flusher, _ := writer.(http.Flusher)
		frame := func(payload string) {
			_, _ = io.WriteString(writer, "data: "+payload+"\n\n")
			if flusher != nil {
				flusher.Flush()
			}
		}
		frame(`{"id":"chatcmpl-advanced","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}`)
		switch model {
		case "tool":
			frame(`{"id":"chatcmpl-advanced","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_weather","type":"function","function":{"name":"get_weather","arguments":"{\"city\":\"Seoul\"}"}}]},"finish_reason":null}]}`)
			frame(`{"id":"chatcmpl-advanced","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":8,"completion_tokens":4,"total_tokens":12}}`)
		case "reasoning":
			frame(`{"id":"chatcmpl-advanced","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"reasoning_content":"private thought"},"finish_reason":null}]}`)
			frame(`{"id":"chatcmpl-advanced","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"reasoned answer"},"finish_reason":null}]}`)
			frame(`{"id":"chatcmpl-advanced","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":4,"total_tokens":9}}`)
		case "large":
			chunk, _ := json.Marshal(strings.Repeat("x", 64*1024))
			for range 192 {
				frame(fmt.Sprintf(`{"id":"chatcmpl-advanced","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":%s},"finish_reason":null}]}`, chunk))
			}
			frame(`{"id":"chatcmpl-advanced","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":3145728,"total_tokens":3145730}}`)
		case "jitter":
			for index, delay := range []time.Duration{5 * time.Millisecond, 35 * time.Millisecond, time.Millisecond, 20 * time.Millisecond} {
				time.Sleep(delay)
				frame(fmt.Sprintf(`{"id":"chatcmpl-advanced","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"jitter-%d"},"finish_reason":null}]}`, index))
			}
			frame(`{"id":"chatcmpl-advanced","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":4,"total_tokens":6}}`)
		case "disconnect":
			if hijacker, ok := writer.(http.Hijacker); ok {
				connection, buffer, hijackErr := hijacker.Hijack()
				if hijackErr == nil {
					_, _ = buffer.WriteString("data: {\"id\":\"chatcmpl-cut\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"잘린")
					_ = buffer.Flush()
					_ = connection.Close()
					return
				}
			}
		case "unicode-split":
			payload, _ := json.Marshal(map[string]any{"id": "chatcmpl-advanced", "object": "chat.completion.chunk", "choices": []any{map[string]any{"index": 0, "delta": map[string]any{"content": "안녕하세요 世界 👩🏽‍💻🚀"}, "finish_reason": nil}}})
			wire := append(append([]byte("data: "), payload...), '\n', '\n')
			for _, octet := range wire {
				_, _ = writer.Write([]byte{octet})
				if flusher != nil {
					flusher.Flush()
				}
			}
			frame(`{"id":"chatcmpl-advanced","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":6,"total_tokens":9}}`)
		case "malformed-sse":
			frame(`{"id":"chatcmpl-advanced","choices":[{"index":0,"delta":{"content":"before"},"finish_reason":null}]}`)
			frame(`{"id":`)
		default:
			content := "advanced final"
			if strings.HasPrefix(model, "concurrent-") {
				content = model
			}
			encodedContent, _ := json.Marshal(content)
			frame(fmt.Sprintf(`{"id":"chatcmpl-advanced","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":%s},"finish_reason":null}]}`, encodedContent))
			frame(`{"id":"chatcmpl-advanced","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}`)
		}
		frame("[DONE]")
	}))
	t.Cleanup(upstream.server.Close)
	return upstream
}

func advancedDifferentialConfig(upstreamURL string) map[string]any {
	models := []string{"tool", "final", "reasoning", "large", "jitter", "disconnect", "unicode-split", "malformed-sse", "multiturn", "image", "structured"}
	for index := range 12 {
		models = append(models, fmt.Sprintf("concurrent-%02d", index))
	}
	return differentialConfig(upstreamURL, models)
}

func (upstream *advancedDifferentialUpstream) connectionCount() int {
	upstream.mu.Lock()
	defer upstream.mu.Unlock()
	return len(upstream.peers)
}

func TestTypeScriptAndGoAdvancedResponsesMatrix(t *testing.T) {
	upstream := newAdvancedDifferentialUpstream(t)
	config := advancedDifferentialConfig(upstream.server.URL)
	tsProxy := startTypeScriptProxy(t, config)
	goProxy := startProxyWithConfig(t, config)

	for _, scenario := range []struct {
		name  string
		model string
		input any
	}{
		{name: "tool-call", model: "tool", input: "weather in Seoul"},
		{name: "tool-result-final", model: "final", input: []any{
			map[string]any{"type": "message", "role": "user", "content": []any{map[string]any{"type": "input_text", "text": "weather in Seoul"}}},
			map[string]any{"type": "function_call", "id": "fc_static", "call_id": "call_weather", "name": "get_weather", "arguments": `{"city":"Seoul"}`},
			map[string]any{"type": "function_call_output", "call_id": "call_weather", "output": "sunny"},
		}},
		{name: "reasoning", model: "reasoning", input: "think first"},
		{name: "large-12mib", model: "large", input: "large response"},
		{name: "irregular-jitter", model: "jitter", input: "slow response"},
		{name: "network-disconnect", model: "disconnect", input: "disconnect"},
		{name: "unicode-byte-split", model: "unicode-split", input: "한국어"},
		{name: "malformed-sse", model: "malformed-sse", input: "malformed"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			body := map[string]any{"model": "differential/" + scenario.model, "input": scenario.input, "stream": true}
			if scenario.model == "reasoning" {
				body["reasoning"] = map[string]any{"summary": "detailed"}
			}
			goResult := captureJSON(t, goProxy.baseURL, "/v1/responses", body)
			<-upstream.requests
			tsResult := captureJSON(t, tsProxy.baseURL, "/v1/responses", body)
			<-upstream.requests
			compareRuntimeBytes(t, "advanced/"+scenario.name, goResult, tsResult, true)
		})
	}
}

func TestTypeScriptAndGoAdvancedRequestTransforms(t *testing.T) {
	upstream := newAdvancedDifferentialUpstream(t)
	config := advancedDifferentialConfig(upstream.server.URL)
	tsProxy := startTypeScriptProxy(t, config)
	goProxy := startProxyWithConfig(t, config)
	structuredFormat := map[string]any{
		"type": "json_schema", "name": "answer", "strict": true,
		"schema": map[string]any{"type": "object", "properties": map[string]any{"value": map[string]any{"type": "string"}}, "required": []string{"value"}, "additionalProperties": false},
	}
	cases := []struct {
		name  string
		model string
		body  map[string]any
	}{
		{name: "multiturn", model: "multiturn", body: map[string]any{"input": []any{
			map[string]any{"role": "user", "content": "first"}, map[string]any{"role": "assistant", "content": "reply"}, map[string]any{"role": "user", "content": "second"},
		}}},
		{name: "image", model: "image", body: map[string]any{"input": []any{map[string]any{"role": "user", "content": []any{
			map[string]any{"type": "input_text", "text": "describe"}, map[string]any{"type": "input_image", "image_url": "data:image/png;base64,iVBORw0KGgo="},
		}}}}},
		{name: "structured", model: "structured", body: map[string]any{"input": "return json", "text": map[string]any{"format": structuredFormat}}},
	}
	for _, scenario := range cases {
		t.Run(scenario.name, func(t *testing.T) {
			body := scenario.body
			body["model"], body["stream"] = "differential/"+scenario.model, true
			goResult := captureJSON(t, goProxy.baseURL, "/v1/responses", body)
			goRequest := <-upstream.requests
			tsResult := captureJSON(t, tsProxy.baseURL, "/v1/responses", body)
			tsRequest := <-upstream.requests
			compareRuntimeBytes(t, "advanced/"+scenario.name, goResult, tsResult, false)
			if !reflect.DeepEqual(goRequest, tsRequest) {
				t.Fatalf("advanced/%s upstream request differs\nGo=%s\nTS=%s", scenario.name, mustJSON(goRequest), mustJSON(tsRequest))
			}
		})
	}
}

func TestTypeScriptAndGoInvalidRequestMatrix(t *testing.T) {
	upstream := newAdvancedDifferentialUpstream(t)
	config := advancedDifferentialConfig(upstream.server.URL)
	tsProxy := startTypeScriptProxy(t, config)
	goProxy := startProxyWithConfig(t, config)
	for _, scenario := range []struct {
		name string
		body []byte
	}{
		{name: "malformed-json", body: []byte(`{"model":`)},
		{name: "model-wrong-type", body: []byte(`{"model":42,"input":"x","stream":true}`)},
		{name: "input-wrong-type", body: []byte(`{"model":"differential/final","input":{"bad":true},"stream":true}`)},
		{name: "stream-wrong-type", body: []byte(`{"model":"differential/final","input":"x","stream":"yes"}`)},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			goResult := captureRawRequest(goProxy.baseURL+"/v1/responses", scenario.body, nil)
			tsResult := captureRawRequest(tsProxy.baseURL+"/v1/responses", scenario.body, nil)
			compareRuntimeBytes(t, "invalid/"+scenario.name, goResult, tsResult, true)
		})
	}
	t.Run("oversized-header", func(t *testing.T) {
		headers := http.Header{"X-Oversized-Parity": []string{strings.Repeat("h", 1100<<10)}}
		body := []byte(`{"model":"differential/final","input":"x","stream":true}`)
		goResult := captureRawRequest(goProxy.baseURL+"/v1/responses", body, headers)
		tsResult := captureRawRequest(tsProxy.baseURL+"/v1/responses", body, headers)
		if goResult.err != nil || goResult.status != http.StatusRequestHeaderFieldsTooLarge || len(goResult.body) != 0 {
			t.Fatalf("Go oversized-header contract changed: status=%d err=%v body=%q", goResult.status, goResult.err, goResult.body)
		}
		if tsResult.err == nil && (tsResult.status != http.StatusRequestHeaderFieldsTooLarge || len(tsResult.body) != 0) {
			t.Fatalf("Bun oversized-header contract changed: status=%d body=%q", tsResult.status, tsResult.body)
		}
	})
}

func TestTypeScriptAndGoConcurrentStreamsAndKeepAlive(t *testing.T) {
	upstream := newAdvancedDifferentialUpstream(t)
	config := advancedDifferentialConfig(upstream.server.URL)
	tsProxy := startTypeScriptProxy(t, config)
	goProxy := startProxyWithConfig(t, config)
	type result struct {
		name     string
		goResult runtimeResponse
		tsResult runtimeResponse
	}
	results := make(chan result, 12)
	var group sync.WaitGroup
	for index := range 12 {
		group.Add(1)
		go func() {
			defer group.Done()
			name := fmt.Sprintf("concurrent-%02d", index)
			body := []byte(fmt.Sprintf(`{"model":"differential/%s","input":"%s","stream":true}`, name, name))
			goResult := captureRawRequest(goProxy.baseURL+"/v1/responses", body, nil)
			tsResult := captureRawRequest(tsProxy.baseURL+"/v1/responses", body, nil)
			results <- result{name: name, goResult: goResult, tsResult: tsResult}
		}()
	}
	group.Wait()
	close(results)
	for captured := range results {
		compareRuntimeBytes(t, "concurrent/"+captured.name, captured.goResult, captured.tsResult, false)
		if !bytes.Contains(captured.goResult.body, []byte(captured.name)) || !bytes.Contains(captured.tsResult.body, []byte(captured.name)) {
			t.Fatalf("%s stream was interleaved with another request", captured.name)
		}
	}
	connectionsBeforeReuse := upstream.connectionCount()
	reuseBody := []byte(`{"model":"differential/final","input":"reuse","stream":true}`)
	for range 2 {
		if result := captureRawRequest(goProxy.baseURL+"/v1/responses", reuseBody, nil); result.err != nil || result.status != http.StatusOK {
			t.Fatalf("Go keep-alive probe failed: %+v", result)
		}
		if result := captureRawRequest(tsProxy.baseURL+"/v1/responses", reuseBody, nil); result.err != nil || result.status != http.StatusOK {
			t.Fatalf("TS keep-alive probe failed: %+v", result)
		}
	}
	if count := upstream.connectionCount(); count != connectionsBeforeReuse {
		t.Fatalf("sequential requests did not reuse idle upstream connections: before=%d after=%d", connectionsBeforeReuse, count)
	}
}

func TestTypeScriptAndGoHTTP2NegotiationBoundary(t *testing.T) {
	upstream := newAdvancedDifferentialUpstream(t)
	config := advancedDifferentialConfig(upstream.server.URL)
	tsProxy := startTypeScriptProxy(t, config)
	goProxy := startProxyWithConfig(t, config)
	client := &http.Client{Transport: &http.Transport{ForceAttemptHTTP2: true}}
	defer client.CloseIdleConnections()
	for attempt := range 2 {
		goResponse, goErr := client.Get(goProxy.baseURL + "/api/providers")
		if goErr != nil {
			t.Fatal(goErr)
		}
		goBody, _ := io.ReadAll(goResponse.Body)
		_ = goResponse.Body.Close()
		tsResponse, tsErr := client.Get(tsProxy.baseURL + "/api/providers")
		if tsErr != nil {
			t.Fatal(tsErr)
		}
		tsBody, _ := io.ReadAll(tsResponse.Body)
		_ = tsResponse.Body.Close()
		if goResponse.ProtoMajor != tsResponse.ProtoMajor || goResponse.StatusCode != tsResponse.StatusCode || !bytes.Equal(goBody, tsBody) {
			t.Fatalf("HTTP negotiation attempt %d differs: Go=%s/%d/%s TS=%s/%d/%s", attempt, goResponse.Proto, goResponse.StatusCode, goBody, tsResponse.Proto, tsResponse.StatusCode, tsBody)
		}
		if goResponse.ProtoMajor != 1 {
			t.Fatalf("cleartext parity listeners unexpectedly negotiated %s", goResponse.Proto)
		}
	}
}

func TestTypeScriptAndGoHealthRoute(t *testing.T) {
	upstream := newAdvancedDifferentialUpstream(t)
	config := advancedDifferentialConfig(upstream.server.URL)
	tsProxy := startTypeScriptProxy(t, config)
	goProxy := startProxyWithConfig(t, config)
	compareRuntimeBytes(t, "server/health-route", captureGET(t, goProxy.baseURL, "/health"), captureGET(t, tsProxy.baseURL, "/health"), true)
}

func TestTypeScriptAndGoInvalidChunkEncoding(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		for {
			connection, acceptErr := listener.Accept()
			if acceptErr != nil {
				return
			}
			go func() {
				defer connection.Close()
				reader := bufio.NewReader(connection)
				for {
					line, readErr := reader.ReadString('\n')
					if readErr != nil || line == "\r\n" {
						break
					}
				}
				payload := []byte("data: {\"id\":\"chatcmpl-broken\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\"},\"finish_reason\":null}]}\n\n")
				_, _ = fmt.Fprintf(connection, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n%x\r\n%s\r\nZZ\r\nbroken\r\n", len(payload), payload)
			}()
		}
	}()
	config := differentialConfig("http://"+listener.Addr().String(), []string{"broken"})
	tsProxy := startTypeScriptProxy(t, config)
	goProxy := startProxyWithConfig(t, config)
	body := map[string]any{"model": "differential/broken", "input": "broken chunks", "stream": true}
	goResult := captureJSON(t, goProxy.baseURL, "/v1/responses", body)
	tsResult := captureJSON(t, tsProxy.baseURL, "/v1/responses", body)
	compareRuntimeBytes(t, "nonstandard/invalid-chunk-encoding", goResult, tsResult, true)
}

func captureRawRequest(url string, body []byte, headers http.Header) runtimeResponse {
	request, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return runtimeResponse{err: err}
	}
	request.Header.Set("Content-Type", "application/json")
	for key, values := range headers {
		request.Header[key] = append([]string(nil), values...)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return runtimeResponse{err: err}
	}
	defer response.Body.Close()
	payload, readErr := io.ReadAll(response.Body)
	return runtimeResponse{status: response.StatusCode, header: response.Header.Clone(), body: payload, err: readErr}
}

func mustJSON(value any) []byte {
	encoded, _ := json.Marshal(value)
	return encoded
}
