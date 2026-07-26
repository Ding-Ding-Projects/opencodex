package parity_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
)

const managementParityToken = "synthetic-management-token"

var managementAddedAtPattern = regexp.MustCompile(`"addedAt":\d+`)

func TestTypeScriptAndGoManagementMutationSequence(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method == http.MethodGet && strings.HasSuffix(request.URL.Path, "/models") {
			writer.Header().Set("Content-Type", "application/json")
			_, _ = writer.Write([]byte(`{"data":[{"id":"base-model"}]}`))
			return
		}
		writeChatSuccess(writer, "base-model", "management parity")
	}))
	t.Cleanup(upstream.Close)
	config := differentialConfig(upstream.URL, []string{"base-model"})
	config["hostname"] = "0.0.0.0"
	config["authToken"] = managementParityToken
	config["apiKeys"] = []any{map[string]any{
		"id": "parity-management", "name": "Parity management", "key": managementParityToken, "createdAt": "2026-07-26T00:00:00.000Z",
	}}
	authEnvironment := "OPENCODEX_API_AUTH_TOKEN=" + managementParityToken
	tsProxy := startTypeScriptProxy(t, config, authEnvironment)
	goProxy := startProxyWithConfig(t, config, authEnvironment)

	providerBody := map[string]any{"name": "gui-extra", "provider": map[string]any{
		"adapter": "openai-chat", "baseUrl": upstream.URL + "/v1", "allowPrivateNetwork": true,
		"apiKey": "synthetic-provider-secret", "authMode": "key", "defaultModel": "base-model", "models": []string{"base-model"},
	}}
	compareRuntimeBytes(t, "management-mutation/unauthorized-provider-create",
		captureManagementRequest(t, goProxy.baseURL, http.MethodPost, "/api/providers", "", providerBody),
		captureManagementRequest(t, tsProxy.baseURL, http.MethodPost, "/api/providers", "", providerBody), true)

	compareRuntimeBytes(t, "management-mutation/provider-create",
		captureManagementRequest(t, goProxy.baseURL, http.MethodPost, "/api/providers", managementParityToken, providerBody),
		captureManagementRequest(t, tsProxy.baseURL, http.MethodPost, "/api/providers", managementParityToken, providerBody), true)
	compareRuntimeBytes(t, "management-mutation/provider-patch",
		captureManagementRequest(t, goProxy.baseURL, http.MethodPatch, "/api/providers?name=gui-extra", managementParityToken, map[string]any{"disabled": true}),
		captureManagementRequest(t, tsProxy.baseURL, http.MethodPatch, "/api/providers?name=gui-extra", managementParityToken, map[string]any{"disabled": true}), true)

	compareRuntimeBytes(t, "management-mutation/selected-models",
		captureManagementRequest(t, goProxy.baseURL, http.MethodPut, "/api/selected-models", managementParityToken, map[string]any{"provider": "differential", "models": []string{"base-model", "base-model"}}),
		captureManagementRequest(t, tsProxy.baseURL, http.MethodPut, "/api/selected-models", managementParityToken, map[string]any{"provider": "differential", "models": []string{"base-model", "base-model"}}), true)
	for _, enabled := range []bool{false, true} {
		scenario := "management-mutation/model-visibility-disable"
		if enabled {
			scenario = "management-mutation/model-visibility-enable"
		}
		body := map[string]any{"scope": "models", "provider": "differential", "enabled": enabled, "targets": []any{map[string]any{"id": "base-model"}}}
		compareRuntimeBytes(t, scenario,
			captureManagementRequest(t, goProxy.baseURL, http.MethodPut, "/api/model-visibility", managementParityToken, body),
			captureManagementRequest(t, tsProxy.baseURL, http.MethodPut, "/api/model-visibility", managementParityToken, body), true)
	}

	goCustom := captureManagementRequest(t, goProxy.baseURL, http.MethodPost, "/api/custom-models", managementParityToken,
		map[string]any{"provider": "differential", "modelId": "gui-model", "displayName": "GUI Model", "contextWindow": 8192, "inputModalities": []string{"text", "image"}})
	tsCustom := captureManagementRequest(t, tsProxy.baseURL, http.MethodPost, "/api/custom-models", managementParityToken,
		map[string]any{"provider": "differential", "modelId": "gui-model", "displayName": "GUI Model", "contextWindow": 8192, "inputModalities": []string{"text", "image"}})
	goCustomID, tsCustomID := responseStringField(t, goCustom, "id"), responseStringField(t, tsCustom, "id")
	goAddedAt, tsAddedAt := responseStringField(t, goCustom, "addedAt"), responseStringField(t, tsCustom, "addedAt")
	compareRuntimeWithExactIDs(t, "management-mutation/custom-model-create", goCustom, tsCustom, goCustomID+"\x00"+goAddedAt, tsCustomID+"\x00"+tsAddedAt)
	compareRuntimeWithExactIDs(t, "management-mutation/custom-model-update",
		captureManagementRequest(t, goProxy.baseURL, http.MethodPut, "/api/custom-models/"+goCustomID, managementParityToken, map[string]any{"displayName": "GUI Model 2", "contextWindow": 16384}),
		captureManagementRequest(t, tsProxy.baseURL, http.MethodPut, "/api/custom-models/"+tsCustomID, managementParityToken, map[string]any{"displayName": "GUI Model 2", "contextWindow": 16384}),
		goCustomID+"\x00"+goAddedAt, tsCustomID+"\x00"+tsAddedAt)
	compareRuntimeWithExactIDs(t, "management-mutation/custom-model-delete",
		captureManagementRequest(t, goProxy.baseURL, http.MethodDelete, "/api/custom-models/"+goCustomID, managementParityToken, nil),
		captureManagementRequest(t, tsProxy.baseURL, http.MethodDelete, "/api/custom-models/"+tsCustomID, managementParityToken, nil),
		goCustomID, tsCustomID)

	goFirstKey := captureManagementRequest(t, goProxy.baseURL, http.MethodPost, "/api/providers/keys", managementParityToken, map[string]any{"name": "differential", "key": "synthetic-key-one", "label": "first"})
	tsFirstKey := captureManagementRequest(t, tsProxy.baseURL, http.MethodPost, "/api/providers/keys", managementParityToken, map[string]any{"name": "differential", "key": "synthetic-key-one", "label": "first"})
	assertSecretAbsent(t, goFirstKey, "synthetic-key-one")
	assertSecretAbsent(t, tsFirstKey, "synthetic-key-one")
	goFirstID, tsFirstID := responseStringField(t, goFirstKey, "id"), responseStringField(t, tsFirstKey, "id")
	compareRuntimeWithExactIDs(t, "management-mutation/key-add-first", goFirstKey, tsFirstKey, goFirstID, tsFirstID)

	goSecondKey := captureManagementRequest(t, goProxy.baseURL, http.MethodPost, "/api/providers/keys", managementParityToken, map[string]any{"name": "differential", "key": "synthetic-key-two", "label": "second"})
	tsSecondKey := captureManagementRequest(t, tsProxy.baseURL, http.MethodPost, "/api/providers/keys", managementParityToken, map[string]any{"name": "differential", "key": "synthetic-key-two", "label": "second"})
	assertSecretAbsent(t, goSecondKey, "synthetic-key-two")
	assertSecretAbsent(t, tsSecondKey, "synthetic-key-two")
	goSecondID, tsSecondID := responseStringField(t, goSecondKey, "id"), responseStringField(t, tsSecondKey, "id")
	compareRuntimeWithExactIDs(t, "management-mutation/key-add-second", goSecondKey, tsSecondKey, goSecondID, tsSecondID)

	compareRuntimeWithExactIDs(t, "management-mutation/key-switch-active",
		captureManagementRequest(t, goProxy.baseURL, http.MethodPut, "/api/providers/keys/active", managementParityToken, map[string]any{"name": "differential", "id": goFirstID}),
		captureManagementRequest(t, tsProxy.baseURL, http.MethodPut, "/api/providers/keys/active", managementParityToken, map[string]any{"name": "differential", "id": tsFirstID}),
		goFirstID, tsFirstID)
	goKeyList := captureManagementRequest(t, goProxy.baseURL, http.MethodGet, "/api/providers/keys?name=differential", managementParityToken, nil)
	tsKeyList := captureManagementRequest(t, tsProxy.baseURL, http.MethodGet, "/api/providers/keys?name=differential", managementParityToken, nil)
	goKeyList.body = managementAddedAtPattern.ReplaceAll(goKeyList.body, []byte(`"addedAt":0`))
	tsKeyList.body = managementAddedAtPattern.ReplaceAll(tsKeyList.body, []byte(`"addedAt":0`))
	compareRuntimeWithExactIDs(t, "management-mutation/key-list", goKeyList, tsKeyList,
		goFirstID+"\x00"+goSecondID, tsFirstID+"\x00"+tsSecondID)

	compareRuntimeBytes(t, "management-mutation/provider-delete",
		captureManagementRequest(t, goProxy.baseURL, http.MethodDelete, "/api/providers?name=gui-extra", managementParityToken, nil),
		captureManagementRequest(t, tsProxy.baseURL, http.MethodDelete, "/api/providers?name=gui-extra", managementParityToken, nil), true)
}

func TestTypeScriptAndGoManagementControlMutations(t *testing.T) {
	upstream := newDifferentialUpstream(t)
	config := differentialConfig(upstream.server.URL, []string{"success"})
	config["hostname"] = "0.0.0.0"
	config["authToken"] = managementParityToken
	config["apiKeys"] = []any{map[string]any{
		"id": "parity-management", "name": "Parity management", "key": managementParityToken, "createdAt": "2026-07-26T00:00:00.000Z",
	}}
	authEnvironment := "OPENCODEX_API_AUTH_TOKEN=" + managementParityToken
	tsProxy := startTypeScriptProxy(t, config, authEnvironment)
	goProxy := startProxyWithConfig(t, config, authEnvironment)
	compare := func(scenario, method, path string, body any) {
		t.Helper()
		compareRuntimeBytes(t, "management-controls/"+scenario,
			captureManagementRequest(t, goProxy.baseURL, method, path, managementParityToken, body),
			captureManagementRequest(t, tsProxy.baseURL, method, path, managementParityToken, body), true)
	}

	sidecars := map[string]any{
		"webSearch": map[string]any{"model": "search-model", "backend": "anthropic", "reasoning": "high"},
		"vision":    map[string]any{"model": "vision-model", "backend": "openai", "maxDescriptionsPerTurn": 3},
	}
	compare("sidecar-put", http.MethodPut, "/api/sidecar-settings", sidecars)
	compare("sidecar-get", http.MethodGet, "/api/sidecar-settings", nil)
	compare("debug-enable", http.MethodPut, "/api/debug", map[string]any{"debug": true, "usage": true, "injection": true})
	compare("debug-reset", http.MethodPut, "/api/debug", map[string]any{"reset": true})
	compare("auto-switch", http.MethodPut, "/api/codex-auth/auto-switch", map[string]any{"threshold": 77})
	compare("failover", http.MethodPut, "/api/codex-auth/failover", map[string]any{"threshold": 4})
	compare("active-get", http.MethodGet, "/api/codex-auth/active", nil)
	compare("auto-switch-invalid", http.MethodPut, "/api/codex-auth/auto-switch", map[string]any{"threshold": 101})
}

func TestTypeScriptAndGoAPIAccessEndpoints(t *testing.T) {
	upstream := newDifferentialUpstream(t)
	config := differentialConfig(upstream.server.URL, []string{"success"})
	config["hostname"] = "0.0.0.0"
	config["authToken"] = managementParityToken
	config["apiKeys"] = []any{map[string]any{
		"id": "parity-management", "name": "Parity management", "key": managementParityToken, "createdAt": "2026-07-26T00:00:00.000Z",
	}}
	config["claudeCode"] = map[string]any{"enabled": false}
	config["corsAllowOrigins"] = []string{"https://origin.example.test:8443"}
	authEnvironment := "OPENCODEX_API_AUTH_TOKEN=" + managementParityToken
	tsProxy := startTypeScriptProxy(t, config, authEnvironment)
	goProxy := startProxyWithConfig(t, config, authEnvironment)
	compare := func(scenario, host, origin string) {
		t.Helper()
		goResult := captureManagementRequestWithAuthority(t, goProxy.baseURL, "/api/keys", host, origin)
		tsResult := captureManagementRequestWithAuthority(t, tsProxy.baseURL, "/api/keys", host, origin)
		compareRuntimeBytes(t, "api-access/"+scenario, goResult, tsResult, true)
	}
	compare("host-header", "api.example.test:7777", "")
	compare("origin-priority", "fallback.example.test:8888", "https://origin.example.test:8443")
}

func captureManagementRequestWithAuthority(t *testing.T, baseURL, path, host, origin string) runtimeResponse {
	t.Helper()
	request, err := http.NewRequest(http.MethodGet, baseURL+path, nil)
	if err != nil {
		return runtimeResponse{err: err}
	}
	request.Host = host
	if origin != "" {
		request.Header.Set("Origin", origin)
	}
	request.Header.Set("Authorization", "Bearer "+managementParityToken)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return runtimeResponse{err: err}
	}
	defer response.Body.Close()
	payload, readErr := io.ReadAll(response.Body)
	return runtimeResponse{status: response.StatusCode, header: response.Header.Clone(), body: payload, err: readErr}
}

func TestTypeScriptAndGoManagementLogDeletionMutations(t *testing.T) {
	upstream := newDifferentialUpstream(t)
	config := differentialConfig(upstream.server.URL, []string{"success"})
	tsProxy := startTypeScriptProxy(t, config)
	goProxy := startProxyWithConfig(t, config)
	body := map[string]any{"model": "differential/success", "input": "ephemeral deletion fixture", "stream": true}
	if result := captureJSON(t, goProxy.baseURL, "/v1/responses", body); result.status != http.StatusOK || result.err != nil {
		t.Fatalf("Go deletion fixture request failed: status=%d err=%v", result.status, result.err)
	}
	if result := captureJSON(t, tsProxy.baseURL, "/v1/responses", body); result.status != http.StatusOK || result.err != nil {
		t.Fatalf("TS deletion fixture request failed: status=%d err=%v", result.status, result.err)
	}
	compare := func(scenario, method, path string, payload any) {
		t.Helper()
		compareRuntimeBytes(t, "management-deletion/"+scenario,
			captureManagementRequest(t, goProxy.baseURL, method, path, "", payload),
			captureManagementRequest(t, tsProxy.baseURL, method, path, "", payload), true)
	}
	compare("logs-delete", http.MethodDelete, "/api/logs", nil)
	compare("logs-empty", http.MethodGet, "/api/logs?tail=10", nil)
	compare("debug-enable-usage", http.MethodPut, "/api/debug", map[string]any{"usage": true})
	compare("debug-usage-delete", http.MethodDelete, "/api/debug/usage-logs", nil)
	compare("debug-usage-empty", http.MethodGet, "/api/debug/usage-logs", nil)
	compare("usage-delete", http.MethodDelete, "/api/usage", nil)
	compare("usage-empty", http.MethodGet, "/api/usage", nil)
	compare("debug-reset", http.MethodPut, "/api/debug", map[string]any{"reset": true})
}

func captureManagementRequest(t *testing.T, baseURL, method, path, token string, body any) runtimeResponse {
	t.Helper()
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequest(method, baseURL+path, reader)
	if err != nil {
		t.Fatal(err)
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return runtimeResponse{err: err}
	}
	defer response.Body.Close()
	payload, readErr := io.ReadAll(response.Body)
	return runtimeResponse{status: response.StatusCode, header: response.Header.Clone(), body: payload, err: readErr}
}

func responseStringField(t *testing.T, response runtimeResponse, field string) string {
	t.Helper()
	if response.err != nil {
		t.Fatalf("management response failed before %s extraction: %v", field, response.err)
	}
	var value map[string]any
	if err := json.Unmarshal(response.body, &value); err != nil {
		t.Fatalf("decode management response for %s: status=%d", field, response.status)
	}
	text, _ := value[field].(string)
	if text == "" {
		t.Fatalf("management response omitted %s: status=%d", field, response.status)
	}
	return text
}

func compareRuntimeWithExactIDs(t *testing.T, scenario string, goResult, tsResult runtimeResponse, goIDs, tsIDs string) {
	t.Helper()
	for _, id := range strings.Split(goIDs, "\x00") {
		goResult.body = bytes.ReplaceAll(goResult.body, []byte(id), []byte("dynamic_management_id"))
	}
	for _, id := range strings.Split(tsIDs, "\x00") {
		tsResult.body = bytes.ReplaceAll(tsResult.body, []byte(id), []byte("dynamic_management_id"))
	}
	compareRuntimeBytes(t, scenario, goResult, tsResult, true)
}

func assertSecretAbsent(t *testing.T, response runtimeResponse, secret string) {
	t.Helper()
	if bytes.Contains(response.body, []byte(secret)) {
		t.Fatal("management response exposed a submitted provider key")
	}
}
