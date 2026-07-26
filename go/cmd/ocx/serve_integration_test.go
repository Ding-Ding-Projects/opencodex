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
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/oauth"
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

func TestBuiltServePersistsSelectedPreferredPortThroughProductionAssembly(t *testing.T) {
	binary, ocxHome, codexHome, home := buildIsolatedOCX(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	preferredPort := listener.Addr().(*net.TCPAddr).Port
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}

	cfg := config.FreshInstall()
	cfg.Port = 0
	configPath := filepath.Join(ocxHome, "config.json")
	if err := config.Save(configPath, &cfg); err != nil {
		t.Fatal(err)
	}
	command := exec.Command(binary, "serve", "--port", strconv.Itoa(preferredPort))
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
	waitHTTPReady(t, preferredPort, &logs)

	persisted, err := config.Load(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if persisted.Port != preferredPort {
		t.Fatalf("persisted port = %d, want selected preferred port %d", persisted.Port, preferredPort)
	}
	stopIsolatedOCX(t, command, preferredPort, &logs)
}

func waitRuntimePort(t *testing.T, path string) int {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if data, err := os.ReadFile(path); err == nil {
			if port, err := strconv.Atoi(strings.TrimSpace(string(data))); err == nil && port > 0 {
				response, requestErr := http.Get("http://127.0.0.1:" + strconv.Itoa(port) + "/healthz")
				if requestErr == nil {
					response.Body.Close()
					if response.StatusCode == http.StatusOK {
						return port
					}
				}
			}
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("runtime port was not written: %s", path)
	return 0
}

func TestBuiltServeRoutesModelsAcrossConfiguredProviders(t *testing.T) {
	observed := make(chan string, 2)
	newUpstream := func(name string) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			observed <- name + ":" + request.URL.Path
			writer.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(writer, `{"id":"chatcmpl-route","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"`+name+`"},"finish_reason":"stop"}]}`)
		}))
	}
	alpha, beta := newUpstream("alpha"), newUpstream("beta")
	defer alpha.Close()
	defer beta.Close()

	binary, ocxHome, codexHome, home := buildIsolatedOCX(t)
	cfg := config.FreshInstall()
	cfg.Port, cfg.DefaultProvider = 0, "alpha"
	cfg.Providers = map[string]config.ProviderConfig{
		"alpha": {Adapter: "openai-chat", BaseURL: alpha.URL + "/v1", APIKey: "alpha-key", AuthMode: "key", DefaultModel: "one", Models: []string{"one"}, AllowPrivateNetwork: true},
		"beta":  {Adapter: "openai-chat", BaseURL: beta.URL + "/v1", APIKey: "beta-key", AuthMode: "key", DefaultModel: "two", Models: []string{"two"}, AllowPrivateNetwork: true},
	}
	if err := config.Save(filepath.Join(ocxHome, "config.json"), &cfg); err != nil {
		t.Fatal(err)
	}
	command, logs := startIsolatedOCX(t, binary, ocxHome, codexHome, home)
	port := waitRuntimePort(t, filepath.Join(ocxHome, "runtime-port"))
	for _, model := range []string{"alpha/one", "beta/two"} {
		payload, _ := json.Marshal(map[string]any{"model": model, "input": "route", "stream": false})
		response, err := http.Post("http://127.0.0.1:"+strconv.Itoa(port)+"/v1/responses", "application/json", bytes.NewReader(payload))
		if err != nil {
			t.Fatalf("request %s: %v\n%s", model, err, logs.String())
		}
		response.Body.Close()
		if response.StatusCode != http.StatusOK {
			t.Fatalf("request %s status=%d logs=%s", model, response.StatusCode, logs.String())
		}
	}
	seen := map[string]bool{}
	for range 2 {
		select {
		case route := <-observed:
			seen[route] = true
		case <-time.After(3 * time.Second):
			t.Fatal("timed out waiting for routed upstream request")
		}
	}
	if !seen["alpha:/v1/chat/completions"] || !seen["beta:/v1/chat/completions"] {
		t.Fatalf("routes = %#v", seen)
	}
	stopIsolatedOCX(t, command, port, logs)
}

func TestBuiltServeRestoresOAuthAccountAfterCrashAndReclaimsPort(t *testing.T) {
	binary, ocxHome, codexHome, home := buildIsolatedOCX(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()

	cfg := config.FreshInstall()
	cfg.Port = port
	if err := config.Save(filepath.Join(ocxHome, "config.json"), &cfg); err != nil {
		t.Fatal(err)
	}
	store := oauth.NewCredentialStore(filepath.Join(ocxHome, "auth.json"))
	credential := oauth.OAuthCredentials{Access: "temporary-access-token", Refresh: "temporary-refresh-token", Expires: time.Now().Add(time.Hour).UnixMilli(), Email: "roundtrip@example.test"}
	if err := store.SaveCredential(context.Background(), "xai", credential); err != nil {
		t.Fatal(err)
	}

	first, firstLogs := startIsolatedOCX(t, binary, ocxHome, codexHome, home)
	waitHTTPReady(t, port, firstLogs)
	firstAccount := readOAuthAccountSet(t, port)
	if err := first.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = first.Wait()

	second, secondLogs := startIsolatedOCX(t, binary, ocxHome, codexHome, home)
	waitHTTPReady(t, port, secondLogs)
	secondAccount := readOAuthAccountSet(t, port)
	if firstAccount != secondAccount || !strings.Contains(secondAccount, `"activeAccountId"`) {
		t.Fatalf("OAuth account was not restored\nfirst=%s\nsecond=%s", firstAccount, secondAccount)
	}
	if strings.Contains(secondAccount, credential.Access) || strings.Contains(secondAccount, credential.Refresh) {
		t.Fatal("OAuth management response leaked a token")
	}
	stopIsolatedOCX(t, second, port, secondLogs)
}

func TestBuiltServeAppliesManagementProviderChangeToNextRequest(t *testing.T) {
	oldRequests, newRequests := make(chan struct{}, 1), make(chan struct{}, 1)
	upstream := func(observed chan<- struct{}) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
			observed <- struct{}{}
			writer.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(writer, `{"id":"chatcmpl-live","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}`)
		}))
	}
	oldUpstream, newUpstream := upstream(oldRequests), upstream(newRequests)
	defer oldUpstream.Close()
	defer newUpstream.Close()
	binary, ocxHome, codexHome, home := buildIsolatedOCX(t)
	cfg := config.FreshInstall()
	cfg.Port, cfg.DefaultProvider = 0, "live"
	cfg.Providers = map[string]config.ProviderConfig{"live": {Adapter: "openai-chat", BaseURL: oldUpstream.URL + "/v1", APIKey: "live-key", AuthMode: "key", DefaultModel: "model", Models: []string{"model"}, AllowPrivateNetwork: true}}
	if err := config.Save(filepath.Join(ocxHome, "config.json"), &cfg); err != nil {
		t.Fatal(err)
	}
	command, logs := startIsolatedOCX(t, binary, ocxHome, codexHome, home)
	port := waitRuntimePort(t, filepath.Join(ocxHome, "runtime-port"))
	postModelRequest(t, port, "live/model", logs)
	select {
	case <-oldRequests:
	case <-time.After(3 * time.Second):
		t.Fatal("initial upstream did not receive request")
	}
	patchBody, _ := json.Marshal(map[string]any{"baseUrl": newUpstream.URL + "/v1"})
	request, _ := http.NewRequest(http.MethodPatch, "http://127.0.0.1:"+strconv.Itoa(port)+"/api/providers?name=live", bytes.NewReader(patchBody))
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("provider patch status=%d logs=%s", response.StatusCode, logs.String())
	}
	postModelRequest(t, port, "live/model", logs)
	select {
	case <-newRequests:
	case <-time.After(3 * time.Second):
		t.Fatal("updated upstream did not receive next request")
	}
	stopIsolatedOCX(t, command, port, logs)
}

func TestBuiltServeUsesOpenAIAccountPoolAcrossThreads(t *testing.T) {
	authorizations := make(chan string, 2)
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		authorizations <- request.Header.Get("Authorization")
		writer.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(writer, `{"id":"resp-pool","object":"response","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}]}`)
	}))
	defer upstream.Close()
	binary, ocxHome, codexHome, home := buildIsolatedOCX(t)
	cfg := config.FreshInstall()
	cfg.Port = 0
	provider := cfg.Providers["openai"]
	provider.BaseURL, provider.AllowPrivateNetwork = upstream.URL+"/v1", true
	provider.Models, provider.DefaultModel = []string{"pool-model"}, "pool-model"
	provider.CodexAccountMode = "" // omitted mode defaults to pool for the canonical provider id
	cfg.Providers["openai"] = provider
	if err := config.Save(filepath.Join(ocxHome, "config.json"), &cfg); err != nil {
		t.Fatal(err)
	}
	store := oauth.NewCredentialStore(filepath.Join(ocxHome, "auth.json"))
	for index, token := range []string{"pool-token-one", "pool-token-two"} {
		credential := oauth.OAuthCredentials{Access: token, Refresh: "refresh", Expires: time.Now().Add(time.Hour).UnixMilli(), AccountID: fmt.Sprintf("pool-account-%d", index)}
		if err := store.SaveCredential(context.Background(), "openai", credential); err != nil {
			t.Fatal(err)
		}
	}
	command, logs := startIsolatedOCX(t, binary, ocxHome, codexHome, home)
	port := waitRuntimePort(t, filepath.Join(ocxHome, "runtime-port"))
	for _, threadID := range []string{"pool-thread-one", "pool-thread-two"} {
		payload, _ := json.Marshal(map[string]any{"model": "pool-model", "input": "pool", "stream": false})
		request, _ := http.NewRequest(http.MethodPost, "http://127.0.0.1:"+strconv.Itoa(port)+"/v1/responses", bytes.NewReader(payload))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("thread-id", threadID)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatalf("pool request: %v\n%s", err, logs.String())
		}
		response.Body.Close()
		if response.StatusCode != http.StatusOK {
			t.Fatalf("pool response status=%d logs=%s", response.StatusCode, logs.String())
		}
	}
	seen := map[string]bool{}
	for range 2 {
		select {
		case authorization := <-authorizations:
			seen[authorization] = true
		case <-time.After(3 * time.Second):
			t.Fatal("timed out waiting for pooled upstream request")
		}
	}
	if !seen["Bearer pool-token-one"] || !seen["Bearer pool-token-two"] {
		t.Fatalf("pooled authorizations = %#v", seen)
	}
	stopIsolatedOCX(t, command, port, logs)
}

func postModelRequest(t *testing.T, port int, model string, logs *bytes.Buffer) {
	t.Helper()
	payload, _ := json.Marshal(map[string]any{"model": model, "input": "live config", "stream": false})
	response, err := http.Post("http://127.0.0.1:"+strconv.Itoa(port)+"/v1/responses", "application/json", bytes.NewReader(payload))
	if err != nil {
		t.Fatalf("model request: %v\n%s", err, logs.String())
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("model request status=%d logs=%s", response.StatusCode, logs.String())
	}
}

func buildIsolatedOCX(t *testing.T) (binary, ocxHome, codexHome, home string) {
	t.Helper()
	root := t.TempDir()
	binary = filepath.Join(root, "ocx-serve-test")
	if runtime.GOOS == "windows" {
		binary += ".exe"
	}
	if output, err := exec.Command("go", "build", "-o", binary, ".").CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, output)
	}
	ocxHome, codexHome, home = filepath.Join(root, "ocx"), filepath.Join(root, "codex"), filepath.Join(root, "home")
	for _, dir := range []string{ocxHome, codexHome, home} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	return binary, ocxHome, codexHome, home
}

func startIsolatedOCX(t *testing.T, binary, ocxHome, codexHome, home string) (*exec.Cmd, *bytes.Buffer) {
	t.Helper()
	command := exec.Command(binary, "serve")
	command.Env = append(os.Environ(), "OPENCODEX_HOME="+ocxHome, "CODEX_HOME="+codexHome, "HOME="+home, "USERPROFILE="+home)
	logs := &bytes.Buffer{}
	command.Stdout, command.Stderr = logs, logs
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if command.ProcessState == nil {
			_ = command.Process.Kill()
			_, _ = command.Process.Wait()
		}
	})
	return command, logs
}

func waitHTTPReady(t *testing.T, port int, logs *bytes.Buffer) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		response, err := http.Get("http://127.0.0.1:" + strconv.Itoa(port) + "/healthz")
		if err == nil {
			response.Body.Close()
			if response.StatusCode == http.StatusOK {
				return
			}
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("serve did not become ready: %s", logs.String())
}

func readOAuthAccountSet(t *testing.T, port int) string {
	t.Helper()
	response, err := http.Get("http://127.0.0.1:" + strconv.Itoa(port) + "/api/oauth/accounts?provider=xai")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("OAuth accounts status=%d body=%s", response.StatusCode, body)
	}
	return string(body)
}

func stopIsolatedOCX(t *testing.T, command *exec.Cmd, port int, logs *bytes.Buffer) {
	t.Helper()
	request, _ := http.NewRequest(http.MethodPost, "http://127.0.0.1:"+strconv.Itoa(port)+"/api/stop", nil)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("stop: %v\n%s", err, logs.String())
	}
	response.Body.Close()
	if err := command.Wait(); err != nil {
		t.Fatalf("serve exit: %v\n%s", err, logs.String())
	}
}
