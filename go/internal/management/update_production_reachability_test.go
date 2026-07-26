package management_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/config"
	. "github.com/lidge-jun/opencodex-go/internal/management"
	"github.com/lidge-jun/opencodex-go/internal/update"
)

type productionUpdateBackend struct {
	manager *update.JobManager
	check   update.CheckResult
}

func (*productionUpdateBackend) StartupHealth(context.Context) (map[string]any, error) {
	return nil, nil
}
func (*productionUpdateBackend) RunStartupAction(context.Context, string) (string, error) {
	return "", nil
}
func (*productionUpdateBackend) WindowsTray(context.Context, string) (map[string]any, error) {
	return nil, nil
}
func (*productionUpdateBackend) SyncModels(context.Context) (map[string]any, error) { return nil, nil }
func (b *productionUpdateBackend) CheckUpdate(context.Context, string) (map[string]any, error) {
	return map[string]any{"canUpdate": b.check.CanUpdate}, nil
}
func (b *productionUpdateBackend) StartUpdate(ctx context.Context, _ string, restart bool) (map[string]any, error) {
	job, err := b.manager.Start(ctx, b.check, restart, nil)
	return productionJobMap(job), err
}
func (b *productionUpdateBackend) UpdateStatus(_ context.Context, id string) (map[string]any, bool, error) {
	job, found, err := b.manager.Status(id)
	return productionJobMap(job), found, err
}

func productionJobMap(job update.Job) map[string]any {
	return map[string]any{"id": job.ID, "status": string(job.Status), "error": job.Error, "restarted": job.Restarted}
}

func productionUpdateAPI(t *testing.T, manager *update.JobManager) *API {
	t.Helper()
	cfg := config.Default()
	backend := &productionUpdateBackend{manager: manager, check: update.CheckResult{
		CurrentVersion: "1.0.0", LatestVersion: "1.1.0", Channel: update.ChannelLatest,
		Installer: update.InstallerNPM, CanUpdate: true, UpdateAvailable: true,
	}}
	api, err := New(Options{Config: &cfg, RuntimeControl: backend})
	if err != nil {
		t.Fatal(err)
	}
	return api
}

func serveManagement(api *API, method, target, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	response := httptest.NewRecorder()
	api.ServeHTTP(response, request)
	return response
}

func startProductionUpdate(t *testing.T, api *API, restart bool) string {
	t.Helper()
	response := serveManagement(api, http.MethodPost, "/api/update/run", `{"tag":"latest","restart":`+map[bool]string{true: "true", false: "false"}[restart]+`}`)
	if response.Code != http.StatusOK {
		t.Fatalf("start update = %d %s", response.Code, response.Body.String())
	}
	var body struct {
		Job struct {
			ID string `json:"id"`
		} `json:"job"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || body.Job.ID == "" {
		t.Fatalf("decode start response = %v, %s", err, response.Body.String())
	}
	return body.Job.ID
}

func awaitProductionUpdate(t *testing.T, api *API, id string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		response := serveManagement(api, http.MethodGet, "/api/update/status?jobId="+id, "")
		if response.Code != http.StatusOK {
			t.Fatalf("status update = %d %s", response.Code, response.Body.String())
		}
		var body struct {
			Job map[string]any `json:"job"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if body.Job["status"] != string(update.JobRunning) && body.Job["status"] != string(update.JobRestarting) {
			return body.Job
		}
		if time.Now().After(deadline) {
			t.Fatalf("update did not finish: %#v", body.Job)
		}
		time.Sleep(time.Millisecond)
	}
}

func TestProductionManagementUpdateActivatesLifecyclePolicies(t *testing.T) {
	newManager := func(t *testing.T, lifecycle *update.LifecycleDependencies, execute func(context.Context, update.CheckResult) ([]byte, error)) *update.JobManager {
		t.Helper()
		return &update.JobManager{Store: &update.JobStore{Path: filepath.Join(t.TempDir(), "update-job.json")}, Lifecycle: lifecycle, Execute: execute}
	}

	t.Run("conflict", func(t *testing.T) {
		started, release := make(chan struct{}), make(chan struct{})
		var once sync.Once
		manager := newManager(t, nil, func(context.Context, update.CheckResult) ([]byte, error) {
			once.Do(func() { close(started) })
			<-release
			return nil, nil
		})
		api := productionUpdateAPI(t, manager)
		_ = startProductionUpdate(t, api, false)
		<-started
		conflict := serveManagement(api, http.MethodPost, "/api/update/run", `{"tag":"latest","restart":false}`)
		close(release)
		if conflict.Code != http.StatusConflict || !strings.Contains(conflict.Body.String(), "update_already_running") {
			t.Fatalf("conflict = %d %s", conflict.Code, conflict.Body.String())
		}
	})

	t.Run("anomalous integrity", func(t *testing.T) {
		executed := false
		manager := newManager(t, &update.LifecycleDependencies{CheckIntegrity: func(context.Context, update.CheckResult) update.IntegrityResult {
			return update.IntegrityResult{Status: update.IntegrityFailed, Reason: "registry returned no sha512 integrity"}
		}}, func(context.Context, update.CheckResult) ([]byte, error) { executed = true; return nil, nil })
		api := productionUpdateAPI(t, manager)
		job := awaitProductionUpdate(t, api, startProductionUpdate(t, api, false))
		if job["status"] != string(update.JobFailed) || executed || !strings.Contains(job["error"].(string), "sha512") {
			t.Fatalf("integrity job = %#v executed=%t", job, executed)
		}
	})

	t.Run("tray stop failure", func(t *testing.T) {
		executed := false
		manager := newManager(t, &update.LifecycleDependencies{PrepareTray: func(context.Context) (update.TrayHandoff, error) {
			return update.TrayHandoff{}, errors.New("tray still running")
		}}, func(context.Context, update.CheckResult) ([]byte, error) { executed = true; return nil, nil })
		api := productionUpdateAPI(t, manager)
		job := awaitProductionUpdate(t, api, startProductionUpdate(t, api, false))
		if job["status"] != string(update.JobFailed) || executed || !strings.Contains(job["error"].(string), "tray") {
			t.Fatalf("tray job = %#v executed=%t", job, executed)
		}
	})

	for _, serviceInstalled := range []bool{false, true} {
		name := map[bool]string{false: "direct proxy restart", true: "service restart"}[serviceInstalled]
		t.Run(name, func(t *testing.T) {
			var plan update.RestartPlan
			refreshes := 0
			lifecycle := &update.LifecycleDependencies{
				PrepareTray: func(context.Context) (update.TrayHandoff, error) {
					return update.TrayHandoff{RestoreOnFailure: true, RefreshAfterReplacement: true}, nil
				},
				RefreshTray:       func(context.Context) error { refreshes++; return nil },
				RuntimeExecutable: "/runtime/ocx", Launcher: "/pkg/cli", ServiceInstalled: serviceInstalled,
				ServiceArgs: []string{"service", "install", "--native"}, Host: "127.0.0.1", Port: 12000,
				ReclaimPort: func(context.Context, string, int) bool { return true },
				Restart:     func(_ context.Context, got update.RestartPlan) error { plan = got; return nil },
				Probe:       func(context.Context) bool { return true }, StabilityWindow: 0,
			}
			manager := newManager(t, lifecycle, func(context.Context, update.CheckResult) ([]byte, error) { return []byte("installed"), nil })
			api := productionUpdateAPI(t, manager)
			job := awaitProductionUpdate(t, api, startProductionUpdate(t, api, true))
			wantMode := update.RestartProxy
			if serviceInstalled {
				wantMode = update.RestartService
			}
			commandMatches := strings.Contains(plan.Command.String(), "12000")
			if serviceInstalled {
				commandMatches = strings.Contains(plan.Command.String(), "service install --native")
			}
			if job["status"] != string(update.JobSucceeded) || job["restarted"] != true || refreshes != 1 || plan.Mode != wantMode || !commandMatches {
				t.Fatalf("restart job=%#v refreshes=%d plan=%#v", job, refreshes, plan)
			}
		})
	}

	t.Run("port refusal restores tray", func(t *testing.T) {
		restores, restarts := 0, 0
		lifecycle := &update.LifecycleDependencies{
			PrepareTray: func(context.Context) (update.TrayHandoff, error) {
				return update.TrayHandoff{RestoreOnFailure: true}, nil
			},
			RestoreTray: func(context.Context) error { restores++; return nil }, Host: "127.0.0.1", Port: 12000,
			ReclaimPort: func(context.Context, string, int) bool { return false },
			Restart:     func(context.Context, update.RestartPlan) error { restarts++; return nil },
		}
		manager := newManager(t, lifecycle, func(context.Context, update.CheckResult) ([]byte, error) { return nil, nil })
		api := productionUpdateAPI(t, manager)
		job := awaitProductionUpdate(t, api, startProductionUpdate(t, api, true))
		if job["status"] != string(update.JobFailed) || restores != 1 || restarts != 0 || !strings.Contains(job["error"].(string), "12000") {
			t.Fatalf("port refusal job=%#v restores=%d restarts=%d", job, restores, restarts)
		}
	})

	t.Run("flapping health restores tray and persists terminal status", func(t *testing.T) {
		probes, restores := 0, 0
		path := filepath.Join(t.TempDir(), "update-job.json")
		lifecycle := &update.LifecycleDependencies{
			PrepareTray: func(context.Context) (update.TrayHandoff, error) {
				return update.TrayHandoff{RestoreOnFailure: true}, nil
			},
			RestoreTray: func(context.Context) error { restores++; return nil }, Host: "127.0.0.1", Port: 12000,
			ReclaimPort:    func(context.Context, string, int) bool { return true },
			Restart:        func(context.Context, update.RestartPlan) error { return nil },
			Probe:          func(context.Context) bool { probes++; return probes == 1 },
			StartupTimeout: 20 * time.Millisecond, StabilityWindow: 20 * time.Millisecond, ProbeInterval: time.Millisecond,
		}
		manager := &update.JobManager{Store: &update.JobStore{Path: path}, Lifecycle: lifecycle, Execute: func(context.Context, update.CheckResult) ([]byte, error) { return nil, nil }}
		api := productionUpdateAPI(t, manager)
		id := startProductionUpdate(t, api, true)
		job := awaitProductionUpdate(t, api, id)
		if job["status"] != string(update.JobFailed) || restores != 1 || !strings.Contains(job["error"].(string), "remain healthy") {
			t.Fatalf("flapping job=%#v restores=%d probes=%d", job, restores, probes)
		}
		recreated := productionUpdateAPI(t, &update.JobManager{Store: &update.JobStore{Path: path}})
		persisted := awaitProductionUpdate(t, recreated, id)
		if persisted["status"] != string(update.JobFailed) || persisted["error"] != job["error"] {
			t.Fatalf("persisted=%#v original=%#v", persisted, job)
		}
	})
}
