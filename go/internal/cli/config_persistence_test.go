package cli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/codex"
	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/oauth"
)

func TestRuntimeCodexAccountSaveUsesSharedPersistence(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, "config.json")
	cfg := config.Default()
	cfg.ClaudeCode = &config.ClaudeCodeConfig{AuthMode: "subscription", AuthModeMigratedAt: "2026-07-26T00:00:00Z"}
	if err := config.Save(path, &cfg); err != nil {
		t.Fatal(err)
	}
	persistence := config.NewLivePersistence(path, &cfg)
	manager := newCodexAuthManagement(&cfg, path, oauth.NewCredentialStore(filepath.Join(home, "auth.json")), codex.NewQuotaStore(), nil, persistence)

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var object map[string]any
	if err := json.Unmarshal(data, &object); err != nil {
		t.Fatal(err)
	}
	object["claudeCode"] = map[string]any{"authMode": "proxy", "authModeMigratedAt": "2026-07-26T00:00:00Z"}
	data, _ = json.MarshalIndent(object, "", "  ")
	if err := os.WriteFile(path, append(data, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := manager.upsertConfigAccount(config.CodexAccount{ID: "runtime-account", Email: "runtime@example.test"}); err != nil {
		t.Fatal(err)
	}
	loaded, err := config.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.ClaudeCode == nil || loaded.ClaudeCode.AuthMode != "proxy" {
		t.Fatalf("claudeCode = %#v", loaded.ClaudeCode)
	}
	if len(loaded.CodexAccounts) != 1 || loaded.CodexAccounts[0].ID != "runtime-account" {
		t.Fatalf("codexAccounts = %#v", loaded.CodexAccounts)
	}
}
