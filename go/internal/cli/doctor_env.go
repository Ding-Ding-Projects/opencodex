package cli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/codex"
)

var proxyEnvironmentKeys = []string{"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"}

type doctorPath struct {
	Label      string         `json:"label"`
	Path       string         `json:"path"`
	Exists     bool           `json:"exists"`
	Filesystem filesystemInfo `json:"filesystem"`
}

type filesystemInfo struct {
	Type       string `json:"type"`
	Mount      string `json:"mount,omitempty"`
	WindowsFS  bool   `json:"windowsFilesystem"`
	MountDrive bool   `json:"windowsMountDrive"`
}

type proxyEnvironment struct {
	Key     string `json:"key"`
	Present bool   `json:"present"`
}

type runningProxyEnvironment struct {
	Status string             `json:"status"`
	PID    int                `json:"pid,omitempty"`
	Reason string             `json:"reason,omitempty"`
	Rows   []proxyEnvironment `json:"rows"`
}

type configuredProxy struct {
	Present    bool   `json:"present"`
	Configured bool   `json:"configured"`
	Detail     string `json:"detail"`
}

type wslInstallDiagnostic struct {
	WSL                bool     `json:"wsl"`
	AutomountRoot      string   `json:"automountRoot"`
	EffectiveCodexHome string   `json:"effectiveCodexHome"`
	EffectiveOnWindows bool     `json:"effectiveOnWindowsMount"`
	LinuxConfigured    bool     `json:"linuxConfigured"`
	WindowsCodexHomes  []string `json:"windowsCodexHomes"`
	DualInstall        bool     `json:"dualInstall"`
}

func collectDoctorPaths(home, codexHome, ocxHome, configFile string) []doctorPath {
	if codexHome == "" {
		codexHome = codex.ResolveCodexHome(codex.HomeOptions{HomeDir: home})
	}
	return []doctorPath{
		pathStatus("CODEX_HOME", codexHome),
		pathStatus("CODEX_HOME/auth.json", filepath.Join(codexHome, "auth.json")),
		pathStatus("OPENCODEX_HOME", ocxHome),
		pathStatus("OPENCODEX_HOME/config.json", configFile),
	}
}

func pathStatus(label, path string) doctorPath {
	_, err := os.Stat(path)
	return doctorPath{Label: label, Path: path, Exists: err == nil}
}

func detectFilesystem(path, mounts string) filesystemInfo {
	mountDrive := isWindowsMountPath(path)
	if mounts == "" {
		return filesystemInfo{Type: "n/a", MountDrive: mountDrive}
	}
	bestMount, bestType := "", ""
	for _, line := range strings.Split(mounts, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		mount := decodeMountField(fields[1])
		if path != mount && mount != "/" && !strings.HasPrefix(path, strings.TrimRight(mount, "/")+"/") {
			continue
		}
		if len(mount) > len(bestMount) {
			bestMount, bestType = mount, fields[2]
		}
	}
	if bestType == "" {
		bestType = "unknown"
	}
	return filesystemInfo{Type: bestType, Mount: bestMount, WindowsFS: bestType == "drvfs" || bestType == "9p", MountDrive: mountDrive}
}

func decodeMountField(value string) string {
	replacer := strings.NewReplacer(`\040`, " ", `\011`, "\t", `\134`, `\`)
	return replacer.Replace(value)
}

func isWindowsMountPath(path string) bool {
	parts := strings.Split(strings.TrimPrefix(filepath.ToSlash(path), "/"), "/")
	return len(parts) >= 2 && parts[0] == "mnt" && len(parts[1]) == 1 && ((parts[1][0] >= 'a' && parts[1][0] <= 'z') || (parts[1][0] >= 'A' && parts[1][0] <= 'Z'))
}

func collectProxyEnvironment(env map[string]string) []proxyEnvironment {
	rows := make([]proxyEnvironment, 0, len(proxyEnvironmentKeys))
	for _, key := range proxyEnvironmentKeys {
		value := strings.TrimSpace(env[key])
		if value == "" {
			value = strings.TrimSpace(env[strings.ToLower(key)])
		}
		rows = append(rows, proxyEnvironment{Key: key, Present: value != ""})
	}
	return rows
}

func collectConfiguredProxy(path string, env map[string]string, readFile func(string) ([]byte, error)) configuredProxy {
	data, err := readFile(path)
	if os.IsNotExist(err) {
		return configuredProxy{Detail: "config file absent"}
	}
	if err != nil {
		return configuredProxy{Detail: "config unreadable"}
	}
	var raw struct {
		Proxy string `json:"proxy"`
	}
	if json.Unmarshal(data, &raw) != nil {
		return configuredProxy{Detail: "config invalid JSON"}
	}
	value := strings.TrimSpace(raw.Proxy)
	if value == "" {
		return configuredProxy{Detail: "not configured"}
	}
	result := configuredProxy{Configured: true}
	if name, ok := environmentReference(value); ok {
		result.Present = strings.TrimSpace(env[name]) != ""
		if result.Present {
			result.Detail = "environment reference " + name + " resolved"
		} else {
			result.Detail = "environment reference " + name + " is unset"
		}
		return result
	}
	result.Present = true
	result.Detail = "value hidden"
	return result
}

func environmentReference(value string) (string, bool) {
	if strings.HasPrefix(value, "${") && strings.HasSuffix(value, "}") {
		name := value[2 : len(value)-1]
		return name, validEnvironmentName(name)
	}
	if strings.HasPrefix(value, "$") {
		name := value[1:]
		return name, validEnvironmentName(name)
	}
	return "", false
}

func validEnvironmentName(value string) bool {
	if value == "" {
		return false
	}
	for index, char := range value {
		if index == 0 && !(char == '_' || char >= 'A' && char <= 'Z' || char >= 'a' && char <= 'z') {
			return false
		}
		if index > 0 && !(char == '_' || char >= 'A' && char <= 'Z' || char >= 'a' && char <= 'z' || char >= '0' && char <= '9') {
			return false
		}
	}
	return true
}

func collectWSLInstallDiagnostic(goos, home, effective string, env map[string]string, readFile func(string) ([]byte, error)) wslInstallDiagnostic {
	readText := func(path string) string {
		data, _ := readFile(path)
		return string(data)
	}
	options := codex.HomeOptions{
		Env: env, GOOS: goos, HomeDir: home,
		Release: readText("/proc/sys/kernel/osrelease"), ProcVersion: readText("/proc/version"),
		WSLConf: readText("/etc/wsl.conf"),
	}
	diagnostic := wslInstallDiagnostic{
		WSL: codex.IsWSLRuntime(options), AutomountRoot: codex.WSLAutomountRoot(options),
		EffectiveCodexHome: effective,
	}
	if !diagnostic.WSL {
		return diagnostic
	}
	diagnostic.LinuxConfigured = pathExists(filepath.Join(home, ".codex", "config.toml"))
	diagnostic.WindowsCodexHomes = codex.ListWSLWindowsCodexHomes(options)
	diagnostic.EffectiveOnWindows = isPathUnderWindowsMount(effective, diagnostic.AutomountRoot)
	diagnostic.DualInstall = diagnostic.LinuxConfigured && len(diagnostic.WindowsCodexHomes) > 0
	return diagnostic
}

func pathExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func isPathUnderWindowsMount(path, root string) bool {
	clean := filepath.ToSlash(filepath.Clean(path))
	prefix := strings.TrimRight(filepath.ToSlash(filepath.Clean(root)), "/") + "/"
	rest := strings.TrimPrefix(clean, prefix)
	return rest != clean && len(rest) >= 2 && rest[1] == '/'
}

func environmentMap(values []string) map[string]string {
	env := make(map[string]string, len(values))
	for _, entry := range values {
		key, value, ok := strings.Cut(entry, "=")
		if ok && key != "" {
			env[key] = value
		}
	}
	return env
}

func parseProcessEnvironment(content []byte) map[string]string {
	return environmentMap(strings.Split(string(content), "\x00"))
}

func collectRunningProxyEnvironment(pid int, goos string, readEnvironment func(int) ([]byte, error)) runningProxyEnvironment {
	empty := collectProxyEnvironment(map[string]string{})
	if pid <= 0 {
		return runningProxyEnvironment{Status: "not_running", Rows: empty}
	}
	if goos != "linux" && readEnvironment == nil {
		return runningProxyEnvironment{Status: "unavailable", PID: pid, Reason: "process env inspection is only supported on Linux", Rows: empty}
	}
	if readEnvironment == nil {
		readEnvironment = func(pid int) ([]byte, error) {
			return os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "environ"))
		}
	}
	content, err := readEnvironment(pid)
	if err != nil {
		return runningProxyEnvironment{Status: "unavailable", PID: pid, Reason: "could not read process environment", Rows: empty}
	}
	return runningProxyEnvironment{Status: "ok", PID: pid, Rows: collectProxyEnvironment(parseProcessEnvironment(content))}
}

func readMountTable() string {
	if runtime.GOOS != "linux" {
		return ""
	}
	content, err := os.ReadFile("/proc/mounts")
	if err != nil {
		return ""
	}
	return string(content)
}
