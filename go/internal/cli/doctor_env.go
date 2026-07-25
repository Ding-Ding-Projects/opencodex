package cli

import (
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/codex"
)

var proxyEnvironmentKeys = []string{"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"}

type doctorPath struct {
	Label  string
	Path   string
	Exists bool
}

type filesystemInfo struct {
	Type       string
	Mount      string
	WindowsFS  bool
	MountDrive bool
}

type proxyEnvironment struct {
	Key     string
	Present bool
}

type runningProxyEnvironment struct {
	Status string
	PID    int
	Reason string
	Rows   []proxyEnvironment
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
