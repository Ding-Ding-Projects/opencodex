package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/combos"
	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/oauth"
)

var realWorldBaseURLPattern = regexp.MustCompile(`(?m)^(?:openai_)?base_url\s*=\s*"([^"]+)"`)

func TestRealWorldFakeCodexProcess(t *testing.T) {
	if os.Getenv("GO_WANT_REALWORLD_CODEX") != "1" {
		return
	}
	data, err := os.ReadFile(filepath.Join(os.Getenv("CODEX_HOME"), "config.toml"))
	if err != nil {
		t.Fatal(err)
	}
	match := realWorldBaseURLPattern.FindSubmatch(data)
	if len(match) != 2 {
		t.Fatalf("OpenCodex base URL missing: %s", data)
	}
	payload, _ := json.Marshal(map[string]any{"model": "local/probe", "input": "shim", "stream": false})
	response, err := http.Post(string(match[1])+"/responses", "application/json", bytes.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	if response.StatusCode != http.StatusOK || !bytes.Contains(body, []byte("shim-ok")) {
		t.Fatalf("proxy status=%d body=%s", response.StatusCode, body)
	}
	_, _ = fmt.Fprintln(os.Stdout, "realworld-shim-ok")
}

func TestBuiltBinarySyncShimRestoreBackRoundTrip(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix executable shim fixture")
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writeChatCompletion(writer, "shim-ok")
	}))
	defer upstream.Close()
	binary, ocxHome, codexHome, home := buildIsolatedOCX(t)
	cfg := localProviderConfig(upstream.URL)
	if err := config.Save(filepath.Join(ocxHome, "config.json"), &cfg); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(codexHome, "config.toml"), []byte("# native-marker\nmodel = \"native-model\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	serve, logs := startIsolatedOCX(t, binary, ocxHome, codexHome, home)
	port := waitRuntimePort(t, filepath.Join(ocxHome, "runtime-port"))
	environment := isolatedEnvironment(ocxHome, codexHome, home)
	runBuiltOCX(t, binary, environment, "sync")
	assertCodexConfigContains(t, codexHome, "base_url", "model_catalog_json")

	fakeBin := t.TempDir()
	fakeCodex := filepath.Join(fakeBin, "codex")
	testBinary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	script := "#!/bin/sh\nexec \"$REALWORLD_TEST_BINARY\" -test.run=TestRealWorldFakeCodexProcess -- \"$@\"\n"
	if err := os.WriteFile(fakeCodex, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	environment = append(environment,
		"PATH="+strings.Join([]string{fakeBin, "/usr/bin", "/bin"}, string(os.PathListSeparator)),
		"REALWORLD_TEST_BINARY="+testBinary,
		"GO_WANT_REALWORLD_CODEX=1",
	)
	runBuiltOCX(t, binary, environment, "codex-shim", "install")
	command := exec.Command(fakeCodex, "exec")
	command.Env = environment
	if output, err := command.CombinedOutput(); err != nil || !bytes.Contains(output, []byte("realworld-shim-ok")) {
		t.Fatalf("fake codex: %v\n%s", err, output)
	}

	runBuiltOCX(t, binary, environment, "restore")
	assertCodexConfigContains(t, codexHome, "native-marker")
	runBuiltOCX(t, binary, environment, "restore", "back")
	assertCodexConfigContains(t, codexHome, "base_url", "model_catalog_json")
	runBuiltOCX(t, binary, environment, "codex-shim", "uninstall")
	if restored, err := os.ReadFile(fakeCodex); err != nil || string(restored) != script {
		t.Fatalf("shim original not restored: %v", err)
	}
	stopIsolatedOCX(t, serve, port, logs)
}

func TestBuiltServeAddsRoutesAndDeletesProviderImmediately(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writeChatCompletion(writer, "dynamic-ok")
	}))
	defer upstream.Close()
	binary, ocxHome, codexHome, home := buildIsolatedOCX(t)
	cfg := localProviderConfig(upstream.URL)
	if err := config.Save(filepath.Join(ocxHome, "config.json"), &cfg); err != nil {
		t.Fatal(err)
	}
	serve, logs := startIsolatedOCX(t, binary, ocxHome, codexHome, home)
	port := waitRuntimePort(t, filepath.Join(ocxHome, "runtime-port"))
	provider := config.ProviderConfig{Adapter: "openai-chat", BaseURL: upstream.URL + "/v1", APIKey: "dynamic-key", AuthMode: "key", DefaultModel: "dynamic", Models: []string{"dynamic"}, AllowPrivateNetwork: true}
	status := managementJSON(t, port, http.MethodPost, "/api/providers", map[string]any{"name": "dynamic", "provider": provider})
	if status != http.StatusOK {
		t.Fatalf("provider add status=%d logs=%s", status, logs.String())
	}
	if status = postModelStatus(t, port, "dynamic/dynamic"); status != http.StatusOK {
		t.Fatalf("new provider route status=%d logs=%s", status, logs.String())
	}
	status = managementJSON(t, port, http.MethodDelete, "/api/providers?name=dynamic", nil)
	if status != http.StatusOK {
		t.Fatalf("provider delete status=%d", status)
	}
	if status = postModelStatus(t, port, "dynamic/dynamic"); status < http.StatusBadRequest {
		t.Fatalf("deleted provider still routed status=%d", status)
	}
	stopIsolatedOCX(t, serve, port, logs)
}

func TestBuiltServeComboRateLimitSwitchesOpenAIAccount(t *testing.T) {
	var mu sync.Mutex
	seen := []string{}
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		var body struct {
			Model string `json:"model"`
		}
		_ = json.NewDecoder(request.Body).Decode(&body)
		authorization := request.Header.Get("Authorization")
		mu.Lock()
		seen = append(seen, authorization+"/"+body.Model)
		mu.Unlock()
		if body.Model == "rate-limited" {
			writer.Header().Set("Content-Type", "application/json")
			writer.Header().Set("Retry-After", "60")
			writer.WriteHeader(http.StatusTooManyRequests)
			_, _ = io.WriteString(writer, `{"error":{"message":"quota exhausted","type":"insufficient_quota"}}`)
			return
		}
		writeResponsesCompletion(writer, "combo-account-ok")
	}))
	defer upstream.Close()
	binary, ocxHome, codexHome, home := buildIsolatedOCX(t)
	cfg := config.FreshInstall()
	cfg.Port = 0
	provider := cfg.Providers["openai"]
	provider.BaseURL, provider.AllowPrivateNetwork = upstream.URL+"/v1", true
	provider.Models = []string{"rate-limited", "fallback"}
	provider.CodexAccountMode = ""
	cfg.Providers["openai"] = provider
	cfg.Combos["pooled"] = combos.Combo{Strategy: combos.StrategyFailover, MaxHops: 1, Targets: []combos.Target{{Provider: "openai", Model: "rate-limited"}, {Provider: "openai", Model: "fallback"}}}
	if err := config.Save(filepath.Join(ocxHome, "config.json"), &cfg); err != nil {
		t.Fatal(err)
	}
	store := oauth.NewCredentialStore(filepath.Join(ocxHome, "auth.json"))
	for index, token := range []string{"combo-token-one", "combo-token-two"} {
		credential := oauth.OAuthCredentials{Access: token, Refresh: "refresh", Expires: time.Now().Add(time.Hour).UnixMilli(), AccountID: fmt.Sprintf("combo-account-%d", index)}
		if err := store.SaveCredential(context.Background(), "openai", credential); err != nil {
			t.Fatal(err)
		}
	}
	serve, logs := startIsolatedOCX(t, binary, ocxHome, codexHome, home)
	port := waitRuntimePort(t, filepath.Join(ocxHome, "runtime-port"))
	if status := postModelStatus(t, port, "combo/pooled"); status != http.StatusOK {
		t.Fatalf("combo status=%d logs=%s", status, logs.String())
	}
	mu.Lock()
	defer mu.Unlock()
	want := []string{"Bearer combo-token-one/rate-limited", "Bearer combo-token-two/fallback"}
	if len(seen) != len(want) || seen[0] != want[0] || seen[1] != want[1] {
		t.Fatalf("account/combo transitions=%v want=%v", seen, want)
	}
	stopIsolatedOCX(t, serve, port, logs)
}

func TestBuiltBinaryRecoversMalformedAndPartialConfig(t *testing.T) {
	binary, ocxHome, codexHome, home := buildIsolatedOCX(t)
	path := filepath.Join(ocxHome, "config.json")
	environment := isolatedEnvironment(ocxHome, codexHome, home)
	if err := os.WriteFile(path, []byte(`{"providers":`), 0o600); err != nil {
		t.Fatal(err)
	}
	output := runBuiltOCX(t, binary, environment, "config", "show", "--json")
	if !strings.Contains(output, `"defaultProvider": "openai"`) {
		t.Fatalf("malformed fallback output=%s", output)
	}
	backups, err := filepath.Glob(path + ".invalid-*")
	if err != nil || len(backups) != 1 {
		t.Fatalf("invalid backups=%v err=%v", backups, err)
	}
	partial := `{"port":0,"providers":{"partial":{"adapter":"openai-chat","baseUrl":"https://partial.example/v1","apiKey":"partial-secret","authMode":"key","models":["partial-model"]}}}`
	if err := os.WriteFile(path, []byte(partial), 0o600); err != nil {
		t.Fatal(err)
	}
	output = runBuiltOCX(t, binary, environment, "config", "show", "--json")
	if !strings.Contains(output, `"partial"`) || !strings.Contains(output, `"openai"`) || strings.Contains(output, "partial-secret") {
		t.Fatalf("partial repair/redaction output=%s", output)
	}
	typedHome := filepath.Join(home, "typed-ocx")
	if err := os.MkdirAll(typedHome, 0o700); err != nil {
		t.Fatal(err)
	}
	typedPath := filepath.Join(typedHome, "config.json")
	passthrough := `{"port":0,"providers":{"typed":{"adapter":"openai-chat","baseUrl":"https://typed.example/v1","apiKey":"typed-secret","authMode":"key","models":["typed-model"]}},"defaultProvider":"typed","websockets":"true"}`
	if err := os.WriteFile(typedPath, []byte(passthrough), 0o600); err != nil {
		t.Fatal(err)
	}
	before, err := filepath.Glob(typedPath + ".invalid-*")
	if err != nil {
		t.Fatal(err)
	}
	output = runBuiltOCX(t, binary, isolatedEnvironment(typedHome, codexHome, home), "config", "show", "--json")
	if !strings.Contains(output, `"defaultProvider": "typed"`) || !strings.Contains(output, `"websockets": "true"`) || strings.Contains(output, "typed-secret") {
		t.Fatalf("passthrough type/redaction output=%s", output)
	}
	after, err := filepath.Glob(typedPath + ".invalid-*")
	if err != nil || len(after) != len(before) {
		t.Fatalf("passthrough field created backup: before=%v after=%v err=%v", before, after, err)
	}
}

func TestBuiltBinaryHandlesDiskAndPortFailuresWithoutPanic(t *testing.T) {
	binary, ocxHome, codexHome, home := buildIsolatedOCX(t)
	blockedHome := filepath.Join(t.TempDir(), "blocked-home")
	if err := os.WriteFile(blockedHome, []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}
	command := exec.Command(binary, "config", "set", "port", "12000")
	command.Env = isolatedEnvironment(blockedHome, codexHome, home)
	output, err := command.CombinedOutput()
	if err == nil || bytes.Contains(bytes.ToLower(output), []byte("panic:")) {
		t.Fatalf("disk failure err=%v output=%s", err, output)
	}

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	port := listener.Addr().(*net.TCPAddr).Port
	cfg := config.FreshInstall()
	cfg.Port = port
	if err := config.Save(filepath.Join(ocxHome, "config.json"), &cfg); err != nil {
		t.Fatal(err)
	}
	command = exec.Command(binary, "serve")
	command.Env = isolatedEnvironment(ocxHome, codexHome, home)
	output, err = command.CombinedOutput()
	if err == nil || bytes.Contains(bytes.ToLower(output), []byte("panic:")) || !bytes.Contains(bytes.ToLower(output), []byte("unavailable")) {
		t.Fatalf("occupied port err=%v output=%s", err, output)
	}
}

func localProviderConfig(upstream string) config.Config {
	cfg := config.FreshInstall()
	cfg.Port, cfg.DefaultProvider = 0, "local"
	cfg.Providers = map[string]config.ProviderConfig{"local": {Adapter: "openai-chat", BaseURL: upstream + "/v1", APIKey: "local-key", AuthMode: "key", DefaultModel: "probe", Models: []string{"probe"}, AllowPrivateNetwork: true}}
	return cfg
}

func isolatedEnvironment(ocxHome, codexHome, home string) []string {
	return append(os.Environ(), "OPENCODEX_HOME="+ocxHome, "CODEX_HOME="+codexHome, "HOME="+home, "USERPROFILE="+home)
}

func runBuiltOCX(t *testing.T, binary string, environment []string, args ...string) string {
	t.Helper()
	command := exec.Command(binary, args...)
	command.Env = environment
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("ocx %s: %v\n%s", strings.Join(args, " "), err, output)
	}
	return string(output)
}

func assertCodexConfigContains(t *testing.T, codexHome string, fragments ...string) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(codexHome, "config.toml"))
	if err != nil {
		t.Fatal(err)
	}
	for _, fragment := range fragments {
		if !bytes.Contains(data, []byte(fragment)) {
			t.Fatalf("config.toml missing %q: %s", fragment, data)
		}
	}
}

func managementJSON(t *testing.T, port int, method, path string, value any) int {
	t.Helper()
	var body io.Reader
	if value != nil {
		encoded, _ := json.Marshal(value)
		body = bytes.NewReader(encoded)
	}
	request, _ := http.NewRequest(method, "http://127.0.0.1:"+strconv.Itoa(port)+path, body)
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	return response.StatusCode
}

func postModelStatus(t *testing.T, port int, model string) int {
	t.Helper()
	payload, _ := json.Marshal(map[string]any{"model": model, "input": "scenario", "stream": false})
	response, err := http.Post("http://127.0.0.1:"+strconv.Itoa(port)+"/v1/responses", "application/json", bytes.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	return response.StatusCode
}

func writeChatCompletion(writer http.ResponseWriter, text string) {
	writer.Header().Set("Content-Type", "application/json")
	_, _ = io.WriteString(writer, `{"id":"chatcmpl-real","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"`+text+`"},"finish_reason":"stop"}]}`)
}

func writeResponsesCompletion(writer http.ResponseWriter, text string) {
	writer.Header().Set("Content-Type", "application/json")
	_, _ = io.WriteString(writer, `{"id":"resp-real","object":"response","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"`+text+`"}]}]}`)
}
