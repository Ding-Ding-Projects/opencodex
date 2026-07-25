package cli

import (
	"encoding/json"
	"fmt"
	"os"
	"runtime"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/service"
)

type diagnosticsReport struct {
	Version     string         `json:"version"`
	OS          string         `json:"os"`
	Arch        string         `json:"arch"`
	ConfigPath  string         `json:"configPath"`
	ConfigOK    bool           `json:"configOk"`
	ConfigErr   string         `json:"configError,omitempty"`
	RuntimePID  int            `json:"runtimePid,omitempty"`
	RuntimePort int            `json:"runtimePort,omitempty"`
	Service     map[string]any `json:"service"`
	ProxyEnv    []string       `json:"proxyEnv,omitempty"`
}

func runDiagnostics(args []string, streams IO) error {
	jsonOutput := false
	for _, arg := range args {
		switch arg {
		case "--json":
			jsonOutput = true
		default:
			return fmt.Errorf("usage: ocx diagnostics [--json]")
		}
	}
	report := collectDiagnostics()
	if jsonOutput {
		encoder := json.NewEncoder(streams.Out)
		encoder.SetIndent("", "  ")
		return encoder.Encode(report)
	}
	fmt.Fprintf(streams.Out, "opencodex %s (%s/%s)\nConfig: %s\n", report.Version, report.OS, report.Arch, report.ConfigPath)
	if report.ConfigOK {
		fmt.Fprintln(streams.Out, "[PASS] config parses and validates")
	} else {
		fmt.Fprintf(streams.Out, "[FAIL] config: %s\n", report.ConfigErr)
	}
	fmt.Fprintf(streams.Out, "Runtime: pid=%d port=%d\n", report.RuntimePID, report.RuntimePort)
	fmt.Fprintf(streams.Out, "Service: installed=%v running=%v artifact=%v\n", report.Service["installed"], report.Service["running"], report.Service["artifact"])
	if len(report.ProxyEnv) > 0 {
		fmt.Fprintf(streams.Out, "Proxy environment: %s\n", strings.Join(report.ProxyEnv, ", "))
	}
	return nil
}

func collectDiagnostics() diagnosticsReport {
	path, _ := configPath()
	cfg, _, configErr := loadConfig()
	report := diagnosticsReport{Version: Version, OS: runtime.GOOS, Arch: runtime.GOARCH, ConfigPath: path, ConfigOK: configErr == nil, Service: map[string]any{"installed": false, "running": false}}
	if configErr != nil {
		report.ConfigErr = configErr.Error()
	}
	report.RuntimePID, report.RuntimePort = readRuntime()
	for _, key := range []string{"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"} {
		if os.Getenv(key) != "" {
			report.ProxyEnv = append(report.ProxyEnv, key)
		}
	}
	if cfg == nil {
		defaults := config.Default()
		cfg = &defaults
	}
	if manager, err := service.NewManager(serviceConfig(*cfg)); err == nil {
		report.Service["artifact"] = manager.ArtifactPath()
		if status, statusErr := manager.Status(); statusErr == nil {
			report.Service["installed"] = status.Installed
			report.Service["running"] = status.Running
			if status.Detail != "" {
				report.Service["detail"] = status.Detail
			}
		} else {
			report.Service["error"] = statusErr.Error()
		}
	} else {
		report.Service["error"] = err.Error()
	}
	return report
}
