package update

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type fakeRunner struct{ err error }

func (f fakeRunner) Run(context.Context, Command) ([]byte, error) { return []byte("installed"), f.err }

func TestJobManagerPersistsSuccessAndFailure(t *testing.T) {
	check := CheckResult{CurrentVersion: "1.0.0", LatestVersion: "1.1.0", Channel: ChannelLatest, Installer: InstallerNPM, CanUpdate: true}
	store := &JobStore{Path: filepath.Join(t.TempDir(), "update-job.json")}
	manager := &JobManager{Store: store, Runner: fakeRunner{}}
	job, err := manager.Run(context.Background(), check, true, func(context.Context) error { return nil })
	if err != nil || job.Status != JobSucceeded || !job.Restarted {
		t.Fatalf("success job = %#v, err = %v", job, err)
	}
	manager.Runner = fakeRunner{err: errors.New("install failed")}
	job, err = manager.Run(context.Background(), check, false, nil)
	if err == nil || job.Status != JobFailed || !strings.Contains(job.Error, "install failed") {
		t.Fatalf("failure job = %#v, err = %v", job, err)
	}
}

func TestDownloaderBoundsAndWritesAtomically(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("binary")) }))
	defer server.Close()
	destination := filepath.Join(t.TempDir(), "download", "ocx")
	written, err := (Downloader{Client: server.Client(), MaxBytes: 16}).Download(context.Background(), server.URL, destination)
	if err != nil || written != 6 {
		t.Fatalf("Download() = %d, %v", written, err)
	}
	if data, err := os.ReadFile(destination); err != nil || string(data) != "binary" {
		t.Fatalf("downloaded file = %q, %v", data, err)
	}
	_, err = (Downloader{Client: server.Client(), MaxBytes: 3}).Download(context.Background(), server.URL, destination)
	if err == nil || !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("oversize error = %v", err)
	}
}
