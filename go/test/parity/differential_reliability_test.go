package parity_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"sync"
	"testing"

	configpkg "github.com/lidge-jun/opencodex-go/internal/config"
)

func TestTypeScriptAndGoMultipleProviderRoutingIsolation(t *testing.T) {
	alpha := newTaggedProviderUpstream(t, "alpha")
	beta := newTaggedProviderUpstream(t, "beta")
	config := map[string]any{
		"port": 0, "hostname": "127.0.0.1", "defaultProvider": "alpha",
		"providers": map[string]any{
			"alpha": providerFixture("openai-chat", alpha.URL+"/v1", "shared"),
			"beta":  providerFixture("openai-chat", beta.URL+"/v1", "shared"),
		},
	}
	tsProxy := startTypeScriptProxy(t, config)
	goProxy := startProxyWithConfig(t, config)

	type result struct {
		provider string
		goBody   runtimeResponse
		tsBody   runtimeResponse
	}
	results := make(chan result, 16)
	var group sync.WaitGroup
	for index := range 8 {
		for _, provider := range []string{"alpha", "beta"} {
			group.Add(1)
			go func() {
				defer group.Done()
				body := map[string]any{"model": provider + "/shared", "stream": false, "messages": []any{map[string]any{"role": "user", "content": fmt.Sprintf("request-%d", index)}}}
				results <- result{provider, captureJSON(t, goProxy.baseURL, "/v1/chat/completions", body), captureJSON(t, tsProxy.baseURL, "/v1/chat/completions", body)}
			}()
		}
	}
	group.Wait()
	close(results)
	for captured := range results {
		if captured.goBody.status != http.StatusOK || captured.tsBody.status != http.StatusOK {
			t.Fatalf("%s route status Go=%d TypeScript=%d GoBody=%s TypeScriptBody=%s", captured.provider, captured.goBody.status, captured.tsBody.status, captured.goBody.body, captured.tsBody.body)
		}
		compareTaggedChatResponse(t, captured.provider, captured.goBody.body, captured.tsBody.body)
	}
}

func TestTypeScriptAndGoOAuthAccountHealthProjection(t *testing.T) {
	config := differentialConfig("https://oauth.invalid", []string{"probe"})
	setup := func(home string) {
		writeOAuthHealthAccounts(t, home)
	}
	tsProxy := startTypeScriptProxyWithSetup(t, config, setup)
	goProxy := startProxyWithSetup(t, config, setup)
	goResult := captureManagementRequest(t, goProxy.baseURL, http.MethodGet, "/api/oauth/accounts?provider=xai", "", nil)
	tsResult := captureManagementRequest(t, tsProxy.baseURL, http.MethodGet, "/api/oauth/accounts?provider=xai", "", nil)
	assertSecretAbsent(t, goResult, "synthetic-oauth")
	assertSecretAbsent(t, tsResult, "synthetic-oauth")
	compareRuntimeBytes(t, "oauth/account-health", goResult, tsResult, true)
}

func writeOAuthHealthAccounts(t *testing.T, home string) {
	t.Helper()
	data, err := json.Marshal(map[string]any{"xai": map[string]any{
		"activeAccountId": "account-a",
		"accounts": []any{
			map[string]any{"id": "account-a", "credential": map[string]any{"access": "synthetic-oauth-a", "refresh": "synthetic-refresh-a", "expires": int64(4_102_444_800_000)}},
			map[string]any{"id": "account-b", "needsReauth": true, "credential": map[string]any{"access": "synthetic-oauth-b", "refresh": "synthetic-refresh-b", "expires": int64(4_102_444_800_000)}},
		},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "auth.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestTypeScriptAndGoConcurrentManagementConvergence(t *testing.T) {
	upstream := newDifferentialUpstream(t)
	config := differentialConfig(upstream.server.URL, []string{"success"})
	tsProxy := startTypeScriptProxy(t, config)
	goProxy := startProxyWithConfig(t, config)
	payload := map[string]any{
		"webSearch": map[string]any{"model": "search-model", "backend": "anthropic", "reasoning": "high"},
		"vision":    map[string]any{"model": "vision-model", "backend": "openai", "maxDescriptionsPerTurn": 3},
	}
	type result struct {
		runtime  string
		response runtimeResponse
	}
	results := make(chan result, 24)
	var group sync.WaitGroup
	for range 12 {
		for runtime, baseURL := range map[string]string{"Go": goProxy.baseURL, "TypeScript": tsProxy.baseURL} {
			group.Add(1)
			go func() {
				defer group.Done()
				results <- result{runtime, captureManagementRequest(t, baseURL, http.MethodPut, "/api/sidecar-settings", "", payload)}
			}()
		}
	}
	group.Wait()
	close(results)
	for captured := range results {
		if captured.response.err != nil || captured.response.status != http.StatusOK {
			t.Fatalf("%s concurrent management mutation status=%d err=%v body=%s", captured.runtime, captured.response.status, captured.response.err, captured.response.body)
		}
	}
	compareRuntimeBytes(t, "management-concurrency/final-state",
		captureManagementRequest(t, goProxy.baseURL, http.MethodGet, "/api/sidecar-settings", "", nil),
		captureManagementRequest(t, tsProxy.baseURL, http.MethodGet, "/api/sidecar-settings", "", nil), true)
}

func TestTypeScriptAndGoOpenAITierConfigMigration(t *testing.T) {
	bun := requireBun(t, exec.LookPath)
	repositoryRoot := filepath.Dir(goModuleRoot())
	original := []byte(`{
  "port": 10100,
  "hostname": "127.0.0.1",
  "openaiProviderTierVersion": 1,
  "defaultProvider": "openai-multi",
  "providers": {
    "openai": {"adapter":"openai-responses","baseUrl":"https://chatgpt.com/backend-api/codex","authMode":"forward","selectedModels":["gpt-5.6-sol"]},
    "openai-multi": {"adapter":"openai-responses","baseUrl":"https://chatgpt.com/backend-api/codex","authMode":"forward","selectedModels":["gpt-5.6-terra","gpt-5.6-luna"]},
    "custom": {"adapter":"openai-chat","baseUrl":"https://custom.example.test/v1","apiKey":"synthetic","authMode":"key","models":["custom-model"]}
  },
  "disabledModels": ["openai-multi/gpt-disabled", "custom/custom-model"],
  "subagentModels": ["openai-multi/gpt-agent"],
  "injectionModel": "openai-multi/gpt-injection",
  "providerContextCaps": {"openai":300000,"openai-multi":200000,"custom":100000}
}
`)
	tsHome, goHome := t.TempDir(), t.TempDir()
	for _, home := range []string{tsHome, goHome} {
		if err := os.MkdirAll(filepath.Join(home, "codex"), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(home, "config.json"), original, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	configModule := filepath.Join(repositoryRoot, "src", "config.ts")
	startupModule := filepath.Join(repositoryRoot, "src", "providers", "openai-tier-startup.ts")
	script := fmt.Sprintf(`
process.env.OPENCODEX_HOME = %q;
process.env.CODEX_HOME = %q;
const config = await import(%q);
const startup = await import(%q);
startup.runOpenAiTierStartupMigration(config.loadConfig());
const first = await Bun.file(%q).text();
startup.runOpenAiTierStartupMigration(config.loadConfig());
const second = await Bun.file(%q).text();
process.stdout.write(JSON.stringify({ idempotent: first === second }));
`, tsHome, filepath.Join(tsHome, "codex"), configModule, startupModule, filepath.Join(tsHome, "config.json"), filepath.Join(tsHome, "config.json"))
	output, err := exec.Command(bun, "-e", script).CombinedOutput()
	if err != nil {
		t.Fatalf("TypeScript migration failed: %v: %s", err, output)
	}
	if !bytes.Contains(output, []byte(`"idempotent":true`)) {
		t.Fatalf("TypeScript migration was not idempotent: %s", output)
	}
	goPath := filepath.Join(goHome, "config.json")
	if _, err := configpkg.LoadMigrated(goPath); err != nil {
		t.Fatalf("Go migration failed: %v", err)
	}
	goFirst := mustReadParityFile(t, goPath)
	if _, err := configpkg.LoadMigrated(goPath); err != nil {
		t.Fatalf("Go remigration failed: %v", err)
	}
	assertParityFileBytes(t, "Go migration idempotence", goPath, goFirst)
	for runtime, home := range map[string]string{"Go": goHome, "TypeScript": tsHome} {
		backup := mustReadParityFile(t, filepath.Join(home, "config.json.pre-openai-tiers-v2.bak"))
		if !bytes.Equal(backup, original) {
			t.Fatalf("%s migration backup changed original bytes", runtime)
		}
	}
	compareMigrationProjection(t, mustReadParityFile(t, goPath), mustReadParityFile(t, filepath.Join(tsHome, "config.json")))
}

func newTaggedProviderUpstream(t *testing.T, tag string) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		defer request.Body.Close()
		var body map[string]any
		_ = json.NewDecoder(request.Body).Decode(&body)
		model, _ := body["model"].(string)
		if stream, _ := body["stream"].(bool); stream {
			writer.Header().Set("Content-Type", "text/event-stream")
			_, _ = fmt.Fprintf(writer, "data: {\"id\":\"chatcmpl-tagged\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":%q},\"finish_reason\":null}]}\n\n", tag+" response")
			_, _ = fmt.Fprint(writer, "data: {\"id\":\"chatcmpl-tagged\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":1,\"total_tokens\":3}}\n\ndata: [DONE]\n\n")
			return
		}
		writeChatSuccess(writer, model, tag+" response")
	}))
	t.Cleanup(server.Close)
	return server
}

func compareTaggedChatResponse(t *testing.T, provider string, goBytes, tsBytes []byte) {
	t.Helper()
	for runtime, payload := range map[string][]byte{"Go": goBytes, "TypeScript": tsBytes} {
		if !bytes.Contains(payload, []byte(provider+" response")) || !bytes.Contains(payload, []byte(`"model":"`+provider+`/shared"`)) {
			t.Fatalf("%s %s route crossed providers: %s", runtime, provider, payload)
		}
	}
}

func compareMigrationProjection(t *testing.T, goBytes, tsBytes []byte) {
	t.Helper()
	project := func(data []byte) []byte {
		var config map[string]any
		if err := json.Unmarshal(data, &config); err != nil {
			t.Fatalf("decode migrated config: %v", err)
		}
		providers, _ := config["providers"].(map[string]any)
		providerIDs := make([]string, 0, len(providers))
		for id := range providers {
			providerIDs = append(providerIDs, id)
		}
		sort.Strings(providerIDs)
		openai, _ := providers["openai"].(map[string]any)
		projection := map[string]any{
			"version": config["openaiProviderTierVersion"], "defaultProvider": config["defaultProvider"],
			"providerIds": providerIDs, "codexAccountMode": openai["codexAccountMode"], "selectedModels": openai["selectedModels"],
			"disabledModels": config["disabledModels"], "subagentModels": config["subagentModels"],
			"injectionModel": config["injectionModel"], "providerContextCaps": config["providerContextCaps"],
		}
		encoded, _ := json.Marshal(projection)
		return encoded
	}
	goProjection, tsProjection := project(goBytes), project(tsBytes)
	if !bytes.Equal(goProjection, tsProjection) {
		t.Fatalf("migration projection differs: Go=%s TypeScript=%s", goProjection, tsProjection)
	}
}
