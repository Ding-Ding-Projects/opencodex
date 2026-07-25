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
)

const (
	DefaultMaxDownloadBytes int64 = 256 << 20
	PackageName                   = "@bitkyc08/opencodex"
)

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
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(name, s.Path)
}

type JobManager struct {
	Store  *JobStore
	Runner CommandRunner
	Now    func() time.Time
	mu     sync.Mutex
}

func (m *JobManager) Run(ctx context.Context, check CheckResult, restart bool, restartFn func(context.Context) error) (Job, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !check.CanUpdate {
		return Job{}, fmt.Errorf("update unavailable: %s", check.Reason)
	}
	if m.Store == nil {
		return Job{}, errors.New("update job store is required")
	}
	if current, err := m.Store.Read(); err == nil && (current.Status == JobRunning || current.Status == JobRestarting) {
		return Job{}, errors.New("an update job is already running")
	}
	now := time.Now
	if m.Now != nil {
		now = m.Now
	}
	started := now().UTC()
	command := InstallCommand(check.Installer, check.Channel, check.LatestVersion)
	job := Job{ID: fmt.Sprintf("%d", started.UnixNano()), Status: JobRunning, StartedAt: started, UpdatedAt: started, CurrentVersion: check.CurrentVersion, LatestVersion: check.LatestVersion, Channel: check.Channel, Installer: check.Installer, Restart: restart, Command: command.String(), Log: []string{"Update job started."}}
	if err := m.Store.Write(job); err != nil {
		return Job{}, err
	}
	runner := m.Runner
	if runner == nil {
		runner = ExecRunner{}
	}
	output, runErr := runner.Run(ctx, command)
	if text := strings.TrimSpace(string(output)); text != "" {
		job.Log = append(job.Log, text)
	}
	if runErr != nil {
		job.Status = JobFailed
		job.Error = runErr.Error()
		var exitError *exec.ExitError
		if errors.As(runErr, &exitError) {
			code := exitError.ExitCode()
			job.ExitCode = &code
		}
	} else if restart && restartFn != nil {
		job.Status = JobRestarting
		job.UpdatedAt = now().UTC()
		_ = m.Store.Write(job)
		if err := restartFn(ctx); err != nil {
			job.Status = JobFailed
			job.Error = err.Error()
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
	return job, runErr
}
