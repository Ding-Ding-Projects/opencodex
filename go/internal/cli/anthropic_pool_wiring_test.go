package cli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/oauth"
)

// The pool has to reach server.Config, not just exist. Twice already in this
// port a correct implementation shipped with nothing calling it, so the wiring
// itself is what this pins.
func TestServeWiresTheAnthropicPoolIntoTheProxy(t *testing.T) {
	home := t.TempDir()
	store := oauth.NewCredentialStore(filepath.Join(home, "auth.json"))
	cfg := config.FreshInstall()

	resolver, err := configuredAuthWithStore(cfg, store)
	if err != nil {
		t.Fatal(err)
	}
	if resolver.Anthropic == nil {
		t.Fatal("configuredAuthWithStore built no Anthropic pool; the failover hook would be inert")
	}

	path := filepath.Join(home, "config.json")
	if err := config.Save(path, &cfg); err != nil {
		t.Fatal(err)
	}
	persistence := config.NewLivePersistence(path, &cfg)
	live := &configBackedAuth{config: &cfg, persistence: persistence, store: store, resolver: resolver}

	if pool := live.anthropicPoolConfig(); pool.Enabled {
		t.Fatal("a fresh install reports the pool as enabled")
	}
	// The accessor must read LIVE config, not a value captured at startup.
	enabled := true
	if err := persistence.Update(func(cfg *config.Config) {
		cfg.AnthropicAccountPool = &config.AnthropicAccountPoolConfig{Enabled: &enabled}
	}); err != nil {
		t.Fatal(err)
	}
	if pool := live.anthropicPoolConfig(); !pool.Enabled {
		t.Fatal("the pool accessor did not see a live config change; enabling would need a restart")
	}
}

// The proxy construction happens inside a long unexported function that binds a
// listener, so the field assignment is asserted on the source instead. Blunt,
// but it fails loudly if someone drops the wiring, which is the exact defect
// that reached review twice in this port.
func TestServeConfigCarriesTheAnthropicPoolFields(t *testing.T) {
	source, err := os.ReadFile("serve.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"AnthropicPool: auth.Anthropic", "AnthropicPoolConfig: liveAuth.anthropicPoolConfig"} {
		if !strings.Contains(string(source), field) {
			t.Fatalf("serve.go no longer passes %q to server.Config; 429 failover would be inert in production", field)
		}
	}
}
