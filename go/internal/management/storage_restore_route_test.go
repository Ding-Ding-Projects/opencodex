package management

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"

)

// quarantineForRoute stages a rollout the way a cleanup would, so the route can
// be driven against a stage that really exists.
func quarantineForRoute(t *testing.T, home, name string) string {
	t.Helper()
	archived := filepath.Join(home, "archived_sessions")
	if err := os.MkdirAll(archived, 0o755); err != nil {
		t.Fatal(err)
	}
	original := filepath.Join(archived, name)
	stage := filepath.Join(home, ".trash", "1700000000")
	if err := os.MkdirAll(stage, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stage, name), []byte("quarantined body"), 0o600); err != nil {
		t.Fatal(err)
	}
	relPath := "archived_sessions/" + name
	manifest, err := json.Marshal(map[string]any{
		"quarantinedAt": 1700000000,
		"mode":          "quarantine",
		"entries": []map[string]any{{
			"relPath": relPath, "bytes": 16, "mtimeMs": 1700000000000,
			"physicalRelPaths": []string{relPath},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stage, "manifest.json"), manifest, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stage, "satellite-backup.json"), []byte(`{"threadIds":[]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	return original
}

// The route existed only in the oracle: Go answered 404, so the dashboard's
// Restore button could not work at all.
func TestRestoreRouteReturnsTheFile(t *testing.T) {
	home := t.TempDir()
	original := quarantineForRoute(t, home, "rollout-2026-01-01T00-00-00-aaaa.jsonl")
	api, _ := storageAPI(t, home)

	response := serveManagement(api, http.MethodPost, "/api/storage/trash/restore", `{"id":".trash/1700000000"}`)

	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	body, err := os.ReadFile(original)
	if err != nil || string(body) != "quarantined body" {
		t.Fatalf("file was not restored: %q (%v)", body, err)
	}
}

// Each failure maps to its own status, because they ask the user for different
// things: fix the id, accept it is gone, or retry later.
func TestRestoreRouteMapsFailuresToDistinctStatuses(t *testing.T) {
	cases := []struct {
		name string
		body string
		want int
	}{
		{name: "missing id", body: `{}`, want: http.StatusBadRequest},
		{name: "blank id", body: `{"id":"   "}`, want: http.StatusBadRequest},
		{name: "unknown stage", body: `{"id":".trash/1700000000"}`, want: http.StatusNotFound},
		{name: "traversing id", body: `{"id":".trash/../../etc"}`, want: http.StatusBadRequest},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			api, _ := storageAPI(t, t.TempDir())
			response := serveManagement(api, http.MethodPost, "/api/storage/trash/restore", test.body)
			if response.Code != test.want {
				t.Fatalf("status=%d want=%d body=%s", response.Code, test.want, response.Body.String())
			}
		})
	}
}
