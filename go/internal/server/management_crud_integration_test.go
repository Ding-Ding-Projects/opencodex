package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	appconfig "github.com/lidge-jun/opencodex-go/internal/config"
)

func TestManagementProviderAndModelCRUDThroughServer(t *testing.T) {
	cfg := appconfig.Default()
	cfg.DefaultProvider = "base"
	cfg.Providers["base"] = appconfig.ProviderConfig{Adapter: "openai-chat", BaseURL: "https://base.example", APIKey: "must-not-leak"}
	proxy := New(Config{ManagementConfig: &cfg, ConfigPath: filepath.Join(t.TempDir(), "config.json")})

	configView := managementRequest(t, proxy.Handler(), http.MethodGet, "/api/config", "")
	if configView.Code != http.StatusOK || strings.Contains(configView.Body.String(), "must-not-leak") || !strings.Contains(configView.Body.String(), `"hasApiKey":true`) {
		t.Fatalf("config view = %d %s", configView.Code, configView.Body.String())
	}

	created := managementRequest(t, proxy.Handler(), http.MethodPost, "/api/providers", `{"name":"extra","provider":{"adapter":"openai-chat","baseUrl":"https://extra.example","apiKey":"new-secret"}}`)
	if created.Code != http.StatusOK || created.Body.String() != `{"success":true,"name":"extra"}` {
		t.Fatalf("create provider = %d %s", created.Code, created.Body.String())
	}
	patched := managementRequest(t, proxy.Handler(), http.MethodPatch, "/api/providers?name=extra", `{"disabled":true}`)
	if patched.Code != http.StatusOK || !strings.Contains(patched.Body.String(), `"disabled":true`) {
		t.Fatalf("patch provider = %d %s", patched.Code, patched.Body.String())
	}
	secretPatch := managementRequest(t, proxy.Handler(), http.MethodPatch, "/api/providers?name=extra", `{"apiKey":"replacement"}`)
	if secretPatch.Code != http.StatusBadRequest {
		t.Fatalf("secret patch = %d %s", secretPatch.Code, secretPatch.Body.String())
	}
	removed := managementRequest(t, proxy.Handler(), http.MethodDelete, "/api/providers?name=extra", "")
	if removed.Code != http.StatusOK {
		t.Fatalf("delete provider = %d %s", removed.Code, removed.Body.String())
	}

	model := managementRequest(t, proxy.Handler(), http.MethodPost, "/api/custom-models", `{"provider":"base","modelId":"vision-1","displayName":"Vision","contextWindow":8192,"inputModalities":["text","image","image"]}`)
	if model.Code != http.StatusCreated {
		t.Fatalf("create model = %d %s", model.Code, model.Body.String())
	}
	var createdModel struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(model.Body.Bytes(), &createdModel); err != nil || createdModel.ID == "" {
		t.Fatalf("decode model: id=%q error=%v", createdModel.ID, err)
	}
	updated := managementRequest(t, proxy.Handler(), http.MethodPut, "/api/custom-models/"+createdModel.ID, `{"displayName":"Vision 2","contextWindow":16384}`)
	if updated.Code != http.StatusOK || !strings.Contains(updated.Body.String(), `"contextWindow":16384`) {
		t.Fatalf("update model = %d %s", updated.Code, updated.Body.String())
	}
	deleted := managementRequest(t, proxy.Handler(), http.MethodDelete, "/api/custom-models/"+createdModel.ID, "")
	if deleted.Code != http.StatusOK {
		t.Fatalf("delete model = %d %s", deleted.Code, deleted.Body.String())
	}

	unknown := managementRequest(t, proxy.Handler(), http.MethodGet, "/api/does-not-exist", "")
	if unknown.Code != http.StatusNotFound {
		t.Fatalf("unknown management route = %d %s", unknown.Code, unknown.Body.String())
	}
}

func managementRequest(t *testing.T, handler http.Handler, method, target, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}
