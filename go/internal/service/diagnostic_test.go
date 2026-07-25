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
