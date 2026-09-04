package cli

import (
	"bytes"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/config"
)

func TestInitBuiltInLocalProvider(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENCODEX_HOME", dir)
	input := strings.NewReader("ollama\n\nllama3.3\n11434\n")
	var output bytes.Buffer
	if err := runInit(nil, IO{In: input, Out: &output, Err: &output}); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.Load(filepath.Join(dir, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	provider := cfg.Providers["ollama"]
	if cfg.Port != 11434 || cfg.DefaultProvider != "ollama" || provider.DefaultModel != "llama3.3" || provider.APIKey != "" {
		t.Fatalf("config = %#v", cfg)
	}
}

func TestInitCustomProviderAndProviderEnvKey(t *testing.T) {
	if got := providerEnvKey("anthropic-apikey"); got != "ANTHROPIC_APIKEY_API_KEY" {
		t.Fatalf("providerEnvKey() = %q", got)
	}
	dir := t.TempDir()
	t.Setenv("OPENCODEX_HOME", dir)
	input := strings.NewReader("custom\nmy-provider\nhttps://example.com/v1\n\nsecret\nmodel-x\n\n")
	var output bytes.Buffer
	if err := runInit(nil, IO{In: input, Out: &output, Err: &output}); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.Load(filepath.Join(dir, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	provider := cfg.Providers["my-provider"]
	if provider.Adapter != "openai-chat" || provider.APIKey != "secret" || provider.DefaultModel != "model-x" {
		t.Fatalf("provider = %#v", provider)
	}
}
