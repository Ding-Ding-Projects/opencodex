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

// TestBuiltBinaryRunsCoreWithoutExternalRuntime proves that the release-shaped
// Go executable does not need Bun, Node.js, npm, or a source checkout for its
// core CLI, HTTP server, embedded root document, and provider proxy paths.
func TestBuiltBinaryRunsCoreWithoutExternalRuntime(t *testing.T) {
	requests := make(chan struct{}, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		requests <- struct{}{}
		writeChatCompletion(writer, "standalone-ok")
	}))
	defer upstream.Close()

	binary, ocxHome, codexHome, home := buildIsolatedOCX(t)
	cfg := localProviderConfig(upstream.URL)
	if err := config.Save(filepath.Join(ocxHome, "config.json"), &cfg); err != nil {
		t.Fatal(err)
	}
	emptyPath := t.TempDir()
	environment := standaloneEnvironment(emptyPath, ocxHome, codexHome, home)

	commands := [][]string{
		{"--version"},
		{"--help"},
		{"status", "--json"},
		{"doctor", "--json"},
		{"provider", "list", "--json"},
		{"models", "list", "--json"},
		{"config", "show", "--json"},
	}
	for _, args := range commands {
		command := exec.Command(binary, args...)
		command.Env = environment
		command.Dir = emptyPath
		output, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("standalone ocx %s: %v\n%s", strings.Join(args, " "), err, output)
		}
		if len(bytes.TrimSpace(output)) == 0 {
			t.Fatalf("standalone ocx %s returned no output", strings.Join(args, " "))
		}
	}

	serve := exec.Command(binary, "serve")
	serve.Env = environment
	serve.Dir = emptyPath
	logs := &bytes.Buffer{}
	serve.Stdout, serve.Stderr = logs, logs
	if err := serve.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if serve.ProcessState == nil {
			_ = serve.Process.Kill()
			_, _ = serve.Process.Wait()
		}
	})
	port := waitRuntimePort(t, filepath.Join(ocxHome, "runtime-port"))
	waitHTTPReady(t, port, logs)

	rootResponse, err := http.Get("http://127.0.0.1:" + strconv.Itoa(port) + "/")
	if err != nil {
		t.Fatalf("embedded root: %v\n%s", err, logs.String())
	}
	rootBody, _ := io.ReadAll(rootResponse.Body)
	rootResponse.Body.Close()
	if rootResponse.StatusCode != http.StatusOK || !strings.Contains(rootResponse.Header.Get("Content-Type"), "text/html") || !bytes.Contains(rootBody, []byte("OpenCodex")) {
		t.Fatalf("embedded root status=%d content-type=%q body=%s", rootResponse.StatusCode, rootResponse.Header.Get("Content-Type"), rootBody)
	}

	payload, _ := json.Marshal(map[string]any{"model": "local/probe", "input": "standalone", "stream": false})
	proxyResponse, err := http.Post("http://127.0.0.1:"+strconv.Itoa(port)+"/v1/responses", "application/json", bytes.NewReader(payload))
	if err != nil {
		t.Fatalf("standalone proxy: %v\n%s", err, logs.String())
	}
	proxyBody, _ := io.ReadAll(proxyResponse.Body)
	proxyResponse.Body.Close()
	if proxyResponse.StatusCode != http.StatusOK || !bytes.Contains(proxyBody, []byte("standalone-ok")) {
		t.Fatalf("standalone proxy status=%d body=%s logs=%s", proxyResponse.StatusCode, proxyBody, logs.String())
	}
	select {
	case <-requests:
	case <-time.After(3 * time.Second):
		t.Fatal("standalone proxy did not reach the configured upstream")
	}
	stopIsolatedOCX(t, serve, port, logs)
}

func standaloneEnvironment(path, ocxHome, codexHome, home string) []string {
	environment := []string{
		"PATH=" + path,
		"OPENCODEX_HOME=" + ocxHome,
		"CODEX_HOME=" + codexHome,
		"HOME=" + home,
		"USERPROFILE=" + home,
		"TMPDIR=" + home,
		"TMP=" + home,
		"TEMP=" + home,
		"OCX_SERVICE=1",
	}
	if runtime.GOOS == "windows" {
		for _, name := range []string{"SystemRoot", "WINDIR"} {
			if value := os.Getenv(name); value != "" {
				environment = append(environment, name+"="+value)
			}
		}
	}
	return environment
}
