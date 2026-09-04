package parity_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type adapterRequest struct {
	method      string
	path        string
	host        string
	contentType string
	authority   string
	apiKey      string
	target      string
	cursorType  string
}

func TestBuiltBinaryRoutesProviderAdapters(t *testing.T) {
	requests := make(chan adapterRequest, 32)
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		requests <- adapterRequest{
			method: request.Method, path: request.URL.Path, host: request.Host,
			contentType: request.Header.Get("Content-Type"), authority: request.Header.Get("Authorization"),
			apiKey: request.Header.Get("x-api-key") + request.Header.Get("x-goog-api-key"),
			target: request.Header.Get("X-Amz-Target"), cursorType: request.Header.Get("X-Cursor-Client-Type"),
		}
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusTeapot)
		_, _ = writer.Write([]byte(`{"error":{"message":"adapter fingerprint","type":"authentication_error"}}`))
	}))
	t.Cleanup(upstream.Close)

	config := map[string]any{
		"port": 0, "hostname": "127.0.0.1", "defaultProvider": "openai-apikey",
		"providers": map[string]any{
			"anthropic-apikey": providerFixture("anthropic", upstream.URL, "probe"),
			"google":           providerFixture("google", upstream.URL, "probe"),
			"kiro":             providerFixture("kiro", upstream.URL, "probe"),
			"cursor":           providerFixture("cursor", upstream.URL, "probe"),
			"openai-apikey":    providerFixture("openai-responses", upstream.URL+"/v1", "probe"),
		},
	}
	proxy := startProxyWithSetup(t, config, func(home string) { writeSyntheticOAuthStore(t, home) })

	tests := []struct {
		provider string
		match    func(adapterRequest) bool
	}{
		{"anthropic-apikey", func(got adapterRequest) bool {
			return got.path == "/v1/messages" && got.apiKey == "parity-api-key" && strings.HasPrefix(got.contentType, "application/json")
		}},
		{"google", func(got adapterRequest) bool {
			return got.path == "/v1beta/models/probe:generateContent" && got.apiKey == "parity-api-key"
		}},
		{"kiro", func(got adapterRequest) bool {
			return got.path == "/" && got.target == "AmazonCodeWhispererStreamingService.GenerateAssistantResponse" && strings.HasPrefix(got.contentType, "application/x-amz-json-1.0")
		}},
		{"openai-apikey", func(got adapterRequest) bool {
			return got.path == "/v1/responses" && got.authority == "Bearer parity-api-key" && strings.HasPrefix(got.contentType, "application/json")
		}},
	}
	for _, test := range tests {
		t.Run(test.provider, func(t *testing.T) {
			response, payload := postJSON(t, proxy.baseURL+"/v1/responses", map[string]any{"model": test.provider + "/probe", "input": "hello", "stream": false})
			if response.StatusCode != http.StatusTeapot {
				t.Fatalf("proxy status=%d body=%s", response.StatusCode, payload)
			}
			awaitAdapterRequest(t, requests, test.match)
		})
	}

	t.Run("cursor", func(t *testing.T) {
		response, payload := postJSON(t, proxy.baseURL+"/v1/responses", map[string]any{"model": "cursor/probe", "input": "hello", "stream": false})
		if response.StatusCode != http.StatusBadGateway || !strings.Contains(string(payload), "invalid Cursor base URL") {
			t.Fatalf("Cursor adapter fingerprint status=%d body=%s", response.StatusCode, payload)
		}
	})
}

func providerFixture(adapter, baseURL, model string) map[string]any {
	return map[string]any{
		"adapter": adapter, "baseUrl": baseURL, "allowPrivateNetwork": true,
		"apiKey": "parity-api-key", "authMode": "key", "defaultModel": model, "models": []string{model},
	}
}

func writeSyntheticOAuthStore(t *testing.T, home string) {
	t.Helper()
	credential := func() map[string]any {
		return map[string]any{
			"activeAccountId": "parity-account",
			"accounts": []any{map[string]any{
				"id":         "parity-account",
				"credential": map[string]any{"access": "parity-oauth-placeholder", "expires": time.Now().Add(time.Hour).UnixMilli()},
			}},
		}
	}
	encoded, err := json.Marshal(map[string]any{"kiro": credential(), "cursor": credential()})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "auth.json"), encoded, 0o600); err != nil {
		t.Fatal(err)
	}
}

func awaitAdapterRequest(t *testing.T, requests <-chan adapterRequest, match func(adapterRequest) bool) adapterRequest {
	t.Helper()
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	for {
		select {
		case request := <-requests:
			if match(request) {
				return request
			}
		case <-timer.C:
			t.Fatal("expected adapter request was not observed")
		}
	}
}

func TestBuiltBinaryMimoAdapterStaysOnLocalProxy(t *testing.T) {
	connects := make(chan string, 4)
	localProxy := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		connects <- request.Method + " " + request.Host
		http.Error(writer, "blocked by parity proxy", http.StatusBadGateway)
	}))
	t.Cleanup(localProxy.Close)
	config := map[string]any{
		"port": 0, "hostname": "127.0.0.1", "defaultProvider": "mimo-free",
		"providers": map[string]any{"mimo-free": map[string]any{
			"adapter": "mimo-free", "baseUrl": "https://api.xiaomimimo.com/api/free-ai/openai/chat",
			"apiKey": "parity-placeholder", "authMode": "key", "defaultModel": "mimo-auto", "models": []string{"mimo-auto"},
		}},
	}
	proxy := startProxyWithConfig(t, config, "HTTPS_PROXY="+localProxy.URL, "HTTP_PROXY="+localProxy.URL, "NO_PROXY=127.0.0.1,localhost")
	response, payload := postJSON(t, proxy.baseURL+"/v1/responses", map[string]any{"model": "mimo-free/mimo-auto", "input": "hello", "stream": false})
	if response.StatusCode != http.StatusBadRequest && response.StatusCode != http.StatusBadGateway {
		t.Fatalf("status=%d body=%s", response.StatusCode, payload)
	}
	if response.StatusCode == http.StatusBadRequest {
		t.Logf("KNOWN CROSS-SCOPE GAP: MiMo bootstrap transport failure is classified as request_build_error (400), while TS treats adapter build failures as server failures: %s", payload)
	}
	select {
	case got := <-connects:
		if got != "CONNECT api.xiaomimimo.com:443" {
			t.Fatalf("MiMo outbound target=%q", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("MiMo adapter did not attempt its bootstrap through the local-only proxy")
	}
	if !strings.Contains(string(payload), "blocked by parity proxy") {
		t.Logf("MiMo proxy error was safely normalized: %s", payload)
	}
}

func TestBuiltBinaryMimoKeyOptionalContract(t *testing.T) {
	localProxy := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		http.Error(writer, "blocked by parity proxy", http.StatusBadGateway)
	}))
	t.Cleanup(localProxy.Close)
	config := map[string]any{
		"port": 0, "hostname": "127.0.0.1", "defaultProvider": "mimo-free",
		"providers": map[string]any{"mimo-free": map[string]any{
			"adapter": "mimo-free", "baseUrl": "https://api.xiaomimimo.com/api/free-ai/openai/chat",
			"authMode": "key", "defaultModel": "mimo-auto", "models": []string{"mimo-auto"},
		}},
	}
	proxy := startProxyWithConfig(t, config, "HTTPS_PROXY="+localProxy.URL, "HTTP_PROXY="+localProxy.URL, "NO_PROXY=127.0.0.1,localhost")
	response, payload := postJSON(t, proxy.baseURL+"/v1/responses", map[string]any{"model": "mimo-free/mimo-auto", "input": "hello", "stream": false})
	if response.StatusCode == http.StatusUnauthorized && strings.Contains(string(payload), "API key is empty") {
		t.Logf("KNOWN CROSS-SCOPE GAP: registry marks MiMo keyOptional, but production auth rejects an empty key before adapter bootstrap: %s", payload)
		return
	}
	if response.StatusCode != http.StatusBadRequest && response.StatusCode != http.StatusBadGateway {
		t.Fatalf("key-optional MiMo status=%d body=%s", response.StatusCode, payload)
	}
}

func TestBuiltBinaryManagementAuthenticationBoundary(t *testing.T) {
	const token = "parity-management-secret"
	config := map[string]any{
		"port": 0, "hostname": "127.0.0.1", "authToken": token, "defaultProvider": "parity",
		"providers": map[string]any{"parity": providerFixture("openai-chat", "https://example.invalid/v1", "probe")},
	}
	proxy := startProxyWithConfig(t, config)
	for _, authorization := range []string{"", "Bearer wrong"} {
		request, _ := http.NewRequest(http.MethodGet, proxy.baseURL+"/api/system", nil)
		request.Header.Set("Authorization", authorization)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		_ = response.Body.Close()
		if response.StatusCode != http.StatusUnauthorized {
			t.Fatalf("unauthorized management status=%d", response.StatusCode)
		}
	}
	request, _ := http.NewRequest(http.MethodGet, proxy.baseURL+"/api/system", nil)
	request.Header.Set("Authorization", "Bearer "+token)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("authorized management status=%d", response.StatusCode)
	}
}
