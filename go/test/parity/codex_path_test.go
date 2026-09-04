package parity_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
)

var injectedBaseURLPattern = regexp.MustCompile(`(?m)^(?:openai_)?base_url\s*=\s*"([^"]+)"`)

func TestCodexShimHelperProcess(t *testing.T) {
	if os.Getenv("GO_WANT_CODEX_SHIM_HELPER") != "1" {
		return
	}
	config, err := os.ReadFile(filepath.Join(os.Getenv("CODEX_HOME"), "config.toml"))
	if err != nil {
		t.Fatal(err)
	}
	match := injectedBaseURLPattern.FindSubmatch(config)
	if len(match) != 2 {
		t.Fatalf("injected OpenCodex base URL missing: %s", config)
	}
	for turn := 1; turn <= 4; turn++ {
		body, _ := json.Marshal(map[string]any{"model": "parity/success", "input": fmt.Sprintf("shim session turn %d", turn), "stream": false})
		response, err := http.Post(string(match[1])+"/responses", "application/json", bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		payload, readErr := io.ReadAll(response.Body)
		_ = response.Body.Close()
		if readErr != nil {
			t.Fatal(readErr)
		}
		if response.StatusCode != http.StatusOK || !strings.Contains(string(payload), `"status":"completed"`) {
			t.Fatalf("shim-routed turn %d status=%d body=%s", turn, response.StatusCode, payload)
		}
		_, _ = fmt.Fprintf(os.Stdout, "shim-proxy-ok turn=%d\n", turn)
	}
}

func TestBuiltBinaryCodexShimAndInjectedProxyPath(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix shim execution fixture")
	}
	upstream := newFakeUpstream(t)
	proxy := startProxy(t, upstream.server.URL)
	environment := append([]string(nil), proxy.command.Env...)

	runOCX := func(args ...string) string {
		t.Helper()
		command := exec.Command(parityBinary, args...)
		command.Env = environment
		output, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("ocx %s: %v\n%s", strings.Join(args, " "), err, output)
		}
		return string(output)
	}
	runOCX("sync")
	configPath := filepath.Join(proxy.home, "codex", "config.toml")
	config, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(config), proxy.baseURL+"/v1") || !strings.Contains(string(config), "model_catalog_json") {
		t.Fatalf("Codex config was not injected for live proxy %s: %s", proxy.baseURL, config)
	}

	fakeBin := t.TempDir()
	fakeCodex := filepath.Join(fakeBin, "codex")
	testBinary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	script := "#!/bin/sh\nexec \"$PARITY_TEST_BINARY\" -test.run=TestCodexShimHelperProcess -- \"$@\"\n"
	if err := os.WriteFile(fakeCodex, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	environment = append(filteredEnvironment(environment, "PATH", "PARITY_TEST_BINARY", "GO_WANT_CODEX_SHIM_HELPER"),
		"PATH="+fakeBin+string(os.PathListSeparator)+os.Getenv("PATH"),
		"PARITY_TEST_BINARY="+testBinary,
		"GO_WANT_CODEX_SHIM_HELPER=1",
	)
	runOCX("codex-shim", "install")
	upstream.mu.Lock()
	beforeTurns := len(upstream.observations)
	upstream.mu.Unlock()
	wrapped := exec.Command(fakeCodex, "run")
	wrapped.Env = environment
	output, err := wrapped.CombinedOutput()
	if err != nil {
		t.Fatalf("wrapped Codex invocation: %v\n%s", err, output)
	}
	if strings.Count(string(output), "shim-proxy-ok turn=") != 4 {
		t.Fatalf("wrapped Codex did not reach proxy: %s", output)
	}
	upstream.mu.Lock()
	afterTurns := len(upstream.observations)
	upstream.mu.Unlock()
	if afterTurns-beforeTurns != 4 {
		t.Fatalf("shim session upstream turns=%d want=4", afterTurns-beforeTurns)
	}
	runOCX("codex-shim", "uninstall")
	if restored, err := os.ReadFile(fakeCodex); err != nil || !bytes.Equal(restored, []byte(script)) {
		t.Fatalf("Codex shim backup was not restored: err=%v", err)
	}
}
