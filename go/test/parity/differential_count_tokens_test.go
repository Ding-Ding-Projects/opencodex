package parity_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"reflect"
	"testing"
)

func TestTypeScriptAndGoMessagesCountTokens(t *testing.T) {
	config := differentialConfig("https://count-tokens.invalid", []string{"probe"})
	tsProxy := startTypeScriptProxy(t, config)
	goProxy := startProxyWithConfig(t, config)
	tests := []struct {
		name string
		body map[string]any
	}{
		{
			name: "system-messages-tools",
			body: map[string]any{
				"model": "differential/probe", "system": "Keep answers concise.",
				"messages": []any{map[string]any{"role": "user", "content": "count this request"}},
				"tools":    []any{map[string]any{"name": "lookup", "description": "Look up one item", "input_schema": map[string]any{"type": "object"}}},
			},
		},
		{
			name: "cjk-and-one-million-marker",
			body: map[string]any{
				"model":    "differential/probe[1m]",
				"messages": []any{map[string]any{"role": "user", "content": "한국어 메시지와 日本語 문장을 정확히 계산합니다 🚀"}},
			},
		},
		{name: "missing-model", body: map[string]any{"messages": []any{}}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			goResult := captureJSON(t, goProxy.baseURL, "/v1/messages/count_tokens", test.body)
			tsResult := captureJSON(t, tsProxy.baseURL, "/v1/messages/count_tokens", test.body)
			if test.name == "missing-model" {
				compareRuntimeBytes(t, "messages/count-tokens/"+test.name, goResult, tsResult, true)
				return
			}
			assertCountTokensSemanticParity(t, test.name, goResult, tsResult)
		})
	}
}

func assertCountTokensSemanticParity(t *testing.T, name string, goResult, tsResult runtimeResponse) {
	t.Helper()
	if goResult.err != nil || tsResult.err != nil || goResult.status != http.StatusOK || tsResult.status != http.StatusOK {
		t.Fatalf("count_tokens %s transport differs: Go=%+v TypeScript=%+v", name, goResult, tsResult)
	}
	if goType, tsType := goResult.header.Get("Content-Type"), tsResult.header.Get("Content-Type"); goType != tsType {
		t.Fatalf("count_tokens %s content type differs: Go=%q TypeScript=%q", name, goType, tsType)
	}
	var goValue, tsValue map[string]any
	if err := json.Unmarshal(goResult.body, &goValue); err != nil {
		t.Fatalf("decode Go count_tokens %s: %v", name, err)
	}
	if err := json.Unmarshal(tsResult.body, &tsValue); err != nil {
		t.Fatalf("decode TypeScript count_tokens %s: %v", name, err)
	}
	if !reflect.DeepEqual(goValue, tsValue) {
		t.Fatalf("count_tokens %s value differs: Go=%#v TypeScript=%#v", name, goValue, tsValue)
	}
	if tokens, _ := goValue["input_tokens"].(float64); tokens < 1 {
		t.Fatalf("count_tokens %s returned %v", name, goValue["input_tokens"])
	}
	if !bytes.Equal(goResult.body, tsResult.body) {
		expectedGo := append(append([]byte(nil), tsResult.body...), '\n')
		if !bytes.Equal(goResult.body, expectedGo) {
			t.Fatalf("count_tokens %s has unexpected raw-byte difference: Go=%q TypeScript=%q", name, goResult.body, tsResult.body)
		}
		t.Logf("SEMANTIC-ONLY DIFFERENTIAL [messages/count-tokens/%s]: Go adds one trailing newline", name)
	}
}
