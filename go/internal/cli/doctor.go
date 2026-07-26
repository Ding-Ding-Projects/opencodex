package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"runtime"
	"strings"
)

type doctorStatus string

const (
	doctorPass doctorStatus = "pass"
	doctorWarn doctorStatus = "warn"
	doctorFail doctorStatus = "fail"
	doctorInfo doctorStatus = "info"
)

type doctorCheck struct {
	Name   string       `json:"name"`
	Status doctorStatus `json:"status"`
	Detail string       `json:"detail"`
	Hint   string       `json:"hint,omitempty"`
}

type doctorReport struct {
	OS              string                  `json:"os"`
	Architecture    string                  `json:"architecture"`
	Paths           []doctorPath            `json:"paths"`
	Checks          []doctorCheck           `json:"checks"`
	CurrentProxyEnv []proxyEnvironment      `json:"currentProxyEnvironment"`
	ConfiguredProxy configuredProxy         `json:"configuredProxy"`
	RunningProxyEnv runningProxyEnvironment `json:"runningProxyEnvironment"`
	WSL             wslInstallDiagnostic    `json:"wsl"`
	ProjectWarnings []projectWarning        `json:"projectWarnings,omitempty"`
	BackupArtifacts int                     `json:"backupArtifacts"`
	Passes          int                     `json:"passes"`
	Warnings        int                     `json:"warnings"`
	Failures        int                     `json:"failures"`
	GeneratedAt     string                  `json:"generatedAt"`
}

func (r *doctorReport) add(check doctorCheck) {
	r.Checks = append(r.Checks, check)
	switch check.Status {
	case doctorPass:
		r.Passes++
	case doctorWarn:
		r.Warnings++
	case doctorFail:
		r.Failures++
	}
}

func runDoctor(ctx context.Context, args []string, streams IO) error {
	jsonOutput := false
	for _, arg := range args {
		switch arg {
		case "--json":
			jsonOutput = true
		default:
			return fmt.Errorf("usage: ocx doctor [--json]")
		}
	}
	report, err := collectDoctorReport(ctx, doctorDeps{})
	if err != nil {
		return err
	}
	if jsonOutput {
		encoder := json.NewEncoder(streams.Out)
		encoder.SetIndent("", "  ")
		return encoder.Encode(report)
	}
	return renderDoctorReport(streams.Out, report)
}

func renderDoctorReport(writer io.Writer, report doctorReport) error {
	if _, err := fmt.Fprintf(writer, "opencodex doctor\n\nOS: %s/%s\n", report.OS, report.Architecture); err != nil {
		return err
	}
	fmt.Fprintln(writer, "\nPaths")
	for _, row := range report.Paths {
		marker := "--"
		if row.Exists {
			marker = "ok"
		}
		flags := []string{}
		if row.Filesystem.Type != "" && row.Filesystem.Type != "n/a" {
			flags = append(flags, "fs="+row.Filesystem.Type)
		}
		if row.Filesystem.WindowsFS || row.Filesystem.MountDrive {
			flags = append(flags, "WSL /mnt drive")
		}
		suffix := ""
		if len(flags) > 0 {
			suffix = " (" + strings.Join(flags, ", ") + ")"
		}
		fmt.Fprintf(writer, "  %s %-28s %s%s\n", marker, row.Label+":", row.Path, suffix)
	}

	fmt.Fprintln(writer, "\nDiagnostic checks")
	for _, check := range report.Checks {
		fmt.Fprintf(writer, "  [%s] %-28s %s\n", strings.ToUpper(string(check.Status)), check.Name, check.Detail)
		if check.Hint != "" {
			fmt.Fprintf(writer, "         hint: %s\n", check.Hint)
		}
	}

	fmt.Fprintln(writer, "\nCurrent doctor process proxy env (presence only)")
	for _, row := range report.CurrentProxyEnv {
		fmt.Fprintf(writer, "  %-5s %s\n", presenceMarker(row.Present), row.Key)
	}
	fmt.Fprintln(writer, "\nConfigured proxy (value hidden)")
	fmt.Fprintf(writer, "  %-5s config.proxy (%s)\n", presenceMarker(report.ConfiguredProxy.Present), report.ConfiguredProxy.Detail)
	fmt.Fprintln(writer, "\nRunning proxy process proxy env (presence only)")
	switch report.RunningProxyEnv.Status {
	case "ok":
		fmt.Fprintf(writer, "  ok pid %d\n", report.RunningProxyEnv.PID)
		for _, row := range report.RunningProxyEnv.Rows {
			fmt.Fprintf(writer, "     %-5s %s\n", presenceMarker(row.Present), row.Key)
		}
	case "not_running":
		fmt.Fprintln(writer, "  -- proxy is not running")
	default:
		fmt.Fprintf(writer, "  -- pid %d: %s\n", report.RunningProxyEnv.PID, report.RunningProxyEnv.Reason)
	}

	if report.WSL.WSL {
		fmt.Fprintln(writer, "\nWSL Codex installs")
		fmt.Fprintf(writer, "  Linux config: %t\n", report.WSL.LinuxConfigured)
		fmt.Fprintf(writer, "  Effective CODEX_HOME: %s\n", report.WSL.EffectiveCodexHome)
		for _, path := range report.WSL.WindowsCodexHomes {
			fmt.Fprintf(writer, "  Windows config: %s\n", path)
		}
	}

	if len(report.ProjectWarnings) > 0 {
		fmt.Fprintln(writer, "\nProject Codex configs")
		for _, warning := range report.ProjectWarnings {
			fmt.Fprintf(writer, "  [WARN] %s: %s\n", warning.Path, warning.Message)
		}
	}
	fmt.Fprintf(writer, "\nSummary: %d passed, %d warning(s), %d failure(s)\n", report.Passes, report.Warnings, report.Failures)
	return nil
}

func presenceMarker(present bool) string {
	if present {
		return "set"
	}
	return "unset"
}

func defaultDoctorPlatform() (string, string) { return runtime.GOOS, runtime.GOARCH }
func defaultDoctorEnvironment() []string      { return os.Environ() }
