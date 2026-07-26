package parity_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/grok"
)

const lifecyclePollTimeout = 20 * time.Second

type lifecycleRuntime string

const (
	lifecycleGo lifecycleRuntime = "Go"
	lifecycleTS lifecycleRuntime = "TypeScript"
)

type lifecycleObservation struct {
	grokInjected  []byte
	grokRestored  []byte
	routeStatus   int
	routeBody     []byte
	desktopConfig []byte
	desktopMeta   []byte
	desktopStatus desktopStatusObservation
}

type desktopStatusObservation struct {
	Applied           bool    `json:"applied"`
	SavedFingerprint  *string `json:"savedFingerprint"`
	OnDiskFingerprint *string `json:"onDiskFingerprint"`
	ConfigPath        *string `json:"configPath"`
	Stale             bool    `json:"stale"`
}

type cliLifecycleProcess struct {
	command *exec.Cmd
	exited  chan struct{}
	waitErr error
	stdout  *lockedBuffer
	stderr  *lockedBuffer
	baseURL string
	env     []string
}

func TestGrokAndClaudeDesktopCLILifecycleParity(t *testing.T) {
	requireRuntimeParity(t)
	bun := requireBun(t, exec.LookPath)
	upstream := newFakeUpstream(t)
	port := reserveParityPort(t)

	goResult := observeCLILifecycle(t, lifecycleGo, "", port, upstream.server.URL)
	waitForPortRelease(t, port)
	tsResult := observeCLILifecycle(t, lifecycleTS, bun, port, upstream.server.URL)

	compareGrokLifecycleInjection(t, goResult.grokInjected, tsResult.grokInjected)
	compareLifecycleBytes(t, "Grok restored config", goResult.grokRestored, tsResult.grokRestored)
	compareRoutedLifecycleResponse(t, goResult.routeBody, tsResult.routeBody)
	compareDesktopLifecycleConfig(t, goResult.desktopConfig, tsResult.desktopConfig)
	compareLifecycleBytes(t, "Claude Desktop metadata", goResult.desktopMeta, tsResult.desktopMeta)
	if goResult.routeStatus != tsResult.routeStatus || goResult.routeStatus != http.StatusOK {
		t.Fatalf("route status Go=%d TypeScript=%d", goResult.routeStatus, tsResult.routeStatus)
	}
	if goResult.desktopStatus.Applied != tsResult.desktopStatus.Applied || goResult.desktopStatus.Stale != tsResult.desktopStatus.Stale {
		t.Fatalf("Claude Desktop status differs: Go=%#v TypeScript=%#v", goResult.desktopStatus, tsResult.desktopStatus)
	}
}

func observeCLILifecycle(t *testing.T, runtime lifecycleRuntime, bun string, port int, upstreamURL string) lifecycleObservation {
	t.Helper()
	home := t.TempDir()
	grokHome := filepath.Join(home, ".grok")
	desktopHome := filepath.Join(home, "claude-desktop")
	codexHome := filepath.Join(home, "codex")
	if err := os.MkdirAll(grokHome, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(desktopHome, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(codexHome, 0o700); err != nil {
		t.Fatal(err)
	}
	originalGrok := []byte("theme = \"dark\"\r\n# user bytes remain exact\r\n")
	grokPath := filepath.Join(grokHome, "config.toml")
	if err := os.WriteFile(grokPath, originalGrok, 0o600); err != nil {
		t.Fatal(err)
	}
	const desktopID = "11111111-1111-4111-8111-111111111111"
	desktopConfigPath := filepath.Join(desktopHome, desktopID+".json")
	desktopMetaPath := filepath.Join(desktopHome, "_meta.json")
	originalDesktop := []byte("{\"userOwned\":true}\n")
	seedMeta := []byte("{\"appliedId\":\"" + desktopID + "\",\"entries\":[{\"extra\":\"keep\",\"id\":\"" + desktopID + "\",\"name\":\"opencodex\"}],\"vendor\":\"keep\"}\n")
	if err := os.WriteFile(desktopConfigPath, originalDesktop, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(desktopMetaPath, seedMeta, 0o600); err != nil {
		t.Fatal(err)
	}

	config := map[string]any{
		"port": port, "hostname": "127.0.0.1", "defaultProvider": "parity",
		"providers": map[string]any{"parity": map[string]any{
			"adapter": "openai-chat", "baseUrl": upstreamURL + "/v1", "allowPrivateNetwork": true,
			"apiKey": "parity-api-key", "authMode": "key", "defaultModel": "success", "models": []string{"success"},
		}},
	}
	configData, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(home, "config.json")
	if err := os.WriteFile(configPath, configData, 0o600); err != nil {
		t.Fatal(err)
	}

	process := startLifecycleCLI(t, runtime, bun, home, configPath, desktopHome, port)
	waitForFile(t, grokPath, func(data []byte) bool { return bytes.Contains(data, []byte(grok.BeginMarker)) })
	injected := mustReadParityFile(t, grokPath)

	response, routeBody := postJSON(t, process.baseURL+"/v1/chat/completions", map[string]any{
		"model": "parity/success", "stream": false,
		"messages": []any{map[string]any{"role": "user", "content": "lifecycle parity"}},
	})
	routeStatus := response.StatusCode

	applyBody := doLifecycleRequest(t, http.MethodPost, process.baseURL+"/api/claude-desktop/apply", nil)
	if applyBody.status != http.StatusOK {
		t.Fatalf("%s Claude Desktop apply status=%d body=%s", runtime, applyBody.status, applyBody.body)
	}
	desktopConfig := mustReadParityFile(t, desktopConfigPath)
	desktopMeta := mustReadParityFile(t, desktopMetaPath)
	if bytes.Equal(desktopConfig, originalDesktop) {
		t.Fatalf("%s Claude Desktop apply left the seed config unchanged", runtime)
	}
	if got := mustReadParityFile(t, grokPath); !bytes.Equal(got, injected) {
		t.Fatalf("%s Claude Desktop apply interfered with Grok config", runtime)
	}

	statusResult := doLifecycleRequest(t, http.MethodGet, process.baseURL+"/api/claude-desktop/status", nil)
	if statusResult.status != http.StatusOK {
		t.Fatalf("%s Claude Desktop status=%d body=%s", runtime, statusResult.status, statusResult.body)
	}
	var status desktopStatusObservation
	if err := json.Unmarshal(statusResult.body, &status); err != nil {
		t.Fatalf("%s decode Claude Desktop status: %v: %s", runtime, err, statusResult.body)
	}
	if !status.Applied || status.Stale || status.SavedFingerprint == nil || status.OnDiskFingerprint == nil || *status.SavedFingerprint != *status.OnDiskFingerprint {
		t.Fatalf("%s Claude Desktop status=%#v", runtime, status)
	}

	reapply := doLifecycleRequest(t, http.MethodPost, process.baseURL+"/api/claude-desktop/apply", nil)
	if runtime == lifecycleGo && reapply.status != http.StatusOK {
		t.Fatalf("%s Claude Desktop reapply status=%d body=%s", runtime, reapply.status, reapply.body)
	}
	if runtime == lifecycleTS {
		if reapply.status != http.StatusBadRequest || !bytes.Contains(reapply.body, []byte(`unknown field \"appliedFingerprint\"`)) {
			t.Fatalf("%s Claude Desktop reapply changed behavior: status=%d body=%s", runtime, reapply.status, reapply.body)
		}
		t.Log("DIFFERENTIAL GAP: TypeScript Claude Desktop management reapply rejects its persisted appliedFingerprint")
	}
	assertParityFileBytes(t, string(runtime)+" idempotent config", desktopConfigPath, desktopConfig)
	assertParityFileBytes(t, string(runtime)+" idempotent metadata", desktopMetaPath, desktopMeta)

	corruptMeta := []byte("{\"entries\":[")
	if err := os.WriteFile(desktopMetaPath, corruptMeta, 0o600); err != nil {
		t.Fatal(err)
	}
	failedApply := doLifecycleRequest(t, http.MethodPost, process.baseURL+"/api/claude-desktop/apply", nil)
	if failedApply.status < 400 {
		t.Fatalf("%s accepted corrupt Claude Desktop metadata: %d %s", runtime, failedApply.status, failedApply.body)
	}
	assertParityFileBytes(t, string(runtime)+" rollback config", desktopConfigPath, desktopConfig)
	assertParityFileBytes(t, string(runtime)+" rollback metadata", desktopMetaPath, corruptMeta)
	if err := os.WriteFile(desktopMetaPath, desktopMeta, 0o600); err != nil {
		t.Fatal(err)
	}

	stopLifecycleCLI(t, runtime, bun, process, home, configPath)
	restored := mustReadParityFile(t, grokPath)
	if !bytes.Equal(restored, originalGrok) {
		t.Fatalf("%s stop did not restore Grok bytes: got=%q want=%q", runtime, restored, originalGrok)
	}
	assertParityFileBytes(t, string(runtime)+" stop preserved Claude config", desktopConfigPath, desktopConfig)
	assertParityFileBytes(t, string(runtime)+" stop preserved Claude metadata", desktopMetaPath, desktopMeta)
	return lifecycleObservation{injected, restored, routeStatus, routeBody, desktopConfig, desktopMeta, status}
}

type lifecycleHTTPResult struct {
	status int
	body   []byte
}

func startLifecycleCLI(t *testing.T, runtime lifecycleRuntime, bun, home, configPath, desktopHome string, port int) *cliLifecycleProcess {
	t.Helper()
	var command *exec.Cmd
	if runtime == lifecycleGo {
		command = exec.Command(parityBinary, "serve", "--config", configPath, "--port", fmt.Sprint(port))
	} else {
		command = exec.Command(bun, "run", filepath.Join(filepath.Dir(goModuleRoot()), "src", "cli", "index.ts"), "start")
	}
	environment := append(filteredEnvironment(os.Environ(), "HOME", "OPENCODEX_HOME", "CODEX_HOME", "OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR", "OCX_SERVICE"),
		"HOME="+home,
		"OPENCODEX_HOME="+home,
		"CODEX_HOME="+filepath.Join(home, "codex"),
		"OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR="+desktopHome,
		"CI=1",
	)
	command.Env = environment
	stdout, stderr := &lockedBuffer{}, &lockedBuffer{}
	command.Stdout, command.Stderr = stdout, stderr
	if err := command.Start(); err != nil {
		t.Fatalf("start %s CLI: %v", runtime, err)
	}
	exited := make(chan struct{})
	process := &cliLifecycleProcess{command: command, exited: exited, stdout: stdout, stderr: stderr, baseURL: fmt.Sprintf("http://127.0.0.1:%d", port), env: environment}
	go func() {
		process.waitErr = command.Wait()
		close(exited)
	}()
	t.Cleanup(func() {
		select {
		case <-exited:
		default:
			_ = command.Process.Kill()
			<-exited
		}
	})
	waitForHTTP(t, process)
	return process
}

func stopLifecycleCLI(t *testing.T, runtime lifecycleRuntime, bun string, process *cliLifecycleProcess, home, configPath string) {
	t.Helper()
	var command *exec.Cmd
	if runtime == lifecycleGo {
		command = exec.Command(parityBinary, "stop")
	} else {
		command = exec.Command(bun, "run", filepath.Join(filepath.Dir(goModuleRoot()), "src", "cli", "index.ts"), "stop")
	}
	command.Env = process.env
	command.Dir = home
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("%s stop failed: %v\n%s\nconfig=%s", runtime, err, output, configPath)
	}
	select {
	case <-process.exited:
		if process.waitErr != nil {
			t.Fatalf("%s serve exited after stop: %v\nstdout=%s\nstderr=%s", runtime, process.waitErr, process.stdout.String(), process.stderr.String())
		}
	case <-time.After(lifecyclePollTimeout):
		t.Fatalf("%s serve did not exit after stop\nstdout=%s\nstderr=%s", runtime, process.stdout.String(), process.stderr.String())
	}
}

func waitForHTTP(t *testing.T, process *cliLifecycleProcess) {
	t.Helper()
	deadline := time.Now().Add(lifecyclePollTimeout)
	for time.Now().Before(deadline) {
		request, _ := http.NewRequestWithContext(context.Background(), http.MethodGet, process.baseURL+"/healthz", nil)
		if response, err := http.DefaultClient.Do(request); err == nil {
			_ = response.Body.Close()
			if response.StatusCode == http.StatusOK {
				return
			}
		}
		select {
		case <-process.exited:
			t.Fatalf("CLI exited before health: %v\nstdout=%s\nstderr=%s", process.waitErr, process.stdout.String(), process.stderr.String())
		default:
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("CLI health timeout\nstdout=%s\nstderr=%s", process.stdout.String(), process.stderr.String())
}

func waitForFile(t *testing.T, path string, ready func([]byte) bool) {
	t.Helper()
	deadline := time.Now().Add(lifecyclePollTimeout)
	for time.Now().Before(deadline) {
		if data, err := os.ReadFile(path); err == nil && ready(data) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", path)
}

func reserveParityPort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	return port
}

func waitForPortRelease(t *testing.T, port int) {
	t.Helper()
	deadline := time.Now().Add(lifecyclePollTimeout)
	for time.Now().Before(deadline) {
		listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
		if err == nil {
			_ = listener.Close()
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("port %d was not released", port)
}

func doLifecycleRequest(t *testing.T, method, url string, body []byte) lifecycleHTTPResult {
	t.Helper()
	request, err := http.NewRequest(method, url, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if len(body) > 0 {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	payload, readErr := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if readErr != nil {
		t.Fatal(readErr)
	}
	return lifecycleHTTPResult{response.StatusCode, payload}
}

func mustReadParityFile(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func assertParityFileBytes(t *testing.T, scenario, path string, want []byte) {
	t.Helper()
	if got := mustReadParityFile(t, path); !bytes.Equal(got, want) {
		t.Fatalf("%s changed at offset %d: got=%q want=%q", scenario, firstDifferentByte(got, want), got, want)
	}
}
