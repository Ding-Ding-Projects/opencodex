package update

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
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
