package management

import (
	"net/http"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/config"
)

func FuzzManagementInputValidation(f *testing.F) {
	for _, seed := range []struct {
		selector uint8
		payload  []byte
	}{
		{0, []byte(`{"name":"extra","provider":{"adapter":"openai-chat","baseUrl":"https://example.test"}}`)},
		{1, []byte(`{"scope":"models","provider":"acme","enabled":false,"targets":[{"id":"m"}]}`)},
		{2, []byte(`{"provider":"acme","modelId":"m"}`)},
		{3, []byte(`{"name":"acme","key":"secret"}`)},
		{0, []byte("{\x00")},
	} {
		f.Add(seed.selector, seed.payload)
	}
	f.Fuzz(func(t *testing.T, selector uint8, payload []byte) {
		if len(payload) > 64<<10 {
			t.Skip()
		}
		cfg := config.Default()
		cfg.Providers["acme"] = config.ProviderConfig{Adapter: "openai-chat", BaseURL: "https://example.test", AuthMode: "key", DefaultModel: "m"}
		api := newParityAPI(t, &cfg)
		targets := []struct{ method, path string }{
			{http.MethodPost, "/api/providers"},
			{http.MethodPut, "/api/model-visibility"},
			{http.MethodPost, "/api/custom-models"},
			{http.MethodPost, "/api/providers/keys"},
		}
		target := targets[int(selector)%len(targets)]
		response := serveManagement(api, target.method, target.path, string(payload))
		if response.Code < 200 || response.Code > 599 {
			t.Fatalf("invalid HTTP status %d", response.Code)
		}
	})
}
