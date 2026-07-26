package update

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/server"
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

func TestJobManagerStartPersistsBeforeReturnRejectsConflictAndRecoversStatus(t *testing.T) {
	check := CheckResult{CurrentVersion: "1.0.0", LatestVersion: "1.1.0", Channel: ChannelLatest, Installer: InstallerNPM, CanUpdate: true}
	store := &JobStore{Path: filepath.Join(t.TempDir(), "update-job.json")}
	started := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	manager := &JobManager{Store: store, Execute: func(context.Context, CheckResult) ([]byte, error) {
		once.Do(func() { close(started) })
		<-release
		return []byte(strings.Repeat("x", 5000)), nil
	}}
	job, err := manager.Start(context.Background(), check, false, nil)
	if err != nil || job.Status != JobRunning {
		t.Fatalf("Start() = %#v, %v", job, err)
	}
	if persisted, found, err := manager.Status(job.ID); err != nil || !found || persisted.Status != JobRunning {
		t.Fatalf("running status = %#v, %t, %v", persisted, found, err)
	}
	<-started
	if _, err := manager.Start(context.Background(), check, false, nil); err == nil || !strings.Contains(err.Error(), "already running") {
		t.Fatalf("concurrent Start() error = %v", err)
	}
	close(release)
	deadline := time.Now().Add(2 * time.Second)
	for {
		persisted, found, statusErr := manager.Status("")
		if statusErr != nil || !found {
			t.Fatalf("final status = %#v, %t, %v", persisted, found, statusErr)
		}
		if persisted.Status == JobSucceeded {
			if len(persisted.Log) != 2 || len(persisted.Log[1]) != 4000 {
				t.Fatalf("bounded log lengths = %d, %#v", len(persisted.Log), persisted.Log)
			}
			if _, found, err := manager.Status("different-job"); err != nil || found {
				t.Fatalf("mismatched status found=%t err=%v", found, err)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("job did not finish: %#v", persisted)
		}
		time.Sleep(time.Millisecond)
	}
}

func TestJobManagerReturnsRestartFailure(t *testing.T) {
	check := CheckResult{CurrentVersion: "1.0.0", LatestVersion: "1.1.0", Channel: ChannelLatest, Installer: InstallerNPM, CanUpdate: true}
	manager := &JobManager{Store: &JobStore{Path: filepath.Join(t.TempDir(), "job.json")}, Runner: fakeRunner{}}
	job, err := manager.Run(context.Background(), check, true, func(context.Context) error { return errors.New("restart failed") })
	if err == nil || job.Status != JobFailed || job.Error != "restart failed" {
		t.Fatalf("restart failure = %#v, %v", job, err)
	}
}

func TestJobManagerReclaimsPortBeforeRestart(t *testing.T) {
	check := CheckResult{CurrentVersion: "1.0.0", LatestVersion: "1.1.0", Channel: ChannelLatest, Installer: InstallerNPM, CanUpdate: true}
	order := []string{}
	manager := &JobManager{
		Store: &JobStore{Path: filepath.Join(t.TempDir(), "job.json")}, Runner: fakeRunner{}, RestartHost: "127.0.0.1", RestartPort: 10100,
		ReclaimPort: func(context.Context, string, int, server.ReclaimListenPortOptions) bool {
			order = append(order, "reclaim")
			return true
		},
	}
	job, err := manager.Run(context.Background(), check, true, func(context.Context) error { order = append(order, "restart"); return nil })
	if err != nil || !job.Restarted || strings.Join(order, ",") != "reclaim,restart" {
		t.Fatalf("job=%#v err=%v order=%v", job, err, order)
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
