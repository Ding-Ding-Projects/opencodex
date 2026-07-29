package management

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/config"
)

func storageAPI(t *testing.T, home string) (*API, *config.Config) {
	t.Helper()
	cfg := config.Default()
	api := newParityAPI(t, &cfg, func(options *Options) { options.StorageHome = home })
	return api, &cfg
}

// The preview identifies a machine to itself but must not say so on the wire: codexHome and
// absPath are host paths, and count/bytes/digest already bind the full selection.
func TestCleanupPreviewOmitsHostPaths(t *testing.T) {
	home := t.TempDir()
	sessions := filepath.Join(home, "archived_sessions")
	if err := os.MkdirAll(sessions, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sessions, "rollout-2026-01-01T00-00-00-abc.jsonl"), []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	api, _ := storageAPI(t, home)
	response := serveManagement(api, http.MethodPost, "/api/storage/cleanup/preview", `{"percent":100}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"codexHome", "CodexHome", "absPath"} {
		if _, present := body[forbidden]; present {
			t.Fatalf("preview leaked %q: %s", forbidden, response.Body.String())
		}
	}
	for _, required := range []string{"percent", "count", "bytes", "digest", "candidates"} {
		if _, present := body[required]; !present {
			t.Fatalf("preview missing %q: %s", required, response.Body.String())
		}
	}
	candidates, _ := body["candidates"].([]any)
	if len(candidates) == 0 {
		t.Fatalf("no candidates: %s", response.Body.String())
	}
	candidate, _ := candidates[0].(map[string]any)
	if _, leaked := candidate["absPath"]; leaked {
		t.Fatalf("candidate leaked absPath: %s", response.Body.String())
	}
	if _, ok := candidate["relPath"]; !ok {
		t.Fatalf("candidate shape = %v", candidate)
	}
}

func TestCleanupPreviewRejectsAPercentOutsideTheRange(t *testing.T) {
	api, _ := storageAPI(t, t.TempDir())
	for _, body := range []string{`{"percent":-1}`, `{"percent":101}`, `{}`} {
		response := serveManagement(api, http.MethodPost, "/api/storage/cleanup/preview", body)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("body %s => status %d", body, response.Code)
		}
	}
}

// The policy round-trips through the config passthrough, so a Go build preserves a key it
// does not model as a typed field.
func TestCleanupPolicyRoundTrips(t *testing.T) {
	api, cfg := storageAPI(t, t.TempDir())

	first := serveManagement(api, http.MethodGet, "/api/storage/cleanup-policy", "")
	if first.Code != http.StatusOK {
		t.Fatalf("default policy status=%d body=%s", first.Code, first.Body.String())
	}
	var defaults map[string]any
	if err := json.Unmarshal(first.Body.Bytes(), &defaults); err != nil {
		t.Fatal(err)
	}
	if defaults["enabled"] != false {
		t.Fatalf("default policy should be off: %s", first.Body.String())
	}

	saved := serveManagement(api, http.MethodPut, "/api/storage/cleanup-policy",
		`{"enabled":true,"trigger":{"archivedBytesOver":1073741824},"target":{"removeOldestPercent":10},"schedule":"manual","mode":"quarantine"}`)
	if saved.Code != http.StatusOK {
		t.Fatalf("save status=%d body=%s", saved.Code, saved.Body.String())
	}
	if _, stored := cfg.ExtraFields["storageCleanupPolicy"]; !stored {
		t.Fatal("policy was not persisted into the config passthrough")
	}

	reread := serveManagement(api, http.MethodGet, "/api/storage/cleanup-policy", "")
	var policy map[string]any
	if err := json.Unmarshal(reread.Body.Bytes(), &policy); err != nil {
		t.Fatal(err)
	}
	if policy["enabled"] != true {
		t.Fatalf("policy did not round-trip: %s", reread.Body.String())
	}
}

// A quarantine stage with neither files nor a manifest is a collision placeholder; listing it
// would offer a restore with nothing to restore.
func TestTrashListingSkipsEmptyPlaceholders(t *testing.T) {
	home := t.TempDir()
	trash := filepath.Join(home, ".trash")
	if err := os.MkdirAll(filepath.Join(trash, "1700000000000-abc"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(trash, "1700000001000-def"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(trash, "1700000001000-def", "manifest.json"), []byte(`{"quarantinedAt":1700000001000,"mode":"quarantine","entries":[]}`), 0o600); err != nil {
		t.Fatal(err)
	}

	api, _ := storageAPI(t, home)
	response := serveManagement(api, http.MethodGet, "/api/storage/trash", "")
	var body struct {
		Entries []map[string]any `json:"entries"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Entries) != 1 || body.Entries[0]["epoch"] != "1700000001000-def" {
		t.Fatalf("entries = %v", body.Entries)
	}
}
