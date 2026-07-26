package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/config"
)

func TestBuiltServeProxiesConfiguredProviderAndStops(t *testing.T) {
	requests := make(chan *http.Request, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		requests <- request.Clone(request.Context())
		writer.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(writer, `{"id":"chatcmpl-test","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"pong"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`)
	}))
	defer upstream.Close()
	root := t.TempDir()
	binary := filepath.Join(root, "ocx-serve-test")
	if runtime.GOOS == "windows" {
		binary += ".exe"
	}
	if output, err := exec.Command("go", "build", "-o", binary, ".").CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, output)
	}
	ocxHome, codexHome, home := filepath.Join(root, "ocx"), filepath.Join(root, "codex"), filepath.Join(root, "home")
	for _, dir := range []string{ocxHome, codexHome, home} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	cfg := config.FreshInstall()
	cfg.Port, cfg.DefaultProvider = 0, "local"
	cfg.Providers = map[string]config.ProviderConfig{"local": {Adapter: "openai-chat", BaseURL: upstream.URL + "/v1", APIKey: "local-secret", AuthMode: "key", DefaultModel: "probe", Models: []string{"probe"}, AllowPrivateNetwork: true}}
	if err := config.Save(filepath.Join(ocxHome, "config.json"), &cfg); err != nil {
		t.Fatal(err)
	}
	command := exec.Command(binary, "serve")
	command.Env = append(os.Environ(), "OPENCODEX_HOME="+ocxHome, "CODEX_HOME="+codexHome, "HOME="+home, "USERPROFILE="+home)
	var logs bytes.Buffer
	command.Stdout, command.Stderr = &logs, &logs
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if command.ProcessState == nil {
			_ = command.Process.Kill()
			_, _ = command.Process.Wait()
		}
	})
	port := waitRuntimePort(t, filepath.Join(ocxHome, "runtime-port"))
	payload, _ := json.Marshal(map[string]any{"model": "local/probe", "input": "ping", "stream": false})
	response, err := http.Post("http://127.0.0.1:"+strconv.Itoa(port)+"/v1/responses", "application/json", bytes.NewReader(payload))
	if err != nil {
		t.Fatalf("proxy request: %v\n%s", err, logs.String())
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != http.StatusOK || !strings.Contains(string(body), "pong") {
		t.Fatalf("status=%d body=%s logs=%s", response.StatusCode, body, logs.String())
	}
	select {
	case request := <-requests:
		if request.URL.Path != "/v1/chat/completions" || request.Header.Get("Authorization") != "Bearer local-secret" {
			t.Fatalf("upstream=%s headers=%#v", request.URL.Path, request.Header)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("upstream request not observed")
	}
	stop, err := http.NewRequest(http.MethodPost, "http://127.0.0.1:"+strconv.Itoa(port)+"/api/stop", nil)
	if err != nil {
		t.Fatal(err)
	}
	if stopped, err := http.DefaultClient.Do(stop); err != nil {
		t.Fatal(err)
	} else {
		stopped.Body.Close()
	}
	if err := command.Wait(); err != nil {
		t.Fatalf("serve exit: %v\n%s", err, logs.String())
	}
}

func waitRuntimePort(t *testing.T, path string) int {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if data, err := os.ReadFile(path); err == nil {
			if port, err := strconv.Atoi(strings.TrimSpace(string(data))); err == nil && port > 0 {
				return port
			}
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("runtime port was not written: %s", path)
	return 0
}
