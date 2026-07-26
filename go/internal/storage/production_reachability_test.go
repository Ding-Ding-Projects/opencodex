package storage_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	appconfig "github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/server"
	"github.com/lidge-jun/opencodex-go/internal/storage"
)

func TestProductionStorageRouteUsesCanonicalScanner(t *testing.T) {
	home := t.TempDir()
	if err := os.MkdirAll(filepath.Join(home, "sessions"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "sessions", "turn.jsonl"), []byte("turn\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := appconfig.Default()
	proxy := server.New(server.Config{ManagementConfig: &cfg, StorageHome: home})
	defer proxy.Close()

	response := httptest.NewRecorder()
	proxy.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/storage", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("storage route = %d %s", response.Code, response.Body.String())
	}
	var report storage.Report
	if err := json.Unmarshal(response.Body.Bytes(), &report); err != nil {
		t.Fatal(err)
	}
	if report.CodexHome != home || report.Total.Bytes != 5 || report.Total.FileCount != 1 {
		t.Fatalf("production storage report = %#v", report)
	}
	for _, bucket := range report.Buckets {
		if bucket.Key == storage.BucketSessions {
			if bucket.Bytes != 5 || bucket.FileCount != 1 || len(bucket.Largest) != 1 || bucket.Largest[0].Path != "sessions/turn.jsonl" {
				t.Fatalf("production sessions bucket = %#v", bucket)
			}
			return
		}
	}
	t.Fatal("production storage report omitted sessions bucket")
}
