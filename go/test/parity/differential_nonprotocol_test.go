package parity_test

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/codex"
)

func TestTypeScriptAndGoConfigInterpretation(t *testing.T) {
	upstream := newDifferentialUpstream(t)
	base := differentialConfig(upstream.server.URL, []string{"success"})
	cases := []struct {
		name   string
		mutate func(map[string]any)
	}{
		{name: "defaults", mutate: func(config map[string]any) { delete(config, "hostname") }},
		{name: "unknown-fields", mutate: func(config map[string]any) {
			config["futureTopLevel"] = map[string]any{"enabled": true}
			config["providers"].(map[string]any)["differential"].(map[string]any)["futureProviderField"] = "ignored"
		}},
		{name: "wrong-field-type", mutate: func(config map[string]any) { config["websockets"] = "true" }},
	}
	for _, scenario := range cases {
		t.Run(scenario.name, func(t *testing.T) {
			config := cloneJSONMap(base)
			scenario.mutate(config)
			tsProxy := startTypeScriptProxy(t, config)
			goProxy := startProxyWithConfig(t, config)
			compareRuntimeBytes(t, "config/"+scenario.name, captureGET(t, goProxy.baseURL, "/api/config"), captureGET(t, tsProxy.baseURL, "/api/config"), false)
		})
	}
}

func TestTypeScriptAndGoRequestLogShape(t *testing.T) {
	upstream := newDifferentialUpstream(t)
	config := differentialConfig(upstream.server.URL, []string{"success"})
	tsProxy := startTypeScriptProxy(t, config)
	goProxy := startProxyWithConfig(t, config)
	body := map[string]any{"model": "differential/success", "input": "log parity", "stream": true}
	_ = captureJSON(t, goProxy.baseURL, "/v1/responses", body)
	_ = captureJSON(t, tsProxy.baseURL, "/v1/responses", body)
	goLogs := captureGET(t, goProxy.baseURL, "/api/logs?tail=1")
	tsLogs := captureGET(t, tsProxy.baseURL, "/api/logs?tail=1")
	goLogs.body = normalizeLogBytes(goLogs.body)
	tsLogs.body = normalizeLogBytes(tsLogs.body)
	compareRuntimeBytes(t, "logs/request-shape", goLogs, tsLogs, true)
}

func TestTypeScriptAndGoUnknownCommandContract(t *testing.T) {
	bun, err := exec.LookPath("bun")
	if err != nil {
		t.Skip("Bun runtime is unavailable")
	}
	ts := captureProcess(exec.Command(bun, "run", filepath.Join(filepath.Dir(goModuleRoot()), "src", "cli", "index.ts"), "definitely-invalid-command"))
	goResult := captureProcess(exec.Command(parityBinary, "definitely-invalid-command"))
	if ts.exitCode != goResult.exitCode {
		t.Fatalf("unknown command exit differs: Go=%d TS=%d", goResult.exitCode, ts.exitCode)
	}
	compareArtifactBytes(t, "cli/unknown-command-stdout", goResult.stdout, ts.stdout)
	compareArtifactBytes(t, "cli/unknown-command-stderr", goResult.stderr, ts.stderr)
}

func TestTypeScriptAndGoUnixShimBytes(t *testing.T) {
	bun, err := exec.LookPath("bun")
	if err != nil {
		t.Skip("Bun runtime is unavailable")
	}
	module := filepath.Join(filepath.Dir(goModuleRoot()), "src", "codex", "shim.ts")
	script := `import { buildUnixCodexShim } from ` + string(mustJSON(module)) + `; process.stdout.write(buildUnixCodexShim("/opt/codex", "/opt/ocx", "/opt/opencodex-cli.ts", "/tmp/token"));`
	tsOutput, commandErr := exec.Command(bun, "-e", script).Output()
	if commandErr != nil {
		t.Fatal(commandErr)
	}
	goOutput := []byte(codex.BuildUnixShimWithToken("/opt/codex", "/opt/ocx", "/tmp/token"))
	compareArtifactBytes(t, "shim/unix", goOutput, tsOutput)
}

type processCapture struct {
	exitCode       int
	stdout, stderr []byte
}

func captureProcess(command *exec.Cmd) processCapture {
	var stdout, stderr bytes.Buffer
	command.Stdout, command.Stderr = &stdout, &stderr
	command.Env = append(os.Environ(), "CI=1")
	err := command.Run()
	exitCode := 0
	if exit, ok := err.(*exec.ExitError); ok {
		exitCode = exit.ExitCode()
	} else if err != nil {
		exitCode = -1
	}
	return processCapture{exitCode: exitCode, stdout: stdout.Bytes(), stderr: stderr.Bytes()}
}

var knownArtifactDiffs = map[string]bool{
	"cli/unknown-command-stdout": true,
	"cli/unknown-command-stderr": true,
	"shim/unix":                  true,
}

func compareArtifactBytes(t *testing.T, scenario string, goBytes, tsBytes []byte) {
	t.Helper()
	different := !bytes.Equal(goBytes, tsBytes)
	if different == knownArtifactDiffs[scenario] {
		if different {
			t.Logf("KNOWN ARTIFACT DIFFERENTIAL [%s]: Go(len=%d sha=%s) TS(len=%d sha=%s)", scenario, len(goBytes), payloadDigest(goBytes), len(tsBytes), payloadDigest(tsBytes))
		}
		return
	}
	t.Fatalf("artifact differential changed [%s]: expectedDifferent=%t Go=%q TS=%q", scenario, knownArtifactDiffs[scenario], goBytes, tsBytes)
}

var (
	logDynamicPattern = regexp.MustCompile(`("requestId":)"[^"]*"|("(?:timestamp|durationMs|firstOutputMs)":)-?[0-9]+(?:\.[0-9]+)?`)
	logRatePattern    = regexp.MustCompile(`("tokPerSecond":\{"kind":"value","value":)-?[0-9]+(?:\.[0-9]+)?`)
)

func normalizeLogBytes(payload []byte) []byte {
	normalized := logDynamicPattern.ReplaceAll(payload, []byte(`${1}${2}0`))
	return logRatePattern.ReplaceAll(normalized, []byte(`${1}0`))
}

func cloneJSONMap(value map[string]any) map[string]any {
	encoded, _ := json.Marshal(value)
	var cloned map[string]any
	_ = json.Unmarshal(encoded, &cloned)
	return cloned
}
