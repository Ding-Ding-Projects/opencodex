package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/codex"
	"github.com/lidge-jun/opencodex-go/internal/config"
)

const (
	doctorWHAMURL        = "https://chatgpt.com/backend-api/wham/usage"
	doctorNetworkTimeout = 8 * time.Second
	doctorServiceTimeout = 2 * time.Second
	doctorMaxBodyBytes   = 1 << 20
)

type projectWarning struct {
	Path    string `json:"path"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

type doctorDeps struct {
	GOOS             string
	GOARCH           string
	Home             string
	Environment      []string
	Mounts           string
	WorkingDirectory string
	Now              func() time.Time
	HTTPClient       *http.Client
	LookPath         func(string) (string, error)
	CommandContext   func(context.Context, string, ...string) *exec.Cmd
	ReadRuntime      func() (int, int)
	ReadProcessEnv   func(int) ([]byte, error)
	CollectWarnings  func(string, int) ([]codex.ProjectConfigWarning, error)
	ReadFile         func(string) ([]byte, error)
	Glob             func(string) ([]string, error)
	Stat             func(string) (os.FileInfo, error)
}

func (d doctorDeps) withDefaults() doctorDeps {
	if d.GOOS == "" {
		d.GOOS = runtime.GOOS
	}
	if d.GOARCH == "" {
		d.GOARCH = runtime.GOARCH
	}
	if d.Home == "" {
		d.Home, _ = os.UserHomeDir()
	}
	if d.Environment == nil {
		d.Environment = os.Environ()
	}
	if d.Mounts == "" && d.GOOS == "linux" {
		d.Mounts = readMountTable()
	}
	if d.WorkingDirectory == "" {
		d.WorkingDirectory, _ = os.Getwd()
	}
	if d.Now == nil {
		d.Now = time.Now
	}
	if d.HTTPClient == nil {
		d.HTTPClient = &http.Client{}
	}
	if d.LookPath == nil {
		d.LookPath = exec.LookPath
	}
	if d.CommandContext == nil {
		d.CommandContext = exec.CommandContext
	}
	if d.ReadRuntime == nil {
		d.ReadRuntime = readRuntime
	}
	if d.CollectWarnings == nil {
		d.CollectWarnings = codex.CollectProjectConfigWarnings
	}
	if d.ReadFile == nil {
		d.ReadFile = os.ReadFile
	}
	if d.Glob == nil {
		d.Glob = filepath.Glob
	}
	if d.Stat == nil {
		d.Stat = os.Stat
	}
	return d
}

func collectDoctorReport(ctx context.Context, input doctorDeps) (doctorReport, error) {
	deps := input.withDefaults()
	env := environmentMap(deps.Environment)
	ocxHome, err := doctorConfigDir(env, deps.Home)
	if err != nil {
		return doctorReport{}, err
	}
	configFile := filepath.Join(ocxHome, "config.json")
	codexHome := codex.ResolveCodexHome(codex.HomeOptions{Env: env, GOOS: deps.GOOS, HomeDir: deps.Home})
	report := doctorReport{
		OS: deps.GOOS, Architecture: deps.GOARCH,
		GeneratedAt:     deps.Now().UTC().Format(time.RFC3339),
		CurrentProxyEnv: collectProxyEnvironment(env),
		ConfiguredProxy: collectConfiguredProxy(configFile, env, deps.ReadFile),
	}
	for _, row := range collectDoctorPaths(deps.Home, codexHome, ocxHome, configFile) {
		row.Filesystem = detectFilesystem(row.Path, deps.Mounts)
		report.Paths = append(report.Paths, row)
	}

	cfg, configErr := config.Load(configFile)
	if os.IsNotExist(configErr) {
		defaults := config.FreshInstall()
		cfg = &defaults
		report.add(doctorCheck{Name: "configuration", Status: doctorWarn, Detail: "config.json does not exist; defaults will be used", Hint: "Run 'ocx init' to create a provider configuration."})
	} else if configErr != nil {
		report.add(doctorCheck{Name: "configuration", Status: doctorFail, Detail: configErr.Error(), Hint: "Repair config.json before starting the proxy."})
	} else {
		report.add(doctorCheck{Name: "configuration", Status: doctorPass, Detail: "config.json parses and validates"})
	}
	appendDirectoryModeCheck(&report, ocxHome, deps)
	appendCodexAuthCheck(&report, filepath.Join(codexHome, "auth.json"))
	appendCodexRuntimeCheck(ctx, &report, deps)

	pid, port := deps.ReadRuntime()
	report.RunningProxyEnv = collectRunningProxyEnvironment(pid, deps.GOOS, deps.ReadProcessEnv)
	if cfg != nil {
		appendProxyHealthCheck(ctx, &report, cfg.Host, port)
		appendServiceMemoryCheck(ctx, &report, cfg, port, deps)
		token := strings.TrimSpace(env["OPENCODEX_API_AUTH_TOKEN"])
		if token == "" {
			token = cfg.AuthToken
		}
		appendOAuthDoctorChecks(ctx, &report, ocxHome, port, cfg, token, deps)
	}
	appendWHAMCheck(ctx, &report, filepath.Join(codexHome, "auth.json"), deps)
	appendProjectWarnings(&report, deps)
	report.WSL = collectWSLInstallDiagnostic(deps.GOOS, deps.Home, codexHome, env, deps.ReadFile)
	if report.WSL.DualInstall {
		report.add(doctorCheck{Name: "WSL dual install", Status: doctorWarn, Detail: "Linux and Windows Codex homes both contain configuration", Hint: "Treat each home as a separate login/catalog unless CODEX_HOME is explicitly shared."})
	}
	backups, _ := deps.Glob(filepath.Join(ocxHome, "*.bak"))
	report.BackupArtifacts = len(backups)
	if len(backups) > 0 {
		report.add(doctorCheck{Name: "backup artifacts", Status: doctorInfo, Detail: fmt.Sprintf("%d backup file(s)", len(backups))})
	}
	return report, nil
}

func doctorConfigDir(env map[string]string, home string) (string, error) {
	value := strings.TrimSpace(env["OPENCODEX_HOME"])
	if value == "" {
		return filepath.Join(home, ".opencodex"), nil
	}
	if value == "~" || strings.HasPrefix(value, "~/") {
		value = filepath.Join(home, strings.TrimPrefix(strings.TrimPrefix(value, "~"), "/"))
	}
	return filepath.Abs(value)
}

func appendDirectoryModeCheck(report *doctorReport, dir string, deps doctorDeps) {
	info, err := deps.Stat(dir)
	if os.IsNotExist(err) {
		report.add(doctorCheck{Name: "config directory", Status: doctorInfo, Detail: "directory will be created on first write"})
		return
	}
	if err != nil {
		report.add(doctorCheck{Name: "config directory", Status: doctorFail, Detail: err.Error()})
		return
	}
	if deps.GOOS != "windows" && info.Mode().Perm()&0o077 != 0 {
		report.add(doctorCheck{Name: "config directory permissions", Status: doctorWarn, Detail: info.Mode().Perm().String(), Hint: "Use owner-only permissions (0700) for credential-adjacent state."})
		return
	}
	report.add(doctorCheck{Name: "config directory permissions", Status: doctorPass, Detail: info.Mode().Perm().String()})
}

func appendCodexAuthCheck(report *doctorReport, path string) {
	token, ok := codex.ReadMainAccountToken(path)
	if !ok {
		report.add(doctorCheck{Name: "Codex App login", Status: doctorWarn, Detail: "no readable access token", Hint: "Run 'codex login' if OpenAI Codex account routing is required."})
		return
	}
	detail := "access token present"
	if !token.ExpiresAt.IsZero() {
		detail += "; expires " + token.ExpiresAt.UTC().Format(time.RFC3339)
	}
	report.add(doctorCheck{Name: "Codex App login", Status: doctorPass, Detail: detail})
}

func appendCodexRuntimeCheck(parent context.Context, report *doctorReport, deps doctorDeps) {
	path, err := deps.LookPath("codex")
	if err != nil {
		report.add(doctorCheck{Name: "Codex runtime", Status: doctorWarn, Detail: "codex is not on PATH", Hint: "Install @openai/codex or set CODEX_CLI_PATH for the service."})
		return
	}
	ctx, cancel := context.WithTimeout(parent, 2*time.Second)
	defer cancel()
	output, versionErr := deps.CommandContext(ctx, path, "--version").CombinedOutput()
	version := strings.TrimSpace(string(output))
	if versionErr != nil {
		report.add(doctorCheck{Name: "Codex runtime", Status: doctorWarn, Detail: path + " (version probe failed)"})
		return
	}
	report.add(doctorCheck{Name: "Codex runtime", Status: doctorPass, Detail: path + " (" + version + ")"})
}

func appendProxyHealthCheck(parent context.Context, report *doctorReport, host string, port int) {
	if port <= 0 {
		report.add(doctorCheck{Name: "proxy health", Status: doctorInfo, Detail: "proxy is not running"})
		return
	}
	ctx, cancel := context.WithTimeout(parent, doctorServiceTimeout)
	defer cancel()
	if probeHealth(ctx, host, port) {
		report.add(doctorCheck{Name: "proxy health", Status: doctorPass, Detail: fmt.Sprintf("healthy on %s:%d", host, port)})
	} else {
		report.add(doctorCheck{Name: "proxy health", Status: doctorWarn, Detail: fmt.Sprintf("runtime record exists but %s:%d is not healthy", host, port), Hint: "Run 'ocx status' and inspect service logs."})
	}
}

type serviceMemoryPayload struct {
	PID        int    `json:"pid"`
	GoVersion  string `json:"goVersion"`
	Platform   string `json:"platform"`
	RSS        uint64 `json:"rss"`
	HeapUsed   uint64 `json:"heapUsed"`
	HeapTotal  uint64 `json:"heapTotal"`
	Goroutines int    `json:"goroutines"`
	StreamMode string `json:"streamMode"`
}

func appendServiceMemoryCheck(parent context.Context, report *doctorReport, cfg *config.Config, port int, deps doctorDeps) {
	if port <= 0 {
		return
	}
	host := gracefulStopHost(cfg.Host)
	endpoint := fmt.Sprintf("http://%s:%d/api/system/memory", host, port)
	ctx, cancel := context.WithTimeout(parent, doctorServiceTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return
	}
	token := strings.TrimSpace(os.Getenv("OPENCODEX_API_AUTH_TOKEN"))
	if token == "" {
		token = cfg.AuthToken
	}
	if token != "" {
		request.Header.Set("X-OpenCodex-API-Key", token)
	}
	response, err := deps.HTTPClient.Do(request)
	if err != nil {
		report.add(doctorCheck{Name: "service memory", Status: doctorWarn, Detail: "management endpoint unreachable"})
		return
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
		report.add(doctorCheck{Name: "service memory", Status: doctorWarn, Detail: "proxy rejected management authentication", Hint: "Set OPENCODEX_API_AUTH_TOKEN to the service token."})
		return
	}
	var payload serviceMemoryPayload
	if response.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(response.Body, doctorMaxBodyBytes)).Decode(&payload) != nil || payload.PID <= 0 || payload.GoVersion == "" {
		report.add(doctorCheck{Name: "service memory", Status: doctorWarn, Detail: fmt.Sprintf("invalid management response (HTTP %d)", response.StatusCode)})
		return
	}
	detail := fmt.Sprintf("pid=%d, %s/%s, rss=%s, heap=%s, goroutines=%d, streamMode=%s", payload.PID, payload.GoVersion, payload.Platform, formatBytes(payload.RSS), formatBytes(payload.HeapUsed), payload.Goroutines, payload.StreamMode)
	status := doctorPass
	hint := ""
	if payload.RSS >= 4*1024*1024*1024 {
		status = doctorWarn
		hint = "Compare repeated doctor runs to distinguish sustained native/runtime growth from transient allocation."
	}
	report.add(doctorCheck{Name: "service memory", Status: status, Detail: detail, Hint: hint})
}

func appendWHAMCheck(parent context.Context, report *doctorReport, authPath string, deps doctorDeps) {
	ctx, cancel := context.WithTimeout(parent, doctorNetworkTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, doctorWHAMURL, nil)
	if err != nil {
		return
	}
	_, authenticated := codex.ReadMainAccountToken(authPath)
	if token, ok := codex.ReadMainAccountToken(authPath); ok {
		request.Header.Set("Authorization", "Bearer "+token.AccessToken)
		if token.ChatGPTAccountID != "" {
			request.Header.Set("ChatGPT-Account-Id", token.ChatGPTAccountID)
		}
	}
	started := deps.Now()
	response, err := deps.HTTPClient.Do(request)
	duration := deps.Now().Sub(started).Round(time.Millisecond)
	if err != nil {
		report.add(doctorCheck{Name: "WHAM reachability", Status: doctorWarn, Detail: fmt.Sprintf("connect error after %s (authenticated=%t)", duration, authenticated), Hint: "Check DNS, VPN, WSL networking, and proxy configuration; quota-based auto-switch cannot score an unreachable account."})
		return
	}
	defer response.Body.Close()
	status := doctorWarn
	if response.StatusCode >= 200 && response.StatusCode < 300 {
		status = doctorPass
	}
	report.add(doctorCheck{Name: "WHAM reachability", Status: status, Detail: fmt.Sprintf("HTTP %d in %s (authenticated=%t)", response.StatusCode, duration, authenticated)})
}

func appendProjectWarnings(report *doctorReport, deps doctorDeps) {
	warnings, err := deps.CollectWarnings(deps.WorkingDirectory, 8)
	if err != nil {
		report.add(doctorCheck{Name: "project Codex configs", Status: doctorWarn, Detail: err.Error()})
		return
	}
	if len(warnings) == 0 {
		report.add(doctorCheck{Name: "project Codex configs", Status: doctorPass, Detail: "no project-local provider bypass detected"})
		return
	}
	for _, warning := range warnings {
		report.ProjectWarnings = append(report.ProjectWarnings, projectWarning{Path: warning.Path, Code: string(warning.Code), Message: warning.Message})
	}
	report.add(doctorCheck{Name: "project Codex configs", Status: doctorWarn, Detail: fmt.Sprintf("%d provider bypass warning(s)", len(warnings)), Hint: "Remove or update project-local model_provider settings when OpenCodex routing is intended."})
}

func formatBytes(value uint64) string {
	return fmt.Sprintf("%dMB", value/(1024*1024))
}
