package parity_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync"
	"testing"
)

type continuationUpstream struct {
	server   *httptest.Server
	mu       sync.Mutex
	requests []map[string]any
}

func newContinuationUpstream(t *testing.T) *continuationUpstream {
	t.Helper()
	upstream := &continuationUpstream{}
	upstream.server = httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Errorf("decode continuation upstream request: %v", err)
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		upstream.mu.Lock()
		upstream.requests = append(upstream.requests, body)
		upstream.mu.Unlock()
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(map[string]any{
			"id": "chatcmpl-continuation", "object": "chat.completion", "model": "continuation",
			"choices": []any{map[string]any{"index": 0, "message": map[string]any{"role": "assistant", "content": "remembered answer"}, "finish_reason": "stop"}},
			"usage":   map[string]any{"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5},
		})
	}))
	t.Cleanup(upstream.server.Close)
	return upstream
}

func (upstream *continuationUpstream) snapshot(t *testing.T) []map[string]any {
	t.Helper()
	upstream.mu.Lock()
	defer upstream.mu.Unlock()
	if len(upstream.requests) != 2 {
		t.Fatalf("continuation upstream requests=%d, want 2", len(upstream.requests))
	}
	return upstream.requests
}

func TestTypeScriptAndGoPreviousResponseContinuation(t *testing.T) {
	goUpstream := newContinuationUpstream(t)
	tsUpstream := newContinuationUpstream(t)
	goProxy := startProxyWithConfig(t, differentialConfig(goUpstream.server.URL, []string{"continuation"}))
	tsProxy := startTypeScriptProxy(t, differentialConfig(tsUpstream.server.URL, []string{"continuation"}))

	firstBody := map[string]any{"model": "differential/continuation", "input": "first turn", "stream": false}
	goFirst := captureJSON(t, goProxy.baseURL, "/v1/responses", firstBody)
	tsFirst := captureJSON(t, tsProxy.baseURL, "/v1/responses", firstBody)
	assertContinuationSemanticParity(t, "first", goFirst, tsFirst)

	goID := responseID(t, goFirst.body)
	tsID := responseID(t, tsFirst.body)
	goSecond := captureJSON(t, goProxy.baseURL, "/v1/responses", map[string]any{
		"model": "differential/continuation", "input": "second turn", "stream": false, "previous_response_id": goID,
	})
	tsSecond := captureJSON(t, tsProxy.baseURL, "/v1/responses", map[string]any{
		"model": "differential/continuation", "input": "second turn", "stream": false, "previous_response_id": tsID,
	})
	assertContinuationSemanticParity(t, "second", goSecond, tsSecond)

	goRequests := goUpstream.snapshot(t)
	tsRequests := tsUpstream.snapshot(t)
	if !reflect.DeepEqual(goRequests, tsRequests) {
		t.Fatalf("expanded continuation requests differ\nGo=%#v\nTypeScript=%#v", goRequests, tsRequests)
	}
	assertExpandedContinuation(t, goRequests[1])
	assertResponseStateParity(t, goProxy.baseURL, tsProxy.baseURL)
}

func assertContinuationSemanticParity(t *testing.T, stage string, goResult, tsResult runtimeResponse) {
	t.Helper()
	if goResult.err != nil || tsResult.err != nil || goResult.status != tsResult.status || goResult.status != http.StatusOK {
		t.Fatalf("continuation %s transport differs: Go=%+v TypeScript=%+v", stage, goResult, tsResult)
	}
	if goType, tsType := goResult.header.Get("Content-Type"), tsResult.header.Get("Content-Type"); goType != tsType {
		t.Fatalf("continuation %s content type differs: Go=%q TypeScript=%q", stage, goType, tsType)
	}
	var goValue, tsValue any
	if err := json.Unmarshal(normalizeDifferentialBytes(goResult.body), &goValue); err != nil {
		t.Fatalf("decode Go continuation %s: %v", stage, err)
	}
	if err := json.Unmarshal(normalizeDifferentialBytes(tsResult.body), &tsValue); err != nil {
		t.Fatalf("decode TypeScript continuation %s: %v", stage, err)
	}
	if !reflect.DeepEqual(goValue, tsValue) {
		t.Fatalf("continuation %s response differs\nGo=%#v\nTypeScript=%#v", stage, goValue, tsValue)
	}
}

func responseID(t *testing.T, body []byte) string {
	t.Helper()
	var response map[string]any
	if err := json.Unmarshal(body, &response); err != nil {
		t.Fatalf("decode response id: %v", err)
	}
	id, _ := response["id"].(string)
	if id == "" {
		t.Fatalf("response id missing: %s", body)
	}
	return id
}

func assertExpandedContinuation(t *testing.T, request map[string]any) {
	t.Helper()
	messages, _ := request["messages"].([]any)
	if len(messages) != 3 {
		t.Fatalf("expanded continuation messages=%#v", request["messages"])
	}
	wantRoles := []string{"user", "assistant", "user"}
	wantText := []string{"first turn", "remembered answer", "second turn"}
	for index := range messages {
		message, _ := messages[index].(map[string]any)
		if message["role"] != wantRoles[index] || message["content"] != wantText[index] {
			t.Fatalf("expanded continuation message %d=%#v", index, message)
		}
	}
}

func assertResponseStateParity(t *testing.T, goBaseURL, tsBaseURL string) {
	t.Helper()
	goState := responseState(t, captureManagementRequest(t, goBaseURL, http.MethodGet, "/api/system/memory", "", nil).body)
	tsState := responseState(t, captureManagementRequest(t, tsBaseURL, http.MethodGet, "/api/system/memory", "", nil).body)
	delete(goState, "oldestAgeMs")
	delete(tsState, "oldestAgeMs")
	if !reflect.DeepEqual(goState, tsState) {
		t.Fatalf("response-state metrics differ: Go=%#v TypeScript=%#v", goState, tsState)
	}
	if count, _ := goState["count"].(float64); count != 2 {
		t.Fatalf("response-state count=%v, want 2", goState["count"])
	}
}

func responseState(t *testing.T, body []byte) map[string]any {
	t.Helper()
	var memory map[string]any
	if err := json.Unmarshal(body, &memory); err != nil {
		t.Fatalf("decode system memory: %v", err)
	}
	state, _ := memory["responseState"].(map[string]any)
	if state == nil {
		t.Fatalf("responseState missing: %s", body)
	}
	return state
}
