package server

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	appconfig "github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/usage"
)

func TestProductionUsageSnapshotRebuildDoesNotBlockHealthz(t *testing.T) {
	path := filepath.Join(t.TempDir(), "usage.jsonl")
	line := []byte(`{"requestId":"large","timestamp":1,"provider":"p","model":"m","status":200,"durationMs":1,"usageStatus":"reported"}` + "\n")
	if err := os.WriteFile(path, bytes.Repeat(line, 200_000), 0o600); err != nil {
		t.Fatal(err)
	}
	log := usage.NewLog(path)
	cfg := appconfig.Default()
	proxy := New(Config{UsageRecorder: log, ManagementConfig: &cfg})
	defer proxy.Close()

	usageDone := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		response := httptest.NewRecorder()
		proxy.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/usage?range=all", nil))
		usageDone <- response
	}()

	deadline := time.Now().Add(5 * time.Second)
	for log.SnapshotStatsForTests().RetainedCall == 0 {
		select {
		case response := <-usageDone:
			t.Fatalf("usage rebuild completed before its production snapshot became observable: %d %s", response.Code, response.Body.String())
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("production usage route did not enter snapshot rebuild")
		}
	}

	healthDone := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		response := httptest.NewRecorder()
		proxy.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/healthz", nil))
		healthDone <- response
	}()
	select {
	case response := <-healthDone:
		if response.Code != http.StatusOK {
			t.Fatalf("healthz response = %d %s", response.Code, response.Body.String())
		}
	case <-time.After(time.Second):
		t.Fatal("healthz blocked behind a production usage rebuild")
	}

	select {
	case response := <-usageDone:
		if response.Code != http.StatusOK {
			t.Fatalf("usage response = %d %s", response.Code, response.Body.String())
		}
	case <-time.After(20 * time.Second):
		t.Fatal("production usage rebuild did not complete")
	}
	if stats := log.SnapshotStatsForTests(); stats.FullReads != 1 || stats.RetainedCall != 0 {
		t.Fatalf("production usage route bypassed snapshot owner: %#v", stats)
	}
}
