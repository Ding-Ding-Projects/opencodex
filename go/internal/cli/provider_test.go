package cli

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/config"
)

func TestProviderCRUDUsesTemporaryConfigHome(t *testing.T) {
	home := t.TempDir()
	t.Setenv("OPENCODEX_HOME", home)
	cfg := config.Default()
	cfg.DefaultProvider = "base"
	cfg.Providers["base"] = config.ProviderConfig{Adapter: "openai-chat", BaseURL: "https://base.example.test/v1", APIKey: "base-secret-value"}
	if err := config.Save(filepath.Join(home, "config.json"), &cfg); err != nil {
		t.Fatal(err)
	}

	var output, errors bytes.Buffer
	streams := IO{In: strings.NewReader(""), Out: &output, Err: &errors}
	if err := runProvider([]string{"add", "custom", "--adapter", "openai-chat", "--base-url", "http://127.0.0.1:11434/v1", "--api-key", "custom-secret-value", "--allow-private-network", "--json"}, streams); err != nil {
		t.Fatal(err)
	}
	loaded, err := config.Load(filepath.Join(home, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	custom, ok := loaded.Providers["custom"]
	if !ok || custom.APIKey != "custom-secret-value" || !custom.AllowPrivateNetwork {
		t.Fatalf("custom provider = %#v", custom)
	}

	output.Reset()
	if err := runProvider([]string{"show", "custom", "--json"}, streams); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(output.String(), "custom-secret-value") || !strings.Contains(output.String(), "cust****alue") {
		t.Fatalf("show output did not mask secret: %s", output.String())
	}

	output.Reset()
	if err := runProvider([]string{"list", "--json"}, streams); err != nil {
		t.Fatal(err)
	}
	var listed struct {
		Configured []providerSummary `json:"configured"`
	}
	if err := json.Unmarshal(output.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Configured) != 2 || listed.Configured[0].Name != "base" || listed.Configured[1].Name != "custom" {
		t.Fatalf("provider list = %#v", listed.Configured)
	}

	if err := runProvider([]string{"set-default", "custom"}, streams); err != nil {
		t.Fatal(err)
	}
	if err := runProvider([]string{"remove", "base", "--json"}, streams); err != nil {
		t.Fatal(err)
	}
	loaded, err = config.Load(filepath.Join(home, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	if loaded.DefaultProvider != "custom" || len(loaded.Providers) != 1 {
		t.Fatalf("final config = %#v", loaded)
	}
}

func TestProviderCRUDRejectsUnsafeTransitions(t *testing.T) {
	home := t.TempDir()
	t.Setenv("OPENCODEX_HOME", home)
	cfg := config.Default()
	cfg.DefaultProvider = "only"
	cfg.Providers["only"] = config.ProviderConfig{Adapter: "openai-chat", BaseURL: "https://example.test/v1"}
	if err := config.Save(filepath.Join(home, "config.json"), &cfg); err != nil {
		t.Fatal(err)
	}
	streams := IO{In: strings.NewReader(""), Out: &bytes.Buffer{}, Err: &bytes.Buffer{}}
	if err := runProvider([]string{"remove", "only"}, streams); err == nil || !strings.Contains(err.Error(), "default provider") {
		t.Fatalf("default removal error = %v", err)
	}
	if err := runProvider([]string{"add", "bad/name", "--adapter", "openai-chat", "--base-url", "https://example.test"}, streams); err == nil {
		t.Fatal("invalid provider name was accepted")
	}
	if err := runProvider([]string{"add", "custom"}, streams); err == nil || !strings.Contains(err.Error(), "--adapter") {
		t.Fatalf("incomplete custom provider error = %v", err)
	}
}

func TestProviderAddRegistryEntryPreservesCapabilities(t *testing.T) {
	home := t.TempDir()
	t.Setenv("OPENCODEX_HOME", home)
	var output bytes.Buffer
	if err := runProvider([]string{"add", "kimi"}, IO{Out: &output, Err: &output}); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.Load(filepath.Join(home, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	kimi := cfg.Providers["kimi"]
	if kimi.AuthMode != "oauth" || kimi.DefaultModel == "" || len(kimi.Models) == 0 || len(kimi.NoTemperatureModels) == 0 || kimi.ModelSuffixBracketStrip == nil || !*kimi.ModelSuffixBracketStrip {
		t.Fatalf("Kimi capabilities were not seeded: %#v", kimi)
	}
}

func TestProviderTestUsesRunningProxyManagementEndpoint(t *testing.T) {
	home := t.TempDir()
	t.Setenv("OPENCODEX_HOME", home)
	t.Setenv("OPENCODEX_API_AUTH_TOKEN", "management-token")
	cfg := config.Default()
	cfg.Host = "127.0.0.1"
	cfg.DefaultProvider = "test"
	cfg.Providers["test"] = config.ProviderConfig{Adapter: "openai-chat", BaseURL: "https://example.test/v1"}
	if err := config.Save(filepath.Join(home, "config.json"), &cfg); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.URL.Path != "/api/providers/test" || request.URL.Query().Get("name") != "test" {
			t.Errorf("request = %s %s", request.Method, request.URL.String())
		}
		if request.Header.Get("X-OpenCodex-API-Key") != "management-token" {
			t.Errorf("management token header missing")
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"ok":true,"models":3}`))
	}))
	defer server.Close()
	parsed, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(parsed.Port())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "ocx.pid"), []byte(strconv.Itoa(os.Getpid())), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "runtime-port"), []byte(strconv.Itoa(port)), 0o600); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err := runProvider([]string{"test", "test", "--json"}, IO{Out: &output, Err: &output}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), `"ok": true`) || !strings.Contains(output.String(), `"models": 3`) {
		t.Fatalf("provider test output = %s", output.String())
	}
}
