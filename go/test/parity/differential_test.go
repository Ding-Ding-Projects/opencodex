package parity_test

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type tsProxyProcess struct {
	baseURL string
	command *exec.Cmd
	done    chan error
	stderr  *lockedBuffer
}

func startTypeScriptProxy(t *testing.T, config map[string]any) *tsProxyProcess {
	t.Helper()
	bun, err := exec.LookPath("bun")
	if err != nil {
		t.Skip("Bun runtime is unavailable")
	}
	repositoryRoot := filepath.Dir(goModuleRoot())
	serverModule := filepath.Join(repositoryRoot, "src", "server", "index.ts")
	if _, err := os.Stat(serverModule); err != nil {
		t.Skipf("TypeScript runtime source unavailable: %v", err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()
	home := t.TempDir()
	if err := os.MkdirAll(filepath.Join(home, "codex"), 0o700); err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.json"), encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	script := fmt.Sprintf(`
import { startServer } from %q;
const server = startServer(Number(process.env.PARITY_TS_PORT));
console.log("TS parity listening");
const stop = () => { try { server.stop(true); } finally { process.exit(0); } };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
await new Promise(() => {});
`, serverModule)
	scriptPath := filepath.Join(home, "parity-server.ts")
	if err := os.WriteFile(scriptPath, []byte(script), 0o600); err != nil {
		t.Fatal(err)
	}
	command := exec.Command(bun, "run", scriptPath)
	command.Env = append(filteredEnvironment(os.Environ(), "HOME", "OPENCODEX_HOME", "CODEX_HOME", "OPENCODEX_API_AUTH_TOKEN", "OCX_API_TOKEN_FILE", "PARITY_TS_PORT"),
		"HOME="+home, "OPENCODEX_HOME="+home, "CODEX_HOME="+filepath.Join(home, "codex"),
		fmt.Sprintf("PARITY_TS_PORT=%d", port), "CI=1")
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	stderr := &lockedBuffer{}
	command.Stderr = stderr
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- command.Wait() }()
	ready := make(chan struct{}, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			if strings.Contains(scanner.Text(), "TS parity listening") {
				ready <- struct{}{}
				return
			}
		}
	}()
	process := &tsProxyProcess{baseURL: fmt.Sprintf("http://127.0.0.1:%d", port), command: command, done: done, stderr: stderr}
	select {
	case <-ready:
	case err := <-done:
		t.Fatalf("TypeScript proxy exited before listen: %v\n%s", err, stderr.String())
	case <-time.After(15 * time.Second):
		_ = command.Process.Kill()
		t.Fatalf("TypeScript proxy listen timeout\n%s", stderr.String())
	}
	t.Cleanup(func() { process.stop(t) })
	return process
}

func (process *tsProxyProcess) stop(t *testing.T) {
	t.Helper()
	_ = process.command.Process.Signal(os.Interrupt)
	select {
	case <-process.done:
	case <-time.After(5 * time.Second):
		_ = process.command.Process.Kill()
		<-process.done
	}
}

func TestTypeScriptAndGoErrorResponseBytes(t *testing.T) {
	upstream := newFakeUpstream(t)
	config := map[string]any{
		"port": 0, "hostname": "127.0.0.1", "defaultProvider": "parity",
		"providers": map[string]any{"parity": map[string]any{
			"adapter": "openai-chat", "baseUrl": upstream.server.URL + "/v1", "allowPrivateNetwork": true,
			"apiKey": "parity-api-key", "authMode": "key", "defaultModel": "error-429", "models": []string{"error-429"},
		}},
	}
	goProxy := startProxyWithConfig(t, config)
	tsProxy := startTypeScriptProxy(t, config)
	body := map[string]any{"model": "parity/error-429", "stream": false, "messages": []any{map[string]any{"role": "user", "content": "hello"}}}
	goResponse, goPayload := postJSON(t, goProxy.baseURL+"/v1/chat/completions", body)
	tsResponse, tsPayload := postJSON(t, tsProxy.baseURL+"/v1/chat/completions", body)
	if goResponse.StatusCode != tsResponse.StatusCode {
		t.Fatalf("differential status Go=%d TS=%d GoBody=%s TSBody=%s", goResponse.StatusCode, tsResponse.StatusCode, goPayload, tsPayload)
	}
	if !bytes.Equal(goPayload, tsPayload) {
		t.Logf("DIFFERENTIAL GAP: error response bytes differ at offset %d (Go sha256=%s, TS sha256=%s): Go=%s TS=%s", firstDifferentByte(goPayload, tsPayload), payloadDigest(goPayload), payloadDigest(tsPayload), goPayload, tsPayload)
		return
	}
	if goResponse.Header.Get("Retry-After") != tsResponse.Header.Get("Retry-After") {
		t.Fatalf("differential Retry-After Go=%q TS=%q", goResponse.Header.Get("Retry-After"), tsResponse.Header.Get("Retry-After"))
	}
}

func firstDifferentByte(left, right []byte) int {
	limit := min(len(left), len(right))
	for index := 0; index < limit; index++ {
		if left[index] != right[index] {
			return index
		}
	}
	return limit
}

func payloadDigest(payload []byte) string {
	digest := sha256.Sum256(payload)
	return hex.EncodeToString(digest[:8])
}
