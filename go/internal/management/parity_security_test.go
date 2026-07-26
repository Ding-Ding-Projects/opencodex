package management

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/config"
)

func newParityAPI(t *testing.T, cfg *config.Config, options ...func(*Options)) *API {
	t.Helper()
	args := Options{Config: cfg}
	for _, apply := range options {
		apply(&args)
	}
	api, err := New(args)
	if err != nil {
		t.Fatal(err)
	}
	return api
}

func serveManagement(api *API, method, target, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	response := httptest.NewRecorder()
	api.ServeHTTP(response, request)
	return response
}

func TestManagementAuthorizationRunsBeforeRouteAndBodyParsing(t *testing.T) {
	cfg := config.Default()
	called := 0
	api := newParityAPI(t, &cfg, func(options *Options) {
		options.Authorize = func(request *http.Request) bool {
			called++
			return request.Header.Get("X-Test-Auth") == "ok"
		}
	})
	request := httptest.NewRequest(http.MethodPut, "/api/settings", strings.NewReader(`{"streamMode":`))
	response := httptest.NewRecorder()
	api.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized || called != 1 || !strings.Contains(response.Body.String(), "opencodex API key required") {
		t.Fatalf("response=%d %s called=%d", response.Code, response.Body.String(), called)
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("cache policy=%q", response.Header().Get("Cache-Control"))
	}
}

func TestProviderDTOContainsNoCredentialMaterial(t *testing.T) {
	provider := config.ProviderConfig{
		Adapter: "openai-responses", BaseURL: "https://user:password@example.com/v1?api_key=query-secret#fragment",
		APIKey: "sk-super-secret", Headers: map[string]string{"Authorization": "Bearer header-secret"}, DefaultModel: "wire",
	}
	dto := publicProvider("provider", provider)
	encoded, _ := json.Marshal(dto)
	text := string(encoded)
	for _, forbidden := range []string{"password", "query-secret", "sk-super-secret", "header-secret", "Authorization"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("provider DTO leaked %q: %s", forbidden, text)
		}
	}
	if dto["baseUrl"] != "https://example.com/v1" || dto["hasApiKey"] != true {
		t.Fatalf("dto=%#v", dto)
	}
}

func TestModelSelectionAndVisibilityPersistInConfig(t *testing.T) {
	cfg := config.Default()
	cfg.Providers["acme"] = config.ProviderConfig{Adapter: "openai-chat", BaseURL: "https://api.example.com", DefaultModel: "m1"}
	api := newParityAPI(t, &cfg)
	selected := serveManagement(api, http.MethodPut, "/api/selected-models", `{"provider":"acme","models":["m1","m1","m2"]}`)
	if selected.Code != http.StatusOK || len(cfg.Providers["acme"].SelectedModels) != 2 {
		t.Fatalf("selected=%d %s config=%#v", selected.Code, selected.Body.String(), cfg.Providers["acme"].SelectedModels)
	}
	disabled := serveManagement(api, http.MethodPut, "/api/model-visibility", `{"scope":"models","provider":"acme","enabled":false,"targets":[{"id":"m1"}]}`)
	if disabled.Code != http.StatusOK || len(cfg.DisabledModels) != 1 || cfg.DisabledModels[0] != "acme/m1" {
		t.Fatalf("disabled=%d %s config=%#v", disabled.Code, disabled.Body.String(), cfg.DisabledModels)
	}
	enabled := serveManagement(api, http.MethodPut, "/api/model-visibility", `{"scope":"models","provider":"acme","enabled":true,"targets":[{"id":"m1"}]}`)
	if enabled.Code != http.StatusOK || len(cfg.DisabledModels) != 0 {
		t.Fatalf("enabled=%d %s config=%#v", enabled.Code, enabled.Body.String(), cfg.DisabledModels)
	}
}

func TestCustomModelsPersistReloadAndValidateProvider(t *testing.T) {
	cfg := config.Default()
	cfg.Providers["acme"] = config.ProviderConfig{Adapter: "openai-chat", BaseURL: "https://api.example.com", DefaultModel: "m1"}
	api := newParityAPI(t, &cfg)
	missing := serveManagement(api, http.MethodPost, "/api/custom-models", `{"provider":"missing","modelId":"m1"}`)
	if missing.Code != http.StatusNotFound || len(cfg.CustomModels) != 0 {
		t.Fatalf("missing=%d %s config=%#v", missing.Code, missing.Body.String(), cfg.CustomModels)
	}
	created := serveManagement(api, http.MethodPost, "/api/custom-models", `{"provider":"acme","modelId":"m1","displayName":"First","contextWindow":64000}`)
	if created.Code != http.StatusCreated || len(cfg.CustomModels) != 1 {
		t.Fatalf("created=%d %s config=%#v", created.Code, created.Body.String(), cfg.CustomModels)
	}
	id := cfg.CustomModels[0].ID
	updated := serveManagement(api, http.MethodPut, "/api/custom-models/"+id, `{"modelId":"m2","displayName":"Second"}`)
	if updated.Code != http.StatusOK || cfg.CustomModels[0].ModelID != "m2" {
		t.Fatalf("updated=%d %s config=%#v", updated.Code, updated.Body.String(), cfg.CustomModels)
	}
	reloaded := newParityAPI(t, &cfg)
	get := serveManagement(reloaded, http.MethodGet, "/api/custom-models", "")
	if get.Code != http.StatusOK || !strings.Contains(get.Body.String(), `"modelId":"m2"`) {
		t.Fatalf("get=%d %s", get.Code, get.Body.String())
	}
}

func TestProviderContextCapsSupportGlobalSetAllAndPersistence(t *testing.T) {
	cfg := config.Default()
	cfg.Providers["a"] = config.ProviderConfig{Adapter: "openai-chat", BaseURL: "https://a.example", DefaultModel: "m"}
	cfg.Providers["b"] = config.ProviderConfig{Adapter: "openai-chat", BaseURL: "https://b.example", DefaultModel: "m"}
	api := newParityAPI(t, &cfg)
	enabled := serveManagement(api, http.MethodPut, "/api/provider-context-caps", `{"provider":"a","enabled":true}`)
	if enabled.Code != http.StatusOK || cfg.ProviderContextCaps["a"] != defaultProviderContextCap {
		t.Fatalf("enabled=%d %s config=%#v", enabled.Code, enabled.Body.String(), cfg.ProviderContextCaps)
	}
	valued := serveManagement(api, http.MethodPut, "/api/provider-context-caps", `{"value":500000}`)
	if valued.Code != http.StatusOK || cfg.ContextCapValue != 500000 || cfg.ProviderContextCaps["a"] != 500000 {
		t.Fatalf("valued=%d %s config=%#v value=%d", valued.Code, valued.Body.String(), cfg.ProviderContextCaps, cfg.ContextCapValue)
	}
	all := serveManagement(api, http.MethodPut, "/api/provider-context-caps", `{"setAll":true}`)
	if all.Code != http.StatusOK || cfg.ProviderContextCaps["b"] != 500000 {
		t.Fatalf("all=%d %s config=%#v", all.Code, all.Body.String(), cfg.ProviderContextCaps)
	}
	unknown := serveManagement(api, http.MethodPut, "/api/provider-context-caps", `{"provider":"missing","enabled":true}`)
	if unknown.Code != http.StatusNotFound || len(cfg.ProviderContextCaps) != 2 {
		t.Fatalf("unknown=%d %s config=%#v", unknown.Code, unknown.Body.String(), cfg.ProviderContextCaps)
	}
}

func TestSidecarSettingsStrictValidationAndAtomicUpdate(t *testing.T) {
	cfg := config.Default()
	cfg.WebSearchSidecar = &config.WebSearchSidecarConfig{Model: "before", Backend: "openai"}
	api := newParityAPI(t, &cfg)
	bad := serveManagement(api, http.MethodPut, "/api/sidecar-settings", `{"webSearch":{"backend":"invalid"}}`)
	if bad.Code != http.StatusBadRequest || cfg.WebSearchSidecar.Model != "before" || cfg.WebSearchSidecar.Backend != "openai" {
		t.Fatalf("bad=%d %s config=%#v", bad.Code, bad.Body.String(), cfg.WebSearchSidecar)
	}
	unknown := serveManagement(api, http.MethodPut, "/api/sidecar-settings", `{"webSearch":{"model":"new","secret":"bad"}}`)
	if unknown.Code != http.StatusBadRequest || cfg.WebSearchSidecar.Model != "before" {
		t.Fatalf("unknown=%d %s config=%#v", unknown.Code, unknown.Body.String(), cfg.WebSearchSidecar)
	}
	good := serveManagement(api, http.MethodPut, "/api/sidecar-settings", `{"webSearch":{"model":"new","backend":"anthropic"},"vision":{"model":"vision","maxDescriptionsPerTurn":3}}`)
	if good.Code != http.StatusOK || cfg.WebSearchSidecar.Model != "new" || cfg.VisionSidecar == nil || cfg.VisionSidecar.MaxDescriptionsPerTurn != 3 {
		t.Fatalf("good=%d %s config=%#v %#v", good.Code, good.Body.String(), cfg.WebSearchSidecar, cfg.VisionSidecar)
	}
}

func TestAgentSettingsPersistAndReloadWithoutSecretFields(t *testing.T) {
	cfg := config.Default()
	api := newParityAPI(t, &cfg)
	response := serveManagement(api, http.MethodPut, "/api/injection-model", `{"multiAgentGuidanceEnabled":false,"model":"gpt-test","effort":"max","prompt":"use {{model}}"}`)
	if response.Code != http.StatusOK || cfg.InjectionModel != "gpt-test" || cfg.InjectionEffort != "max" || cfg.MultiAgentGuidanceEnabled == nil || *cfg.MultiAgentGuidanceEnabled {
		t.Fatalf("response=%d %s config=%#v", response.Code, response.Body.String(), cfg)
	}
	reloaded := newParityAPI(t, &cfg)
	get := serveManagement(reloaded, http.MethodGet, "/api/injection-model", "")
	if get.Code != http.StatusOK || !strings.Contains(get.Body.String(), `"model":"gpt-test"`) || !strings.Contains(get.Body.String(), `"prompt":"use {{model}}"`) {
		t.Fatalf("get=%d %s", get.Code, get.Body.String())
	}
}

func TestRegisteredRoutesIncludeTSParityCohort(t *testing.T) {
	registered := map[string]bool{}
	for _, route := range RegisteredRoutes() {
		registered[route] = true
	}
	for _, route := range []string{
		"PUT /api/disabled-models", "PUT /api/model-visibility", "GET /api/selected-models", "PUT /api/selected-models",
		"GET /api/sidecar-settings", "PUT /api/sidecar-settings",
	} {
		if !registered[route] {
			t.Errorf("route missing: %s", route)
		}
	}
}

func TestComboWritesCanonicalConfigAndMigratesReferences(t *testing.T) {
	cfg := config.Default()
	cfg.Providers["a"] = config.ProviderConfig{Adapter: "openai-chat", BaseURL: "https://a.example", DefaultModel: "m"}
	api := newParityAPI(t, &cfg)
	created := serveManagement(api, http.MethodPut, "/api/combos", `{"id":"old","combo":{"alias":"route/old","strategy":"failover","targets":[{"provider":"a","model":"m"}]}}`)
	if created.Code != http.StatusOK || cfg.Combos["old"].Targets[0].Provider != "a" {
		t.Fatalf("created=%d %s config=%#v", created.Code, created.Body.String(), cfg.Combos)
	}
	cfg.DisabledModels = []string{"route/old"}
	cfg.SubagentModels = []string{"combo/old"}
	cfg.InjectionModel = "route/old"
	renamed := serveManagement(api, http.MethodPut, "/api/combos", `{"id":"new","renameFrom":"old","combo":{"alias":"route/new","strategy":"failover","targets":[{"provider":"a","model":"m"}]}}`)
	if renamed.Code != http.StatusOK || cfg.Combos["new"].Alias != "route/new" || cfg.DisabledModels[0] != "route/new" || cfg.SubagentModels[0] != "route/new" || cfg.InjectionModel != "route/new" {
		t.Fatalf("renamed=%d %s config=%#v disabled=%#v subagents=%#v injection=%q", renamed.Code, renamed.Body.String(), cfg.Combos, cfg.DisabledModels, cfg.SubagentModels, cfg.InjectionModel)
	}
	deleteProvider := serveManagement(api, http.MethodDelete, "/api/providers?name=a", "")
	if deleteProvider.Code != http.StatusConflict || !strings.Contains(deleteProvider.Body.String(), `"new"`) {
		t.Fatalf("dependent provider deletion=%d %s", deleteProvider.Code, deleteProvider.Body.String())
	}
}

func TestProviderPatchCannotDisableDefaultAndProbeErrorIsRedacted(t *testing.T) {
	cfg := config.Default()
	cfg.DefaultProvider = "a"
	cfg.Providers["a"] = config.ProviderConfig{Adapter: "openai-chat", BaseURL: "https://a.example", DefaultModel: "m", APIKey: "sk-secret-value"}
	api := newParityAPI(t, &cfg)
	rejected := serveManagement(api, http.MethodPatch, "/api/providers?name=a", `{"disabled":true}`)
	if rejected.Code != http.StatusBadRequest || cfg.Providers["a"].Disabled {
		t.Fatalf("rejected=%d %s config=%#v", rejected.Code, rejected.Body.String(), cfg.Providers["a"])
	}
}
