package update

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/server"
)

const (
	DefaultMaxDownloadBytes int64 = 256 << 20
	PackageName                   = "@bitkyc08/opencodex"
)

type JobError struct {
	Message string
	Status  int
	Code    string
}

func (e *JobError) Error() string     { return e.Message }
func (e *JobError) HTTPStatus() int   { return e.Status }
func (e *JobError) ErrorCode() string { return e.Code }

type JobStatus string

const (
	JobRunning    JobStatus = "running"
	JobRestarting JobStatus = "restarting"
	JobSucceeded  JobStatus = "succeeded"
	JobFailed     JobStatus = "failed"
)

type Job struct {
	ID             string    `json:"id"`
	Status         JobStatus `json:"status"`
	StartedAt      time.Time `json:"startedAt"`
	UpdatedAt      time.Time `json:"updatedAt"`
	CurrentVersion string    `json:"currentVersion"`
	LatestVersion  string    `json:"latestVersion,omitempty"`
	Channel        Channel   `json:"channel"`
	Installer      Installer `json:"installer"`
	Restart        bool      `json:"restart"`
	Command        string    `json:"command"`
	Log            []string  `json:"log"`
	Error          string    `json:"error,omitempty"`
	ExitCode       *int      `json:"exitCode,omitempty"`
	Restarted      bool      `json:"restarted,omitempty"`
}

type Command struct {
	Bin  string
	Args []string
}

func (c Command) String() string {
	if c.Bin == "" {
		return ""
	}
	return strings.Join(append([]string{c.Bin}, c.Args...), " ")
}

func InstallCommand(installer Installer, channel Channel, resolvedVersion string) Command {
	target := resolvedVersion
	if target == "" {
		target = string(channel)
	}
	switch installer {
	case InstallerBun:
		return Command{Bin: executableName("bun"), Args: []string{"add", "-g", PackageName + "@" + target}}
	case InstallerNPM:
		return Command{Bin: executableName("npm"), Args: []string{"install", "-g", PackageName + "@" + target}}
	default:
		return Command{}
	}
}

func executableName(name string) string {
	if runtime.GOOS == "windows" {
		return name + ".cmd"
	}
	return name
}

type CommandRunner interface {
	Run(context.Context, Command) ([]byte, error)
}

type ExecRunner struct{}

func (ExecRunner) Run(ctx context.Context, command Command) ([]byte, error) {
	if command.Bin == "" {
		return nil, errors.New("update command is empty")
	}
	return exec.CommandContext(ctx, command.Bin, command.Args...).CombinedOutput()
}

type Downloader struct {
	Client   *http.Client
	MaxBytes int64
}

func (d Downloader) Download(ctx context.Context, sourceURL, destination string) (int64, error) {
	parsed, err := url.ParseRequestURI(sourceURL)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil {
		return 0, errors.New("update URL must be HTTPS without user information")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return 0, err
	}
	client := d.Client
	if client == nil {
		client = http.DefaultClient
	}
	response, err := client.Do(request)
	if err != nil {
		return 0, fmt.Errorf("download update: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return 0, fmt.Errorf("download update returned %s", response.Status)
	}
	limit := d.MaxBytes
	if limit <= 0 {
		limit = DefaultMaxDownloadBytes
	}
	if response.ContentLength > limit {
		return 0, fmt.Errorf("update exceeds %d bytes", limit)
	}
	if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
		return 0, err
	}
	temporary, err := os.CreateTemp(filepath.Dir(destination), ".ocx-download-*")
	if err != nil {
		return 0, err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	written, copyErr := io.Copy(temporary, io.LimitReader(response.Body, limit+1))
	closeErr := temporary.Close()
	if copyErr != nil {
		return written, copyErr
	}
	if closeErr != nil {
		return written, closeErr
	}
	if written > limit {
		return written, fmt.Errorf("update exceeds %d bytes", limit)
	}
	if err := os.Rename(temporaryPath, destination); err != nil {
		return written, err
	}
	return written, nil
}

type JobStore struct {
	Path string
	mu   sync.Mutex
}

func (s *JobStore) Read() (*Job, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	data, err := os.ReadFile(s.Path)
	if err != nil {
		return nil, err
	}
	var job Job
	if err := json.Unmarshal(data, &job); err != nil {
		return nil, err
	}
	return &job, nil
}

func (s *JobStore) Write(job Job) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := os.MkdirAll(filepath.Dir(s.Path), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(job, "", "  ")
	if err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(s.Path), ".update-job-*")
	if err != nil {
		return err
	}
	name := temporary.Name()
	defer os.Remove(name)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(append(data, '\n')); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return atomicReplace(name, s.Path)
}

type JobManager struct {
	Store       *JobStore
	Runner      CommandRunner
	Execute     func(context.Context, CheckResult) ([]byte, error)
	Lifecycle   *LifecycleDependencies
	Now         func() time.Time
	mu          sync.Mutex
	RestartHost string
	RestartPort int
	ReclaimPort func(context.Context, string, int, server.ReclaimListenPortOptions) bool
}

func (m *JobManager) Run(ctx context.Context, check CheckResult, restart bool, restartFn func(context.Context) error) (Job, error) {
	job, err := m.begin(check, restart)
	if err != nil {
		return Job{}, err
	}
	return m.execute(ctx, job, check, restartFn)
}

// Start persists the running job before returning and completes it in the
// background. This is the management-API entry point: status survives request
// cancellation and can be recovered from Store after a process restart.
func (m *JobManager) Start(ctx context.Context, check CheckResult, restart bool, restartFn func(context.Context) error) (Job, error) {
	job, err := m.begin(check, restart)
	if err != nil {
		return Job{}, err
	}
	go func() {
		_, _ = m.execute(context.WithoutCancel(ctx), job, check, restartFn)
	}()
	return job, nil
}

// Status returns the latest persisted job. A non-empty id must match the
// persisted job, which preserves the TypeScript status endpoint contract.
func (m *JobManager) Status(id string) (Job, bool, error) {
	if m.Store == nil {
		return Job{}, false, errors.New("update job store is required")
	}
	job, err := m.Store.Read()
	if errors.Is(err, os.ErrNotExist) {
		return Job{}, false, nil
	}
	if err != nil {
		return Job{}, false, err
	}
	if id != "" && job.ID != id {
		return Job{}, false, nil
	}
	return *job, true, nil
}

func (m *JobManager) begin(check CheckResult, restart bool) (Job, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !check.CanUpdate {
		return Job{}, &JobError{Message: fmt.Sprintf("update unavailable: %s", check.Reason), Status: http.StatusConflict, Code: "update_unavailable"}
	}
	if m.Store == nil {
		return Job{}, errors.New("update job store is required")
	}
	if current, err := m.Store.Read(); err == nil && (current.Status == JobRunning || current.Status == JobRestarting) {
		return Job{}, &JobError{Message: "an update job is already running", Status: http.StatusConflict, Code: "update_already_running"}
	}
	started := m.currentTime()
	command := InstallCommand(check.Installer, check.Channel, check.LatestVersion)
	commandDisplay := strings.TrimSpace(check.Command)
	if commandDisplay == "" {
		commandDisplay = command.String()
	}
	job := Job{ID: fmt.Sprintf("%d", started.UnixNano()), Status: JobRunning, StartedAt: started, UpdatedAt: started, CurrentVersion: check.CurrentVersion, LatestVersion: check.LatestVersion, Channel: check.Channel, Installer: check.Installer, Restart: restart, Command: commandDisplay, Log: []string{"Update job started."}}
	if err := m.Store.Write(job); err != nil {
		return Job{}, err
	}
	return job, nil
}

func (m *JobManager) execute(ctx context.Context, job Job, check CheckResult, restartFn func(context.Context) error) (Job, error) {
	now := m.currentTime
	lifecycle := m.Lifecycle
	handoff := TrayHandoff{}
	if lifecycle != nil {
		if lifecycle.CheckIntegrity != nil {
			integrity := lifecycle.CheckIntegrity(ctx, check)
			switch integrity.Status {
			case IntegrityFailed:
				return m.finishFailed(job, errors.New(integrity.Reason))
			case IntegritySkipped:
				job.Log = append(job.Log, "Integrity pre-flight skipped: "+integrity.Reason)
			case IntegrityVerified:
				job.Log = append(job.Log, "Verified package integrity metadata.")
			}
		}
		if lifecycle.PrepareTray != nil {
			var err error
			handoff, err = lifecycle.PrepareTray(ctx)
			if err != nil {
				return m.finishFailed(job, fmt.Errorf("could not prepare tray before package replacement: %w", err))
			}
		}
	}
	runner := m.Runner
	if runner == nil {
		runner = ExecRunner{}
	}
	var output []byte
	var runErr error
	if m.Execute != nil {
		output, runErr = m.Execute(ctx, check)
	} else {
		output, runErr = runner.Run(ctx, InstallCommand(check.Installer, check.Channel, check.LatestVersion))
	}
	if text := strings.TrimSpace(string(output)); text != "" {
		job.Log = append(job.Log, tailJobLog(text))
	}
	resultErr := runErr
	if runErr != nil {
		job.Status = JobFailed
		job.Error = runErr.Error()
		var exitError *exec.ExitError
		if errors.As(runErr, &exitError) {
			code := exitError.ExitCode()
			job.ExitCode = &code
		}
		m.restoreTrayAfterFailure(ctx, lifecycle, handoff, &job)
	} else if lifecycle != nil {
		if handoff.RefreshAfterReplacement && lifecycle.RefreshTray != nil {
			if err := lifecycle.RefreshTray(ctx); err != nil {
				job.Log = append(job.Log, "Tray refresh failed: "+err.Error())
			}
		}
		if job.Restart {
			resultErr = m.restartWithLifecycle(ctx, &job, check, lifecycle, handoff)
		} else {
			job.Status = JobSucceeded
		}
	} else if job.Restart && restartFn != nil {
		job.Status = JobRestarting
		job.UpdatedAt = now().UTC()
		_ = m.Store.Write(job)
		if m.RestartPort > 0 {
			reclaim := m.ReclaimPort
			if reclaim == nil {
				reclaim = server.ReclaimListenPort
			}
			if !reclaim(ctx, m.RestartHost, m.RestartPort, server.ReclaimListenPortOptions{Timeout: 30 * time.Second}) {
				job.Status, job.Error = JobFailed, fmt.Sprintf("listen port %d did not become available", m.RestartPort)
				resultErr = errors.New(job.Error)
				job.UpdatedAt = now().UTC()
				_ = m.Store.Write(job)
				return job, resultErr
			}
		}
		if err := restartFn(ctx); err != nil {
			job.Status = JobFailed
			job.Error = err.Error()
			resultErr = err
		} else {
			job.Status = JobSucceeded
			job.Restarted = true
		}
	} else {
		job.Status = JobSucceeded
	}
	job.UpdatedAt = now().UTC()
	if err := m.Store.Write(job); err != nil {
		return job, err
	}
	return job, resultErr
}

func (m *JobManager) restartWithLifecycle(ctx context.Context, job *Job, check CheckResult, lifecycle *LifecycleDependencies, handoff TrayHandoff) error {
	job.Status = JobRestarting
	job.UpdatedAt = m.currentTime().UTC()
	_ = m.Store.Write(*job)
	host := lifecycle.Host
	if host == "" {
		host = "127.0.0.1"
	}
	if lifecycle.Port > 0 {
		reclaim := lifecycle.ReclaimPort
		if reclaim == nil {
			reclaim = func(ctx context.Context, host string, port int) bool {
				return server.ReclaimListenPort(ctx, host, port, server.ReclaimListenPortOptions{Timeout: 30 * time.Second})
			}
		}
		if !reclaim(ctx, host, lifecycle.Port) {
			err := fmt.Errorf("listen port %d did not become available", lifecycle.Port)
			job.Status, job.Error = JobFailed, err.Error()
			m.restoreTrayAfterFailure(ctx, lifecycle, handoff, job)
			return err
		}
	}
	plan := BuildRestartPlan(check.Installer, lifecycle.RuntimeExecutable, lifecycle.Launcher, lifecycle.ServiceInstalled, lifecycle.Port, lifecycle.ServiceArgs)
	if lifecycle.Restart == nil {
		err := errors.New("update restart dependency is required")
		job.Status, job.Error = JobFailed, err.Error()
		m.restoreTrayAfterFailure(ctx, lifecycle, handoff, job)
		return err
	}
	if err := lifecycle.Restart(ctx, plan); err != nil {
		job.Status, job.Error = JobFailed, err.Error()
		m.restoreTrayAfterFailure(ctx, lifecycle, handoff, job)
		return err
	}
	if !ConfirmRestartedProxy(ctx, lifecycle.Probe, lifecycle.StartupTimeout, lifecycle.StabilityWindow, lifecycle.ProbeInterval) {
		err := fmt.Errorf("proxy restart did not remain healthy on %s:%d", host, lifecycle.Port)
		job.Status, job.Error = JobFailed, err.Error()
		m.restoreTrayAfterFailure(ctx, lifecycle, handoff, job)
		return err
	}
	job.Status = JobSucceeded
	job.Restarted = true
	return nil
}

func (m *JobManager) restoreTrayAfterFailure(ctx context.Context, lifecycle *LifecycleDependencies, handoff TrayHandoff, job *Job) {
	if lifecycle == nil || !handoff.RestoreOnFailure || lifecycle.RestoreTray == nil {
		return
	}
	if err := lifecycle.RestoreTray(ctx); err != nil {
		job.Log = append(job.Log, "Tray restore failed: "+err.Error())
	}
}

func (m *JobManager) finishFailed(job Job, err error) (Job, error) {
	job.Status = JobFailed
	job.Error = err.Error()
	job.UpdatedAt = m.currentTime().UTC()
	if writeErr := m.Store.Write(job); writeErr != nil {
		return job, writeErr
	}
	return job, err
}

func (m *JobManager) currentTime() time.Time {
	if m.Now != nil {
		return m.Now().UTC()
	}
	return time.Now().UTC()
}

func tailJobLog(value string) string {
	const limit = 4000
	if len(value) <= limit {
		return value
	}
	value = value[len(value)-limit:]
	for len(value) > 0 && value[0]&0xc0 == 0x80 {
		value = value[1:]
	}
	return value
}
