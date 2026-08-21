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
	archive := serveManagement(api, http.MethodPost, "/api/export", `{"dataset":"config","format":"json","archive":"zip"}`)
	if archive.Code != http.StatusOK || archive.Header().Get("Content-Type") != "application/zip" || len(archive.Body.Bytes()) < 100 {
		t.Fatalf("zip export=%d headers=%v bytes=%d", archive.Code, archive.Header(), len(archive.Body.Bytes()))
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

func TestPairingClaimIsBoundedRateLimitedConstantTimeShapeAndNoStore(t *testing.T) {
	cfg := config.Default()
	api := newParityAPI(t, &cfg)
	offer := serveManagement(api, http.MethodPost, "/api/host/pair", "")
	if offer.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("offer cache header = %q", offer.Header().Get("Cache-Control"))
	}
	var body map[string]any
	if err := json.Unmarshal(offer.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	token := body["token"].(string)
	if len(token) != 43 {
		t.Fatalf("token length = %d, want 43", len(token))
	}
	for i := 0; i < 10; i++ {
		result := serveManagement(api, http.MethodPost, "/api/host/pair/claim", `{"token":"wrong-token-that-is-long-enough-but-wrong-000"}`)
		if result.Code != http.StatusBadRequest {
			t.Fatalf("mismatch %d status=%d body=%s", i, result.Code, result.Body.String())
		}
		if result.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("mismatch response was cacheable")
		}
	}
	limited := serveManagement(api, http.MethodPost, "/api/host/pair/claim", `{"token":"`+token+`"}`)
	if limited.Code != http.StatusTooManyRequests || limited.Header().Get("Retry-After") == "" {
		t.Fatalf("rate limit status=%d headers=%v", limited.Code, limited.Header())
	}
	if limited.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("rate-limit response was cacheable")
	}
}

func TestPairingPersistenceFailureRestoresTokenAndKeyState(t *testing.T) {
	dir := t.TempDir()
	badPath := filepath.Join(dir, "config-directory")
	if err := os.Mkdir(badPath, 0o700); err != nil {
		t.Fatal(err)
	}
	cfg := config.Default()
	api, err := New(Options{Config: &cfg, ConfigPath: badPath})
	if err != nil {
		t.Fatal(err)
	}
	offer := serveManagement(api, http.MethodPost, "/api/host/pair", "")
	var body map[string]any
	if err := json.Unmarshal(offer.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	token := body["token"].(string)
	claim := serveManagement(api, http.MethodPost, "/api/host/pair/claim", `{"token":"`+token+`"}`)
	if claim.Code != http.StatusInternalServerError || len(cfg.APIKeys) != 0 {
		t.Fatalf("claim=%d keys=%d body=%s", claim.Code, len(cfg.APIKeys), claim.Body.String())
	}
	retry := serveManagement(api, http.MethodPost, "/api/host/pair/claim", `{"token":"`+token+`"}`)
	if retry.Code == http.StatusBadRequest && strings.Contains(retry.Body.String(), "expired") {
		t.Fatalf("persistence failure consumed token: %s", retry.Body.String())
	}
}

func TestHostWildcardIsRemoteAndLoopbackIsLocal(t *testing.T) {
	for _, host := range []string{"0.0.0.0", "::", "192.0.2.10"} {
		if isLoopbackHost(host) {
			t.Fatalf("wildcard/remote host %q was classified as loopback", host)
		}
	}
	for _, host := range []string{"", "localhost", "127.0.0.1", "::1", "[::1]"} {
		if !isLoopbackHost(host) {
			t.Fatalf("loopback host %q was classified as remote", host)
		}
	}
}

func TestLoopbackTerminalRunsFixedShellAndSupportsSessionLifecycle(t *testing.T) {
	cfg := config.Default()
	api := newParityAPI(t, &cfg, func(options *Options) { options.Loopback = func() bool { return true } })
	created := serveManagement(api, http.MethodPost, "/api/terminal", `{"preset":"shell"}`)
	if created.Code != http.StatusOK || !strings.Contains(created.Body.String(), `"state":"running"`) {
		t.Fatalf("create=%d %s", created.Code, created.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(created.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	session := payload["session"].(map[string]any)
	id := session["id"].(string)
	input := serveManagement(api, http.MethodPost, "/api/terminal/"+id+"/input", `{"data":"echo parity\n"}`)
	if input.Code != http.StatusOK {
		t.Fatalf("input=%d %s", input.Code, input.Body.String())
	}
	read := serveManagement(api, http.MethodGet, "/api/terminal/"+id, "")
	if read.Code != http.StatusOK {
		t.Fatalf("read=%d %s", read.Code, read.Body.String())
	}
	deleted := serveManagement(api, http.MethodDelete, "/api/terminal/"+id, "")
	if deleted.Code != http.StatusOK {
		t.Fatalf("delete=%d %s", deleted.Code, deleted.Body.String())
	}
}

func TestHostDiscoveryDoesNotFabricateReachableHosts(t *testing.T) {
	cfg := config.Default()
	cfg.Host = "127.0.0.1"
	cfg.Port = 1
	api := newParityAPI(t, &cfg)
	response := serveManagement(api, http.MethodPost, "/api/host/discover", "")
	if response.Code != http.StatusOK || strings.Contains(response.Body.String(), `"reachable":true`) {
		t.Fatalf("discovery fabricated reachability: %d %s", response.Code, response.Body.String())
	}
}
