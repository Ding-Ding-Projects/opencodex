package config

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestMigrateClaudeAuthModePinsLegacyAndIsIdempotent(t *testing.T) {
	now := time.Date(2026, 7, 26, 1, 2, 3, 0, time.UTC)
	enabled := true
	cfg := Config{ClaudeCode: &ClaudeCodeConfig{Enabled: &enabled}}
	migrated, changed := MigrateClaudeAuthMode(cfg, now)
	if !changed || migrated.ClaudeCode.AuthMode != "subscription" || migrated.ClaudeCode.AuthModeMigratedAt != now.Format(time.RFC3339Nano) {
		t.Fatalf("migrated=%#v changed=%v", migrated.ClaudeCode, changed)
	}
	if cfg.ClaudeCode.AuthMode != "" || cfg.ClaudeCode.AuthModeMigratedAt != "" {
		t.Fatal("migration mutated input")
	}
	again, changed := MigrateClaudeAuthMode(migrated, now.Add(time.Hour))
	if changed || again.ClaudeCode.AuthModeMigratedAt != migrated.ClaudeCode.AuthModeMigratedAt {
		t.Fatalf("idempotence failed: %#v changed=%v", again.ClaudeCode, changed)
	}
}

func TestMigrateClaudeAuthModePreservesManualAndLaterAuto(t *testing.T) {
	now := time.Now()
	manual, changed := MigrateClaudeAuthMode(Config{ClaudeCode: &ClaudeCodeConfig{AuthMode: "proxy"}}, now)
	if !changed || manual.ClaudeCode.AuthMode != "proxy" || manual.ClaudeCode.AuthModeMigratedAt == "" {
		t.Fatalf("manual=%#v changed=%v", manual.ClaudeCode, changed)
	}
	manual.ClaudeCode.AuthMode = ""
	auto, changed := MigrateClaudeAuthMode(manual, now.Add(time.Hour))
	if changed || auto.ClaudeCode.AuthMode != "" {
		t.Fatalf("later auto resurrected: %#v changed=%v", auto.ClaudeCode, changed)
	}
	withoutBlock, changed := MigrateClaudeAuthMode(Config{}, now)
	if changed || withoutBlock.ClaudeCode != nil {
		t.Fatalf("empty config changed: %#v", withoutBlock.ClaudeCode)
	}
}

func TestLoadMigratedPersistsClaudeSentinelAndRoundTrips(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	data := []byte(`{"port":10100,"providers":{},"defaultProvider":"openai","openaiProviderTierVersion":2,"claudeCode":{"enabled":true}}`)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadMigrated(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ClaudeCode == nil || cfg.ClaudeCode.AuthMode != "subscription" || cfg.ClaudeCode.AuthModeMigratedAt == "" {
		t.Fatalf("loaded=%#v", cfg.ClaudeCode)
	}
	var raw map[string]any
	persisted, err := os.ReadFile(path)
	if err != nil || json.Unmarshal(persisted, &raw) != nil {
		t.Fatalf("persisted config invalid: %v", err)
	}
	claudeCode := raw["claudeCode"].(map[string]any)
	if claudeCode["authMode"] != "subscription" || claudeCode["authModeMigratedAt"] == "" {
		t.Fatalf("persisted claudeCode=%#v", claudeCode)
	}
	stamp := cfg.ClaudeCode.AuthModeMigratedAt
	again, err := LoadMigrated(path)
	if err != nil || again.ClaudeCode.AuthModeMigratedAt != stamp {
		t.Fatalf("second load=%#v err=%v", again.ClaudeCode, err)
	}
	if _, err := os.Stat(path + openAITierBackupSuffix); !os.IsNotExist(err) {
		t.Fatalf("Claude-only migration created an OpenAI rollback backup: %v", err)
	}
}

func TestLoadMigratedCombinesOpenAIAndClaudeInOneStableTransaction(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	original := []byte(`{"port":10100,"hostname":"127.0.0.1","providers":{"openai-multi":{"adapter":"openai-responses","baseUrl":"https://chatgpt.com/backend-api/codex","authMode":"forward","selectedModels":["openai-multi/gpt-5.5"]}},"defaultProvider":"openai-multi","subagentModels":["openai-multi/gpt-5.5"],"claudeCode":{"enabled":true}}`)
	if err := os.WriteFile(path, original, 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadMigrated(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DefaultProvider != "openai" || cfg.OpenAIProviderTierVersion != 2 || cfg.Providers["openai"].CodexAccountMode != "pool" || cfg.SubagentModels[0] != "gpt-5.5" {
		t.Fatalf("OpenAI migration result = %#v", cfg)
	}
	if cfg.ClaudeCode == nil || cfg.ClaudeCode.AuthMode != "subscription" || cfg.ClaudeCode.AuthModeMigratedAt == "" {
		t.Fatalf("Claude migration result = %#v", cfg.ClaudeCode)
	}
	backup, err := os.ReadFile(path + openAITierBackupSuffix)
	if err != nil || !bytes.Equal(backup, original) {
		t.Fatalf("combined migration backup = %q, %v", backup, err)
	}
	first, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := LoadMigrated(path); err != nil {
		t.Fatal(err)
	}
	second, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(first, second) {
		t.Fatalf("second combined migration rewrote config: err=%v", err)
	}
}
