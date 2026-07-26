package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/config"
)

func TestEnsureHonorsDisabledAutostart(t *testing.T) {
	home := t.TempDir()
	t.Setenv("OPENCODEX_HOME", home)
	disabled := false
	cfg := config.Default()
	cfg.CodexAutoStart = &disabled
	if err := config.Save(filepath.Join(home, "config.json"), &cfg); err != nil {
		t.Fatal(err)
	}
	loaded, err := config.Load(filepath.Join(home, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	if loaded.CodexAutoStart == nil || *loaded.CodexAutoStart {
		t.Fatalf("codexAutoStart did not round trip: %#v", loaded.CodexAutoStart)
	}
	var output bytes.Buffer
	if err := runEnsure(context.Background(), nil, IO{Out: &output}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), "disabled") {
		t.Fatalf("output = %q", output.String())
	}
}

func TestCodexShimStatusUsesScopedStatePath(t *testing.T) {
	home := t.TempDir()
	t.Setenv("OPENCODEX_HOME", home)
	var output bytes.Buffer
	if err := runCodexShim([]string{"status"}, IO{Out: &output}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), "not installed") {
		t.Fatalf("output = %q", output.String())
	}
}

func TestSyncCacheWritesExpiredCacheFromCatalog(t *testing.T) {
	codexHome := t.TempDir()
	t.Setenv("CODEX_HOME", codexHome)
	catalog := map[string]any{"models": []map[string]any{{"slug": "native-model"}}}
	data, _ := json.Marshal(catalog)
	if err := os.WriteFile(filepath.Join(codexHome, "opencodex-catalog.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err := runSyncCache(nil, IO{Out: &output}); err != nil {
		t.Fatal(err)
	}
	cache, err := os.ReadFile(filepath.Join(codexHome, "models_cache.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(cache, []byte(`"fetched_at": "2000-01-01T00:00:00Z"`)) || !bytes.Contains(cache, []byte("native-model")) {
		t.Fatalf("cache = %s", cache)
	}
}

func TestV2StatusReportsConfigWithoutMutation(t *testing.T) {
	ocxHome, codexHome := t.TempDir(), t.TempDir()
	t.Setenv("OPENCODEX_HOME", ocxHome)
	t.Setenv("CODEX_HOME", codexHome)
	cfg := config.Default()
	cfg.MultiAgentMode = "v2"
	if err := config.Save(filepath.Join(ocxHome, "config.json"), &cfg); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(codexHome, "config.toml")
	content := []byte("[features.multi_agent_v2]\nenabled = true\nmax_concurrent_threads_per_session = 7\n")
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err := runV2([]string{"status"}, IO{Out: &output}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), "ON") || !strings.Contains(output.String(), "max_threads: 7") {
		t.Fatalf("output = %q", output.String())
	}
	after, _ := os.ReadFile(path)
	if !bytes.Equal(after, content) {
		t.Fatal("status mutated Codex config")
	}
}

func TestRecoverHistoryMissingDatabaseIsNoop(t *testing.T) {
	t.Setenv("OPENCODEX_HOME", t.TempDir())
	t.Setenv("CODEX_HOME", t.TempDir())
	var output bytes.Buffer
	if err := runRecoverHistory([]string{"--legacy-openai"}, IO{Out: &output}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), "Recovered 0") {
		t.Fatalf("output = %q", output.String())
	}
}
