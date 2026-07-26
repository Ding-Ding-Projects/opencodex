package cli

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/providers"
)

func TestNewLoginFlowCoversPublicOAuthProviders(t *testing.T) {
	tests := map[string]string{
		"xai":                "cli.browserLoginFlow",
		"anthropic":          "cli.anthropicLoginFlow",
		"google-antigravity": "cli.browserLoginFlow",
		"cursor":             "*oauth.CursorFlow",
		"kimi":               "*oauth.KimiFlow",
		"github-copilot":     "*oauth.GithubCopilotFlow",
		"kiro":               "cli.kiroImportFlow",
	}
	for provider, wantType := range tests {
		t.Run(provider, func(t *testing.T) {
			flow, err := newLoginFlow(provider, nil, "")
			if err != nil {
				t.Fatal(err)
			}
			if got := reflect.TypeOf(flow).String(); got != wantType {
				t.Fatalf("flow type = %q, want %q", got, wantType)
			}
		})
	}
}

func TestNewLoginFlowRejectsUnknownProvider(t *testing.T) {
	if _, err := newLoginFlow("not-a-provider", nil, ""); err == nil {
		t.Fatal("unknown provider was accepted")
	}
}

func TestNormalizeLoginProviderPreservesOpenAICompatibility(t *testing.T) {
	for _, input := range []string{"openai", "chatgpt", " ChatGPT "} {
		flow, store := normalizeLoginProvider(input)
		if flow != "chatgpt" || store != "openai" {
			t.Fatalf("normalizeLoginProvider(%q) = %q, %q", input, flow, store)
		}
	}
	flow, store := normalizeLoginProvider(" KIMI ")
	if flow != "kimi" || store != "kimi" {
		t.Fatalf("Kimi normalization = %q, %q", flow, store)
	}
}

func TestUpsertOAuthProviderConfigUsesTempHome(t *testing.T) {
	home := t.TempDir()
	t.Setenv("OPENCODEX_HOME", home)
	if err := upsertOAuthProviderConfig("kimi"); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.Load(filepath.Join(home, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	provider, ok := cfg.Providers["kimi"]
	if !ok {
		t.Fatal("Kimi provider was not persisted")
	}
	if provider.AuthMode != "oauth" || provider.Adapter != "openai-chat" || provider.DefaultModel == "" {
		t.Fatalf("persisted provider = %#v", provider)
	}
	if info, err := os.Stat(filepath.Join(home, "config.json")); err != nil || info.Size() == 0 {
		t.Fatalf("config file stat = %v, %v", info, err)
	}
}

func TestConfigProviderFromSeedClonesMutableMaps(t *testing.T) {
	seed, ok := providers.DeriveOAuthProviderConfig("kimi")
	if !ok {
		t.Fatal("Kimi OAuth seed missing")
	}
	converted := configProviderFromSeed(seed)
	if len(seed.Models) == 0 {
		t.Fatal("test requires a model seed")
	}
	original := seed.Models[0]
	converted.Models[0] = "changed"
	if seed.Models[0] != original {
		t.Fatal("config conversion aliased the registry model slice")
	}
}

func TestManualCodeInputReadsBoundedRedirect(t *testing.T) {
	var output bytes.Buffer
	manual := manualCodeInput(IO{In: bytes.NewBufferString("https://localhost/callback?code=abc&state=expected\n"), Out: &output})
	if manual == nil {
		t.Fatal("manual input was not enabled for an injected reader")
	}
	value, err := manual(context.Background(), "expected")
	if err != nil {
		t.Fatal(err)
	}
	if value != "https://localhost/callback?code=abc&state=expected" {
		t.Fatalf("manual value = %q", value)
	}
}
