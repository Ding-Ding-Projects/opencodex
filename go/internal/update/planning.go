package update

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var sha512IntegrityPattern = regexp.MustCompile(`^sha512-[A-Za-z0-9+/=]+$`)

// DetectInstaller infers the package manager from the running module path.
func DetectInstaller(modulePath string) Installer {
	normalized := filepath.ToSlash(modulePath)
	if !strings.Contains(normalized, "/node_modules/") {
		return InstallerSource
	}
	if strings.Contains(normalized, "/.bun/") || strings.Contains(normalized, "/.bun/install/") {
		return InstallerBun
	}
	return InstallerNPM
}

func ReadPackageVersion(packageJSONPath string) (string, error) {
	data, err := os.ReadFile(packageJSONPath)
	if err != nil {
		return "", err
	}
	var manifest struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(data, &manifest); err != nil {
		return "", fmt.Errorf("decode package version: %w", err)
	}
	if strings.TrimSpace(manifest.Version) == "" {
		return "", errors.New("package version is missing")
	}
	return strings.TrimSpace(manifest.Version), nil
}

func HistoryRestoreIncomplete(configDir string) bool {
	entries, err := os.ReadDir(configDir)
	if err != nil {
		return false
	}
	for _, entry := range entries {
		name := entry.Name()
		if !entry.IsDir() && strings.HasPrefix(name, "codex-history-backup-") && strings.HasSuffix(name, ".json") {
			return true
		}
	}
	return false
}

type IntegrityStatus string

const (
	IntegrityVerified IntegrityStatus = "verified"
	IntegrityFailed   IntegrityStatus = "failed"
	IntegritySkipped  IntegrityStatus = "skipped"
)

type IntegrityResult struct {
	Status    IntegrityStatus
	Integrity string
	Reason    string
}

// ParseIntegrityResult separates transient registry lookup failures from
// successful queries that return anomalous integrity metadata.
func ParseIntegrityResult(version, output string, queryErr error) IntegrityResult {
	if strings.TrimSpace(version) == "" {
		return IntegrityResult{Status: IntegritySkipped, Reason: "no resolved version"}
	}
	if queryErr != nil {
		return IntegrityResult{Status: IntegritySkipped, Reason: "registry integrity query failed"}
	}
	cleaned := strings.NewReplacer(`"`, "", `'`, "").Replace(strings.TrimSpace(output))
	for _, token := range strings.Fields(cleaned) {
		if sha512IntegrityPattern.MatchString(token) {
			return IntegrityResult{Status: IntegrityVerified, Integrity: token}
		}
	}
	return IntegrityResult{Status: IntegrityFailed, Reason: fmt.Sprintf("registry returned no sha512 integrity for %s@%s", PackageName, version)}
}

func ManualSourceCommand() string { return "git pull && bun install && bun run build:gui" }

func IsSourceBuildVersion(version string) bool { return strings.TrimSpace(version) == "0.0.0" }

type RestartMode string

const (
	RestartService RestartMode = "service"
	RestartProxy   RestartMode = "proxy"
)

type RestartPlan struct {
	Mode    RestartMode
	Command Command
}

// BuildRestartPlan avoids shell shims and pins the captured port for a direct
// proxy restart. The captured port is authoritative after update teardown has
// removed runtime state.
func BuildRestartPlan(installer Installer, runtimeExecutable, launcher string, serviceInstalled bool, port int, serviceArgs []string) RestartPlan {
	mode := RestartProxy
	args := []string{launcher, "start"}
	if port > 0 {
		args = append(args, "--port", fmt.Sprint(port))
	}
	if serviceInstalled {
		mode = RestartService
		if len(serviceArgs) == 0 {
			serviceArgs = []string{"service", "install"}
		}
		args = append([]string{launcher}, serviceArgs...)
	}
	bin := runtimeExecutable
	if installer == InstallerNPM {
		bin = executableName("node")
	}
	return RestartPlan{Mode: mode, Command: Command{Bin: bin, Args: args}}
}

// ConfirmRestartedProxy requires the proxy to become healthy and remain so for
// a stability window. A single successful probe is not restart proof.
func ConfirmRestartedProxy(ctx context.Context, probe func(context.Context) bool, startupTimeout, stabilityWindow, interval time.Duration) bool {
	if ctx == nil {
		ctx = context.Background()
	}
	if probe == nil {
		return false
	}
	if startupTimeout <= 0 {
		startupTimeout = 15 * time.Second
	}
	if stabilityWindow < 0 {
		stabilityWindow = 0
	}
	if interval <= 0 {
		interval = 250 * time.Millisecond
	}
	startup := time.NewTimer(startupTimeout)
	defer startup.Stop()
	for {
		if probe(ctx) {
			break
		}
		select {
		case <-ctx.Done():
			return false
		case <-startup.C:
			return false
		case <-time.After(interval):
		}
	}
	if stabilityWindow == 0 {
		return true
	}
	stable := time.NewTimer(stabilityWindow)
	defer stable.Stop()
	for {
		select {
		case <-ctx.Done():
			return false
		case <-stable.C:
			return true
		case <-time.After(interval):
			if !probe(ctx) {
				return false
			}
		}
	}
}
