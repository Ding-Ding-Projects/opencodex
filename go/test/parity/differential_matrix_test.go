package parity_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type differentialUpstream struct {
	server    *httptest.Server
	started   chan struct{}
	cancelled chan struct{}
}

func newDifferentialUpstream(t *testing.T) *differentialUpstream {
	t.Helper()
	upstream := &differentialUpstream{started: make(chan struct{}, 4), cancelled: make(chan struct{}, 4)}
	upstream.server = httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		model := decodeRequestModel(request)
		if strings.HasPrefix(model, "status-") {
			var status int
			_, _ = fmt.Sscanf(model, "status-%d", &status)
			writer.Header().Set("Content-Type", "application/json")
			if status == http.StatusTooManyRequests {
				writer.Header().Set("Retry-After", "9")
			}
			writer.WriteHeader(status)
			_ = json.NewEncoder(writer).Encode(map[string]any{"error": map[string]any{
				"message": fmt.Sprintf("synthetic upstream status %d", status), "type": errorTypeForStatus(status), "code": fmt.Sprintf("synthetic_%d", status),
			}})
			return
		}
		writer.Header().Set("Content-Type", "text/event-stream")
		writer.WriteHeader(http.StatusOK)
		flusher, _ := writer.(http.Flusher)
		writeFrame := func(frame string) {
			_, _ = io.WriteString(writer, "data: "+frame+"\n\n")
			if flusher != nil {
				flusher.Flush()
			}
		}
		writeFrame(`{"id":"chatcmpl-diff","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}`)
		if model == "cancel" {
			upstream.started <- struct{}{}
			<-request.Context().Done()
			upstream.cancelled <- struct{}{}
			return
		}
		writeFrame(`{"id":"chatcmpl-diff","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"differential hello"},"finish_reason":null}]}`)
		if model == "mid-error" {
			writeFrame(`{"error":{"message":"synthetic mid-stream failure","type":"server_error","code":"upstream_error"}}`)
			return
		}
		writeFrame(`{"id":"chatcmpl-diff","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}`)
		writeFrame("[DONE]")
	}))
	t.Cleanup(upstream.server.Close)
	return upstream
}

func errorTypeForStatus(status int) string {
	switch status {
	case http.StatusBadRequest, http.StatusNotFound:
		return "invalid_request_error"
	case http.StatusUnauthorized, http.StatusForbidden:
		return "authentication_error"
	case http.StatusTooManyRequests:
		return "rate_limit_error"
	default:
		return "server_error"
	}
}

func differentialConfig(upstreamURL string, models []string) map[string]any {
	return map[string]any{
		"port": 0, "hostname": "127.0.0.1", "defaultProvider": "differential",
		"providers": map[string]any{"differential": map[string]any{
			"adapter": "openai-chat", "baseUrl": upstreamURL + "/v1", "allowPrivateNetwork": true,
			"apiKey": "synthetic-differential-key", "authMode": "key", "defaultModel": models[0], "models": models,
		}},
	}
}

type runtimeResponse struct {
	status int
	header http.Header
	body   []byte
	err    error
}

func captureJSON(t *testing.T, baseURL, path string, body any) runtimeResponse {
	t.Helper()
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(http.MethodPost, baseURL+path, bytes.NewReader(encoded))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return runtimeResponse{err: err}
	}
	defer response.Body.Close()
	payload, readErr := io.ReadAll(response.Body)
	return runtimeResponse{status: response.StatusCode, header: response.Header.Clone(), body: payload, err: readErr}
}

func captureGET(t *testing.T, baseURL, path string) runtimeResponse {
	t.Helper()
	response, err := http.Get(baseURL + path)
	if err != nil {
		return runtimeResponse{err: err}
	}
	defer response.Body.Close()
	payload, readErr := io.ReadAll(response.Body)
	return runtimeResponse{status: response.StatusCode, header: response.Header.Clone(), body: payload, err: readErr}
}

func compareRuntimeBytes(t *testing.T, scenario string, goResult, tsResult runtimeResponse, revealBody bool) {
	t.Helper()
	if goResult.err != nil || tsResult.err != nil {
		t.Fatalf("%s runtime read error: Go=%v TS=%v", scenario, goResult.err, tsResult.err)
	}
	if goResult.status != tsResult.status {
		t.Logf("DIFFERENTIAL GAP [%s]: status Go=%d TS=%d", scenario, goResult.status, tsResult.status)
	}
	for _, header := range []string{"Content-Type", "Retry-After", "Cache-Control"} {
		if goResult.header.Get(header) != tsResult.header.Get(header) {
			t.Logf("DIFFERENTIAL GAP [%s]: %s Go=%q TS=%q", scenario, header, goResult.header.Get(header), tsResult.header.Get(header))
		}
	}
	if bytes.Equal(goResult.body, tsResult.body) {
		return
	}
	t.Logf("DIFFERENTIAL GAP [%s]: bytes offset=%d Go(len=%d sha=%s) TS(len=%d sha=%s)", scenario,
		firstDifferentByte(goResult.body, tsResult.body), len(goResult.body), payloadDigest(goResult.body), len(tsResult.body), payloadDigest(tsResult.body))
	if revealBody {
		t.Logf("DIFFERENTIAL BODY [%s]: Go=%s TS=%s", scenario, goResult.body, tsResult.body)
	}
}

func TestTypeScriptAndGoSSEByteMatrix(t *testing.T) {
	upstream := newDifferentialUpstream(t)
	models := []string{"success", "mid-error", "cancel"}
	config := differentialConfig(upstream.server.URL, models)
	tsProxy := startTypeScriptProxy(t, config)
	goProxy := startProxyWithConfig(t, config)
	cases := []struct {
		name, path, model string
		body              func(string) map[string]any
	}{
		{"responses/complete", "/v1/responses", "success", func(model string) map[string]any {
			return map[string]any{"model": "differential/" + model, "input": "hello", "stream": true}
		}},
		{"responses/mid-error", "/v1/responses", "mid-error", func(model string) map[string]any {
			return map[string]any{"model": "differential/" + model, "input": "hello", "stream": true}
		}},
		{"messages/complete", "/v1/messages", "success", func(model string) map[string]any {
			return map[string]any{"model": "differential/" + model, "max_tokens": 32, "stream": true, "messages": []any{map[string]any{"role": "user", "content": "hello"}}}
		}},
		{"messages/mid-error", "/v1/messages", "mid-error", func(model string) map[string]any {
			return map[string]any{"model": "differential/" + model, "max_tokens": 32, "stream": true, "messages": []any{map[string]any{"role": "user", "content": "hello"}}}
		}},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			body := test.body(test.model)
			goResult := captureJSON(t, goProxy.baseURL, test.path, body)
			tsResult := captureJSON(t, tsProxy.baseURL, test.path, body)
			compareRuntimeBytes(t, test.name, goResult, tsResult, true)
		})
	}

	t.Run("responses/cancel", func(t *testing.T) {
		body := map[string]any{"model": "differential/cancel", "input": "hello", "stream": true}
		goResult := captureCancelledStream(t, goProxy.baseURL+"/v1/responses", body, upstream)
		tsResult := captureCancelledStream(t, tsProxy.baseURL+"/v1/responses", body, upstream)
		compareRuntimeBytes(t, "responses/cancel-prefix", goResult, tsResult, false)
	})
	t.Run("messages/cancel", func(t *testing.T) {
		body := map[string]any{"model": "differential/cancel", "max_tokens": 32, "stream": true, "messages": []any{map[string]any{"role": "user", "content": "hello"}}}
		goResult := captureCancelledStream(t, goProxy.baseURL+"/v1/messages", body, upstream)
		tsResult := captureCancelledStream(t, tsProxy.baseURL+"/v1/messages", body, upstream)
		compareRuntimeBytes(t, "messages/cancel-prefix", goResult, tsResult, false)
	})
}

func captureCancelledStream(t *testing.T, url string, body any, upstream *differentialUpstream) runtimeResponse {
	t.Helper()
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(encoded))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	result := make(chan runtimeResponse, 1)
	go func() {
		response, requestErr := http.DefaultClient.Do(request)
		if requestErr != nil {
			result <- runtimeResponse{err: requestErr}
			return
		}
		payload, readErr := io.ReadAll(response.Body)
		_ = response.Body.Close()
		result <- runtimeResponse{status: response.StatusCode, header: response.Header.Clone(), body: payload, err: readErr}
	}()
	select {
	case <-upstream.started:
		cancel()
	case <-time.After(5 * time.Second):
		cancel()
		t.Fatal("cancellation fixture did not reach upstream")
	}
	select {
	case <-upstream.cancelled:
	case <-time.After(5 * time.Second):
		t.Fatal("runtime cancellation did not propagate upstream")
	}
	select {
	case captured := <-result:
		if captured.err != nil && !strings.Contains(strings.ToLower(captured.err.Error()), "context canceled") {
			t.Fatalf("unexpected cancelled request error: %v", captured.err)
		}
		captured.err = nil
		return captured
	case <-time.After(5 * time.Second):
		t.Fatal("cancelled runtime request did not terminate")
	}
	return runtimeResponse{}
}

func TestTypeScriptAndGoErrorStatusMatrix(t *testing.T) {
	upstream := newDifferentialUpstream(t)
	statuses := []int{400, 401, 403, 404, 429, 500, 502, 503}
	models := make([]string, 0, len(statuses))
	for _, status := range statuses {
		models = append(models, fmt.Sprintf("status-%d", status))
	}
	config := differentialConfig(upstream.server.URL, models)
	tsProxy := startTypeScriptProxy(t, config)
	goProxy := startProxyWithConfig(t, config)
	endpoints := []struct {
		name, path string
		body       func(string) map[string]any
	}{
		{"responses", "/v1/responses", func(model string) map[string]any {
			return map[string]any{"model": model, "input": "hello", "stream": false}
		}},
		{"messages", "/v1/messages", func(model string) map[string]any {
			return map[string]any{"model": model, "max_tokens": 32, "stream": false, "messages": []any{map[string]any{"role": "user", "content": "hello"}}}
		}},
	}
	for _, endpoint := range endpoints {
		for _, status := range statuses {
			scenario := fmt.Sprintf("%s/status-%d", endpoint.name, status)
			t.Run(scenario, func(t *testing.T) {
				model := fmt.Sprintf("differential/status-%d", status)
				goResult := captureJSON(t, goProxy.baseURL, endpoint.path, endpoint.body(model))
				tsResult := captureJSON(t, tsProxy.baseURL, endpoint.path, endpoint.body(model))
				compareRuntimeBytes(t, scenario, goResult, tsResult, true)
			})
		}
	}
}

func TestTypeScriptAndGoManagementResponseMatrix(t *testing.T) {
	upstream := newDifferentialUpstream(t)
	config := differentialConfig(upstream.server.URL, []string{"success"})
	tsProxy := startTypeScriptProxy(t, config)
	goProxy := startProxyWithConfig(t, config)
	for _, path := range []string{"/api/system", "/api/system/runtime", "/api/config", "/api/providers"} {
		t.Run(strings.TrimPrefix(path, "/api/"), func(t *testing.T) {
			goResult := captureGET(t, goProxy.baseURL, path)
			tsResult := captureGET(t, tsProxy.baseURL, path)
			compareRuntimeBytes(t, "management"+path, goResult, tsResult, false)
		})
	}
}
