package management

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/config"
)

func TestProxyAPIKeysNeverReturnSecretsAndNotifyAdmission(t *testing.T) {
	cfg := config.Default()
	var refreshed atomic.Int32
	var notified []config.ProxyAPIKey
	api := newParityAPI(t, &cfg, func(options *Options) {
		options.RefreshCatalog = func() error { refreshed.Add(1); return nil }
		options.OnAPIKeysChanged = func(keys []config.ProxyAPIKey) { notified = append([]config.ProxyAPIKey(nil), keys...) }
	})
	secret := "ocx_client_supplied_secret_123456789"
	created := serveManagement(api, http.MethodPost, "/api/keys", `{"name":"desktop","key":"`+secret+`"}`)
	if created.Code != http.StatusCreated || strings.Contains(created.Body.String(), secret) || len(notified) != 1 || notified[0].Key != secret {
		t.Fatalf("created=%d %s notified=%d", created.Code, created.Body.String(), len(notified))
	}
	listed := serveManagement(api, http.MethodGet, "/api/keys", "")
	if listed.Code != http.StatusOK || strings.Contains(listed.Body.String(), secret) || strings.Contains(listed.Body.String(), `"key"`) {
		t.Fatalf("listed=%d %s", listed.Code, listed.Body.String())
	}
	if refreshed.Load() != 1 {
		t.Fatalf("catalog refresh calls=%d", refreshed.Load())
	}
	deleted := serveManagement(api, http.MethodDelete, "/api/keys", `{"id":"`+cfg.APIKeys[0].ID+`"}`)
	if deleted.Code != http.StatusOK || len(cfg.APIKeys) != 0 || len(notified) != 0 || refreshed.Load() != 2 {
		t.Fatalf("deleted=%d %s keys=%d notified=%d refresh=%d", deleted.Code, deleted.Body.String(), len(cfg.APIKeys), len(notified), refreshed.Load())
	}
}

func TestProviderKeyPoolCRUDReturnsMetadataOnly(t *testing.T) {
	cfg := config.Default()
	cfg.Providers["acme"] = config.ProviderConfig{Adapter: "openai-chat", BaseURL: "https://api.example.test/v1", AuthMode: "key", DefaultModel: "m"}
	api := newParityAPI(t, &cfg)
	secretOne := "provider-secret-one"
	secretTwo := "provider-secret-two"
	first := serveManagement(api, http.MethodPost, "/api/providers/keys", `{"name":"acme","key":"`+secretOne+`","label":"primary"}`)
	second := serveManagement(api, http.MethodPost, "/api/providers/keys", `{"name":"acme","key":"`+secretTwo+`","label":"backup"}`)
	if first.Code != http.StatusCreated || second.Code != http.StatusCreated || strings.Contains(first.Body.String()+second.Body.String(), "provider-secret") {
		t.Fatalf("first=%d %s second=%d %s", first.Code, first.Body.String(), second.Code, second.Body.String())
	}
	_, infos := config.ListAPIKeys(&cfg, "acme")
	if len(infos) != 2 {
		t.Fatalf("provider key infos=%#v", infos)
	}
	listed := serveManagement(api, http.MethodGet, "/api/providers/keys?name=acme", "")
	if listed.Code != http.StatusOK || strings.Contains(listed.Body.String(), secretOne) || strings.Contains(listed.Body.String(), secretTwo) || !strings.Contains(listed.Body.String(), `"masked":"prov****-two"`) {
		t.Fatalf("listed=%d %s", listed.Code, listed.Body.String())
	}
	if !strings.HasPrefix(listed.Body.String(), `{"activeId":"`+infos[1].ID+`","keys":[{"id":"`+infos[0].ID+`","label":"primary","masked":`) {
		t.Fatalf("provider key field order differs from TS: %s", listed.Body.String())
	}
	active := serveManagement(api, http.MethodPut, "/api/providers/keys/active", `{"name":"acme","id":"`+infos[0].ID+`"}`)
	alias := serveManagement(api, http.MethodPut, "/api/providers/keys/alias", `{"name":"acme","id":"`+infos[0].ID+`","alias":"main"}`)
	removed := serveManagement(api, http.MethodDelete, "/api/providers/keys?name=acme&id="+infos[1].ID, "")
	if active.Code != http.StatusOK || active.Body.String() != `{"ok":true,"name":"acme","activeId":"`+infos[0].ID+`"}` || alias.Code != http.StatusOK || removed.Code != http.StatusOK || cfg.Providers["acme"].APIKey != secretOne {
		t.Fatalf("active=%d alias=%d removed=%d provider=%#v", active.Code, alias.Code, removed.Code, cfg.Providers["acme"])
	}
}

func TestKeyProviderCatalogAndAPIAccessContainNoCredentials(t *testing.T) {
	cfg := config.Default()
	cfg.Host = "0.0.0.0"
	cfg.Port = 10100
	api := newParityAPI(t, &cfg)
	providers := serveManagement(api, http.MethodGet, "/api/key-providers", "")
	if providers.Code != http.StatusOK || !strings.Contains(providers.Body.String(), `"openai-apikey"`) || strings.Contains(strings.ToLower(providers.Body.String()), "authorization") {
		t.Fatalf("providers=%d %s", providers.Code, providers.Body.String())
	}
	request := httptest.NewRequest(http.MethodGet, "http://192.168.1.50:10100/api/keys", nil)
	request.Host = "192.168.1.50:10100"
	response := httptest.NewRecorder()
	api.ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"baseUrl":"http://192.168.1.50:10100/v1"`) {
		t.Fatalf("api access=%d %s", response.Code, response.Body.String())
	}
}
