package service

import (
	"encoding/json"
	"fmt"
	"strings"
)

type Backend string

const (
	BackendScheduler Backend = "scheduler"
	BackendNative    Backend = "native"
)

type InstallState struct {
	Version       int     `json:"version"`
	CodexHome     string  `json:"codexHome"`
	OpenCodexHome string  `json:"opencodexHome"`
	Executable    string  `json:"bunPath,omitempty"`
	CLIPath       string  `json:"cliPath,omitempty"`
	Backend       Backend `json:"backend,omitempty"`
	WinSWVersion  string  `json:"winswVersion,omitempty"`
	WinSWSHA256   string  `json:"winswSha256,omitempty"`
}

func ParseInstallState(data []byte) (InstallState, error) {
	var state InstallState
	if err := json.Unmarshal(data, &state); err != nil {
		return state, fmt.Errorf("decode service install state: %w", err)
	}
	if state.Version != 1 && state.Version != 2 {
		return state, errorsForState("version must be 1 or 2")
	}
	if strings.TrimSpace(state.CodexHome) == "" || strings.TrimSpace(state.OpenCodexHome) == "" {
		return state, errorsForState("codexHome and opencodexHome are required")
	}
	if state.Version == 1 && state.Backend != "" {
		return state, errorsForState("version 1 must not declare a backend")
	}
	if state.Version == 2 && state.Backend != BackendScheduler && state.Backend != BackendNative {
		return state, errorsForState("version 2 backend must be scheduler or native")
	}
	for field, value := range map[string]string{"bunPath": state.Executable, "cliPath": state.CLIPath, "winswVersion": state.WinSWVersion, "winswSha256": state.WinSWSHA256} {
		if value != "" && strings.TrimSpace(value) == "" {
			return state, errorsForState(field + " must not be blank")
		}
	}
	return state, nil
}

func errorsForState(message string) error {
	return fmt.Errorf("invalid service install state: %s", message)
}

type WindowsDiagnosticInput struct {
	SchedulerXML           string
	SchedulerAssets        bool
	NativeStatus           string
	RecordedBackend        Backend
	StalePaths             bool
	NativeRepairAssetsOnly bool
	Diagnostics            string
	WScript                string
	Launcher               string
}

type Diagnostic struct {
	Supported bool
	Installed bool
	Enabled   bool
	Running   bool
	Viable    bool
	Startable bool
	Stale     bool
	Conflict  bool
	Backend   Backend
	Summary   string
}

func DeriveWindowsDiagnostic(input WindowsDiagnosticInput) Diagnostic {
	scheduler := ReadWindowsSchedulerXmlState(input.SchedulerXML, input.WScript, input.Launcher)
	schedulerInstalled := scheduler.Installed
	nativeInstalled := input.NativeStatus != "" && input.NativeStatus != "nonexistent"
	conflict := schedulerInstalled && nativeInstalled
	backendMismatch := schedulerInstalled && input.RecordedBackend != BackendScheduler || nativeInstalled && input.RecordedBackend != BackendNative
	schedulerHealthy := input.SchedulerAssets && scheduler.RegistrationHealthy
	stale := input.StalePaths || schedulerInstalled && !schedulerHealthy || backendMismatch || input.NativeStatus == "nonexistent" && input.NativeRepairAssetsOnly
	backend := Backend("")
	if schedulerInstalled {
		backend = BackendScheduler
	} else if nativeInstalled {
		backend = BackendNative
	}
	enabled := schedulerInstalled && scheduler.Enabled || nativeInstalled && input.NativeStatus == "started"
	running := nativeInstalled && input.NativeStatus == "started" || schedulerInstalled && scheduler.Enabled
	viable := !conflict && !stale && (schedulerInstalled && scheduler.Enabled && schedulerHealthy || nativeInstalled && input.NativeStatus == "started")
	startable := !conflict && !stale && (schedulerInstalled && scheduler.Enabled && schedulerHealthy || nativeInstalled && (input.NativeStatus == "started" || input.NativeStatus == "stopped"))
	detail := "not installed"
	switch {
	case conflict:
		detail = "CONFLICT: Task Scheduler and native service are both present"
	case stale:
		detail = "stale or missing service assets"
	case schedulerInstalled && scheduler.Enabled:
		detail = "Task Scheduler enabled"
	case schedulerInstalled:
		detail = "Task Scheduler disabled"
	case nativeInstalled:
		detail = "native service " + input.NativeStatus
	}
	if input.Diagnostics != "" {
		detail += " (" + input.Diagnostics + ")"
	}
	return Diagnostic{Supported: true, Installed: schedulerInstalled || nativeInstalled, Enabled: enabled, Running: running, Viable: viable, Startable: startable, Stale: stale, Conflict: conflict, Backend: backend, Summary: detail}
}

func ServiceStartableFromTray(diagnostic Diagnostic) bool {
	return diagnostic.Startable && !diagnostic.Stale && !diagnostic.Conflict
}
