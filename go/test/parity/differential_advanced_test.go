package parity_test

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

type advancedDifferentialUpstream struct {
	server   *httptest.Server
	requests chan map[string]any
}

func newAdvancedDifferentialUpstream(t *testing.T) *advancedDifferentialUpstream {
	t.Helper()
	upstream := &advancedDifferentialUpstream{requests: make(chan map[string]any, 32)}
	upstream.server = httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
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
			for range 48 {
				frame(fmt.Sprintf(`{"id":"chatcmpl-advanced","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":%s},"finish_reason":null}]}`, chunk))
			}
			frame(`{"id":"chatcmpl-advanced","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":786432,"total_tokens":786434}}`)
		default:
			frame(`{"id":"chatcmpl-advanced","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"advanced final"},"finish_reason":null}]}`)
			frame(`{"id":"chatcmpl-advanced","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}`)
		}
		frame("[DONE]")
	}))
	t.Cleanup(upstream.server.Close)
	return upstream
}

func advancedDifferentialConfig(upstreamURL string) map[string]any {
	models := []string{"tool", "final", "reasoning", "large", "multiturn", "image", "structured"}
	return differentialConfig(upstreamURL, models)
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
		{name: "large-3mib", model: "large", input: "large response"},
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

func mustJSON(value any) []byte {
	encoded, _ := json.Marshal(value)
	return encoded
}
