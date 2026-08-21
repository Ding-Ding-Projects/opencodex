package management

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/config"
)

func TestNativeGapRouteInventoryIncludesIssue17Families(t *testing.T) {
	want := []string{
		"GET /api/changelog", "GET /api/export/capabilities", "POST /api/export",
		"GET /api/host", "PUT /api/host", "POST /api/host/pair", "DELETE /api/host/pair",
		"POST /api/host/pair/claim", "GET /api/host/export", "GET /api/host/history",
		"POST /api/host/restore", "POST /api/host/exit", "GET /api/host/discover", "POST /api/host/discover",
		"GET /api/launch", "POST /api/launch", "GET /api/launch/install",
		"POST /api/launch/install", "GET /api/launch/install/{jobId}", "GET /api/terminal", "POST /api/terminal",
		"GET /api/terminal/{id}", "POST /api/terminal/{id}/input", "DELETE /api/terminal/{id}",
		"GET /api/system/restart", "POST /api/system/restart",
	}
	registered := map[string]bool{}
	for _, route := range RegisteredRoutes() {
		registered[route] = true
	}
	for _, route := range want {
		if !registered[route] {
			t.Errorf("missing issue #17 route %s", route)
		}
	}
}

func TestNativeChangelogExportAndPairingRoutesAreRealAndSecretFree(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "CHANGELOG.md"), []byte("# Changelog\n\n## 2.8.0 — 2026-08-21\n- Native parity\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := config.Default()
	cfg.AuthToken = "management-secret"
	cfg.APIKeys = []config.ProxyAPIKey{{ID: "id", Name: "key", Key: "another-secret"}}
	api, err := New(Options{Config: &cfg, ConfigPath: filepath.Join(dir, "config.json")})
	if err != nil {
		t.Fatal(err)
	}
	changelog := serveManagement(api, http.MethodGet, "/api/changelog", "")
	if changelog.Code != http.StatusOK || !strings.Contains(changelog.Body.String(), "2.8.0") {
		t.Fatalf("changelog=%d %s", changelog.Code, changelog.Body.String())
	}
	capabilities := serveManagement(api, http.MethodGet, "/api/export/capabilities", "")
	if capabilities.Code != http.StatusOK || !strings.Contains(capabilities.Body.String(), "json") {
		t.Fatalf("capabilities=%d %s", capabilities.Code, capabilities.Body.String())
	}
	export := serveManagement(api, http.MethodPost, "/api/export", `{"dataset":"config","format":"json"}`)
	if export.Code != http.StatusOK || strings.Contains(export.Body.String(), "management-secret") || strings.Contains(export.Body.String(), "another-secret") {
		t.Fatalf("export=%d %s", export.Code, export.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(export.Body.Bytes(), &payload); err != nil {
		t.Fatalf("export JSON: %v", err)
	}
	pair := serveManagement(api, http.MethodPost, "/api/host/pair", "")
	if pair.Code != http.StatusOK || !strings.Contains(pair.Body.String(), "token") {
		t.Fatalf("pair=%d %s", pair.Code, pair.Body.String())
	}
	var pairBody map[string]any
	if err := json.Unmarshal(pair.Body.Bytes(), &pairBody); err != nil {
		t.Fatal(err)
	}
	claim := serveManagement(api, http.MethodPost, "/api/host/pair/claim", `{"token":"`+pairBody["token"].(string)+`"}`)
	if claim.Code != http.StatusOK || !strings.Contains(claim.Body.String(), "key") {
		t.Fatalf("claim=%d %s", claim.Code, claim.Body.String())
	}
	second := serveManagement(api, http.MethodPost, "/api/host/pair/claim", `{"token":"`+pairBody["token"].(string)+`"}`)
	if second.Code == http.StatusOK {
		t.Fatal("pairing token was reusable")
	}
}
