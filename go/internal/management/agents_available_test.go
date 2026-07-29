package management

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/config"
)

// Both pickers render from `available`. Serving the routes without it is not a
// visible error -- the selector just renders empty forever -- so the regression
// these tests hold is "the key exists AND it excludes what the user disabled".
func TestAgentPickerRoutesExposeAvailableExcludingDisabled(t *testing.T) {
	for _, route := range []string{"/api/subagent-models", "/api/injection-model"} {
		t.Run(route, func(t *testing.T) {
			cfg := config.Default()
			cfg.Providers["p"] = config.ProviderConfig{Models: []string{"m"}}
			cfg.DisabledModels = []string{"p/hidden"}
			api := newParityAPI(t, &cfg, func(options *Options) { options.Registry = catalogRegistry{} })

			response := serveManagement(api, http.MethodGet, route, "")
			if response.Code != http.StatusOK {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			var payload struct {
				Available []string `json:"available"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
				t.Fatalf("payload: %v (%s)", err, response.Body.String())
			}
			if len(payload.Available) == 0 {
				t.Fatalf("available is empty, so the picker renders nothing: %s", response.Body.String())
			}
			var sawRouted, sawDisabled bool
			for _, slug := range payload.Available {
				switch slug {
				case "p/m":
					sawRouted = true
				case "p/hidden":
					sawDisabled = true
				}
			}
			if !sawRouted {
				t.Fatalf("routed model missing from available: %v", payload.Available)
			}
			if sawDisabled {
				t.Fatalf("disabled model offered by the picker: %v", payload.Available)
			}
		})
	}
}

// The two routes that already served availableModels() keep their bytes: this
// unit adds a narrower helper rather than narrowing theirs.
//
// It pins two known defects on that older path so a future fix has to change
// this test deliberately: it offers disabled models, and it double-prefixes an
// already-namespaced ID into "p/p/hidden". The new picker helper does neither.
func TestSiblingRoutesStillServeUnfilteredAvailable(t *testing.T) {
	cfg := config.Default()
	cfg.Providers["p"] = config.ProviderConfig{Models: []string{"m"}}
	cfg.DisabledModels = []string{"p/hidden"}
	api := newParityAPI(t, &cfg, func(options *Options) { options.Registry = catalogRegistry{} })

	response := serveManagement(api, http.MethodGet, "/api/subagent-model-fallback", "")
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var payload struct {
		Available []string `json:"available"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("payload: %v (%s)", err, response.Body.String())
	}
	var sawDisabled bool
	for _, slug := range payload.Available {
		if slug == "p/p/hidden" {
			sawDisabled = true
		}
	}
	if !sawDisabled {
		t.Fatalf("sibling route changed shape; this unit must not touch it: %v", payload.Available)
	}
}
