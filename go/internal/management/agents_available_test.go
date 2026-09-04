package management

import (
	"encoding/json"
	"net/http"
	"strings"
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

// The sibling routes stay intentionally UNFILTERED -- they answer "what exists"
// rather than "what may be picked" -- but an id they emit still has to be a
// real selector. This once produced "p/p/hidden"; it must never come back.
func TestSiblingRouteAvailableIsUnfilteredButWellFormed(t *testing.T) {
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
		if strings.HasPrefix(slug, "p/p/") {
			t.Fatalf("double-prefixed selector returned: %v", payload.Available)
		}
		if slug == "p/hidden" {
			sawDisabled = true
		}
	}
	if !sawDisabled {
		t.Fatalf("sibling route should still be unfiltered: %v", payload.Available)
	}
}

// A disabled model must disappear whichever way the user's stored entry is
// written. Matching on one exact spelling meant the GUI kept offering a model
// the user had switched off, and picking it routed nowhere.
func TestDisabledMatchingToleratesBothSlugForms(t *testing.T) {
	for _, stored := range []string{"p/m", "p/hidden"} {
		t.Run(stored, func(t *testing.T) {
			cfg := config.Default()
			cfg.Providers["p"] = config.ProviderConfig{Models: []string{"m", "hidden"}}
			cfg.DisabledModels = []string{stored}
			api := newParityAPI(t, &cfg, func(options *Options) { options.Registry = catalogRegistry{} })

			response := serveManagement(api, http.MethodGet, "/api/subagent-models", "")
			var payload struct {
				Available []string `json:"available"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
				t.Fatalf("payload: %v (%s)", err, response.Body.String())
			}
			for _, slug := range payload.Available {
				if slug == stored {
					t.Fatalf("disabled %q still offered: %v", stored, payload.Available)
				}
			}
		})
	}
}
