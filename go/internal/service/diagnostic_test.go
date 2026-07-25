package service

import "testing"

func TestParseInstallStateVersionsAndBackend(t *testing.T) {
	state, err := ParseInstallState([]byte(`{"version":2,"codexHome":"/codex","opencodexHome":"/ocx","backend":"native"}`))
	if err != nil || state.Backend != BackendNative {
		t.Fatalf("ParseInstallState() = %#v, %v", state, err)
	}
	for _, invalid := range []string{
		`{"version":3,"codexHome":"/codex","opencodexHome":"/ocx"}`,
		`{"version":1,"codexHome":"/codex","opencodexHome":"/ocx","backend":"scheduler"}`,
		`{"version":2,"codexHome":"/codex","opencodexHome":"/ocx"}`,
	} {
		if _, err := ParseInstallState([]byte(invalid)); err == nil {
			t.Fatalf("ParseInstallState(%s) succeeded", invalid)
		}
	}
}

func TestInstallEnvironmentAndReinstallArgs(t *testing.T) {
	state := InstallState{Version: 2, CodexHome: `/home/jun/.codex`, OpenCodexHome: `/home/jun/.opencodex`, Backend: BackendNative}
	if !state.EnvironmentMatches(`/home/jun/.codex`, `/home/jun/.opencodex`) {
		t.Fatal("equivalent service paths did not match")
	}
	if state.EnvironmentMatches(`/home/other/.codex`, `/home/jun/.opencodex`) {
		t.Fatal("different service paths matched")
	}
	args := ServiceReinstallArgs(state)
	if len(args) != 3 || args[2] != "--native" {
		t.Fatalf("native reinstall args = %#v", args)
	}
}

func TestDeriveWindowsDiagnosticFailsClosed(t *testing.T) {
	xml := healthyTaskXML()
	healthy := DeriveWindowsDiagnostic(WindowsDiagnosticInput{SchedulerXML: xml, SchedulerAssets: true, RecordedBackend: BackendScheduler, WScript: testWscript, Launcher: testLauncher})
	if !healthy.Viable || !ServiceStartableFromTray(healthy) {
		t.Fatalf("healthy scheduler diagnosed as %#v", healthy)
	}
	conflict := DeriveWindowsDiagnostic(WindowsDiagnosticInput{SchedulerXML: xml, SchedulerAssets: true, NativeStatus: "started", RecordedBackend: BackendScheduler, WScript: testWscript, Launcher: testLauncher})
	if !conflict.Conflict || conflict.Viable || ServiceStartableFromTray(conflict) {
		t.Fatalf("conflicting services diagnosed as %#v", conflict)
	}
}
