package parity_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

var parityBinary string

func TestMain(main *testing.M) {
	root := goModuleRoot()
	directory, err := os.MkdirTemp("", "ocx-parity-binary-")
	if err != nil {
		panic(err)
	}
	parityBinary = filepath.Join(directory, "ocx")
	if runtime.GOOS == "windows" {
		parityBinary += ".exe"
	}
	build := exec.Command("go", "build", "-o", parityBinary, "./cmd/ocx")
	build.Dir = root
	if output, buildErr := build.CombinedOutput(); buildErr != nil {
		_, _ = fmt.Fprintf(os.Stderr, "build parity binary: %v\n%s", buildErr, output)
		_ = os.RemoveAll(directory)
		os.Exit(1)
	}
	code := main.Run()
	_ = os.RemoveAll(directory)
	os.Exit(code)
}

func goModuleRoot() string {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		panic("resolve parity test path")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", ".."))
}

type proxyProcess struct {
	baseURL string
	command *exec.Cmd
	done    chan error
	stderr  *lockedBuffer
	auth    string
}

type lockedBuffer struct {
	sync.Mutex
	bytes.Buffer
}

func (buffer *lockedBuffer) Write(data []byte) (int, error) {
	buffer.Lock()
	defer buffer.Unlock()
	return buffer.Buffer.Write(data)
}

func (buffer *lockedBuffer) String() string {
	buffer.Lock()
	defer buffer.Unlock()
	return buffer.Buffer.String()
}

func startProxy(t *testing.T, upstreamURL string) *proxyProcess {
	t.Helper()
	config := map[string]any{
		"port": 0, "hostname": "127.0.0.1", "defaultProvider": "parity",
		"providers": map[string]any{"parity": map[string]any{
			"adapter": "openai-chat", "baseUrl": upstreamURL + "/v1", "allowPrivateNetwork": true,
			"apiKey": "parity-api-key", "authMode": "key", "defaultModel": "success",
			"models":  []string{"success", "split", "truncated", "error", "error-401", "error-429", "error-500", "cancel"},
			"headers": map[string]string{"X-Parity-Static": "configured"},
		}},
	}
	return startProxyWithConfig(t, config)
}

func startProxyWithConfig(t *testing.T, config map[string]any, extraEnvironment ...string) *proxyProcess {
	return startProxyWithSetup(t, config, nil, extraEnvironment...)
}

func startProxyWithSetup(t *testing.T, config map[string]any, setup func(string), extraEnvironment ...string) *proxyProcess {
	t.Helper()
	home := t.TempDir()
	if setup != nil {
		setup(home)
	}
	configPath := filepath.Join(home, "config.json")
	encoded, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath, encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	command := exec.Command(parityBinary, "serve", "--config", configPath, "--port", "0")
	command.Env = append(filteredEnvironment(os.Environ(), "HOME", "OPENCODEX_HOME", "CODEX_HOME", "OPENCODEX_API_AUTH_TOKEN", "OCX_API_TOKEN_FILE"),
		"HOME="+home, "OPENCODEX_HOME="+home, "CODEX_HOME="+filepath.Join(home, "codex"))
	command.Env = append(command.Env, extraEnvironment...)
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
	listening := make(chan string, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			line := scanner.Text()
			if address, found := strings.CutPrefix(line, "OpenCodex proxy listening on "); found {
				listening <- strings.TrimSpace(address)
			}
		}
	}()
	select {
	case address := <-listening:
		auth, _ := config["authToken"].(string)
		process := &proxyProcess{baseURL: "http://" + address, command: command, done: done, stderr: stderr, auth: auth}
		t.Cleanup(func() { process.stop(t) })
		return process
	case err := <-done:
		t.Fatalf("proxy exited before listen: %v\n%s", err, stderr.String())
	case <-time.After(15 * time.Second):
		_ = command.Process.Kill()
		t.Fatalf("proxy listen timeout\n%s", stderr.String())
	}
	return nil
}

func (process *proxyProcess) stop(t *testing.T) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	request, _ := http.NewRequestWithContext(ctx, http.MethodPost, process.baseURL+"/api/stop", nil)
	if process.auth != "" {
		request.Header.Set("Authorization", "Bearer "+process.auth)
	}
	if response, err := http.DefaultClient.Do(request); err == nil {
		_ = response.Body.Close()
	}
	cancel()
	select {
	case <-process.done:
		return
	case <-time.After(5 * time.Second):
		_ = process.command.Process.Kill()
		<-process.done
		t.Errorf("proxy required hard stop\n%s", process.stderr.String())
	}
}

func filteredEnvironment(environment []string, names ...string) []string {
	blocked := make(map[string]bool, len(names))
	for _, name := range names {
		blocked[name] = true
	}
	result := make([]string, 0, len(environment))
	for _, entry := range environment {
		name, _, _ := strings.Cut(entry, "=")
		if !blocked[name] {
			result = append(result, entry)
		}
	}
	return result
}

func postJSON(t *testing.T, url string, body any) (*http.Response, []byte) {
	t.Helper()
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(encoded))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	payload, err := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	return response, payload
}
