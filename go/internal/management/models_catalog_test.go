package management

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

type catalogRegistry struct{}

func (catalogRegistry) ResolveModel(string) (*types.ResolvedModel, error) { return nil, nil }
func (catalogRegistry) ResolveTransport(string, *types.AuthContext) (*types.Transport, error) {
	return nil, nil
}

func (catalogRegistry) ListModels() []types.ModelEntry {
	return []types.ModelEntry{
		{ID: "gpt-5.6", Provider: "openai", DisplayName: "GPT 5.6", ContextWindow: 1_000_000},
		{ID: "p/m", Provider: "p", DisplayName: "Routed M", ContextWindow: 500_000},
		{ID: "p/hidden", Provider: "p", ContextWindow: 100_000},
	}
}

// The response body IS the array, with bare `id` plus the Codex-facing `namespaced`
// selector: the GUI dashboard iterates it directly and `ocx opencode` refuses any
// other shape (oracle: src/server/management/model-routes.ts).
func TestModelsResponseIsAnArrayOfCatalogRows(t *testing.T) {
	cfg := config.Default()
	cfg.Providers["p"] = config.ProviderConfig{Models: []string{"m"}}
	cfg.DisabledModels = []string{"p/hidden"}
	cfg.ProviderContextCaps = map[string]int{"p": 350_000}
	api := newParityAPI(t, &cfg, func(options *Options) { options.Registry = catalogRegistry{} })

	response := serveManagement(api, http.MethodGet, "/api/models", "")
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var rows []modelCatalogRow
	if err := json.Unmarshal(response.Body.Bytes(), &rows); err != nil {
		t.Fatalf("payload is not a bare array: %v (%s)", err, response.Body.String())
	}
	if len(rows) != 3 {
		t.Fatalf("rows=%d body=%s", len(rows), response.Body.String())
	}
	if !rows[0].Native || rows[0].ID != "gpt-5.6" || rows[0].Namespaced != "gpt-5.6" {
		t.Fatalf("native row = %+v", rows[0])
	}
	if rows[1].Native || rows[1].ID != "m" || rows[1].Namespaced != "p/m" || rows[1].Disabled {
		t.Fatalf("routed row = %+v", rows[1])
	}
	if rows[1].ContextCap != 350_000 || rows[1].ContextCapped == nil || !*rows[1].ContextCapped {
		t.Fatalf("routed row cap = %+v", rows[1])
	}
	if !rows[2].Disabled {
		t.Fatalf("disabled row = %+v", rows[2])
	}
	if rows[2].ContextCapped == nil || *rows[2].ContextCapped {
		t.Fatalf("uncapped window should report contextCapped=false: %+v", rows[2])
	}
}

// `selectedModels` stores bare ids, so the availability map the GUI diffs against
// must not leak routed slugs.
func TestSelectedModelsAvailableUsesBareIDs(t *testing.T) {
	cfg := config.Default()
	cfg.Providers["p"] = config.ProviderConfig{Models: []string{"m"}}
	api := newParityAPI(t, &cfg, func(options *Options) { options.Registry = catalogRegistry{} })

	response := serveManagement(api, http.MethodGet, "/api/selected-models", "")
	var payload struct {
		Available map[string][]string `json:"available"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	want := []string{"hidden", "m"}
	got := payload.Available["p"]
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("available[p] = %v, want %v", got, want)
	}
}
