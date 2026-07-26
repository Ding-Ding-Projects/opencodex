package parity_test

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

type wireRouteRequest struct {
	path  string
	model string
}

func TestTypeScriptAndGoPerModelWireOverrideRoutes(t *testing.T) {
	requests := make(chan wireRouteRequest, 8)
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Errorf("decode wire-route request: %v", err)
		}
		model, _ := body["model"].(string)
		requests <- wireRouteRequest{path: request.URL.Path, model: model}
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(writer, `{"error":{"message":"wire route probe","type":"invalid_request_error"}}`)
	}))
	t.Cleanup(upstream.Close)

	config := map[string]any{
		"port": 0, "hostname": "127.0.0.1", "defaultProvider": "mixed-wire",
		"providers": map[string]any{"mixed-wire": map[string]any{
			"adapter": "openai-chat", "baseUrl": upstream.URL + "/v1", "allowPrivateNetwork": true,
			"apiKey": "synthetic-wire-key", "authMode": "key", "defaultModel": "chat-model",
			"models":        []string{"chat-model", "responses-model"},
			"modelAdapters": map[string]string{"responses-model": "openai-responses"},
		}},
	}
	tsProxy := startTypeScriptProxy(t, config)
	goProxy := startProxyWithConfig(t, config)

	for _, scenario := range []struct {
		name       string
		model      string
		wantTSPath string
		wantGoPath string
	}{
		{name: "provider-default-chat", model: "chat-model", wantTSPath: "/v1/chat/completions", wantGoPath: "/v1/chat/completions"},
		{name: "model-responses-override", model: "responses-model", wantTSPath: "/v1/responses", wantGoPath: "/v1/responses"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			body := map[string]any{"model": "mixed-wire/" + scenario.model, "input": "wire route", "stream": false}
			_ = captureJSON(t, goProxy.baseURL, "/v1/responses", body)
			goRequest := receiveWireRouteRequest(t, requests, "Go")
			_ = captureJSON(t, tsProxy.baseURL, "/v1/responses", body)
			tsRequest := receiveWireRouteRequest(t, requests, "TypeScript")
			if goRequest.path != scenario.wantGoPath || goRequest.model != scenario.model {
				t.Fatalf("Go wire route = path %q model %q; want path %q model %q", goRequest.path, goRequest.model, scenario.wantGoPath, scenario.model)
			}
			if tsRequest.path != scenario.wantTSPath || tsRequest.model != scenario.model {
				t.Fatalf("TypeScript wire route = path %q model %q; want path %q model %q", tsRequest.path, tsRequest.model, scenario.wantTSPath, scenario.model)
			}
		})
	}
}

func TestTypeScriptAndGoEmptyResponsesPassthroughError(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v1/responses" {
			t.Errorf("passthrough path = %q; want /v1/responses", request.URL.Path)
		}
		writer.Header().Set("Retry-After", "0")
		writer.WriteHeader(http.StatusServiceUnavailable)
	}))
	t.Cleanup(upstream.Close)
	config := map[string]any{
		"port": 0, "hostname": "127.0.0.1", "defaultProvider": "responses-wire",
		"providers": map[string]any{"responses-wire": map[string]any{
			"adapter": "openai-responses", "baseUrl": upstream.URL + "/v1", "allowPrivateNetwork": true,
			"apiKey": "synthetic-responses-key", "authMode": "key", "defaultModel": "empty-503", "models": []string{"empty-503"},
		}},
	}
	tsProxy := startTypeScriptProxy(t, config)
	goProxy := startProxyWithConfig(t, config)
	body := map[string]any{"model": "responses-wire/empty-503", "input": "empty upstream error", "stream": false}
	goResult := captureJSON(t, goProxy.baseURL, "/v1/responses", body)
	tsResult := captureJSON(t, tsProxy.baseURL, "/v1/responses", body)
	compareRuntimeBytes(t, "provider-wire/empty-503-passthrough", goResult, tsResult, true)
}

func receiveWireRouteRequest(t *testing.T, requests <-chan wireRouteRequest, runtime string) wireRouteRequest {
	t.Helper()
	select {
	case request := <-requests:
		return request
	case <-time.After(2 * time.Second):
		t.Fatalf("%s runtime did not reach the wire-route upstream", runtime)
		return wireRouteRequest{}
	}
}
