package config

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func livePersistenceFixture(t *testing.T) (string, *Config, *LivePersistence) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.json")
	cfg := FreshInstall()
	cfg.ClaudeCode = &ClaudeCodeConfig{AuthMode: "subscription", AuthModeMigratedAt: "2026-07-26T00:00:00Z"}
	if err := Save(path, &cfg); err != nil {
		t.Fatal(err)
	}
	live, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	return path, live, NewLivePersistence(path, live)
}

func rewriteClaudeCode(t *testing.T, path string, value any) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var object map[string]any
	if err := json.Unmarshal(data, &object); err != nil {
		t.Fatal(err)
	}
	object["claudeCode"] = value
	data, err = json.MarshalIndent(object, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, append(data, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
}

func loadedClaudeMode(t *testing.T, path string) string {
	t.Helper()
	loaded, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.ClaudeCode == nil {
		return ""
	}
	return loaded.ClaudeCode.AuthMode
}

func TestLivePersistencePreservesExternalClaudeCodeEditBeforeFirstSave(t *testing.T) {
	path, live, persistence := livePersistenceFixture(t)
	rewriteClaudeCode(t, path, map[string]any{"authMode": "proxy", "authModeMigratedAt": "2026-07-26T00:00:00Z"})
	live.Port++
	if err := persistence.Save(); err != nil {
		t.Fatal(err)
	}
	if got := loadedClaudeMode(t, path); got != "proxy" {
		t.Fatalf("authMode = %q, want proxy", got)
	}
	if live.ClaudeCode == nil || live.ClaudeCode.AuthMode != "proxy" {
		t.Fatalf("live claudeCode = %#v", live.ClaudeCode)
	}
	if live.ClaudeCode.AuthModeMigratedAt != "2026-07-26T00:00:00Z" {
		t.Fatalf("migration sentinel = %q", live.ClaudeCode.AuthModeMigratedAt)
	}
}

func TestLivePersistenceRuntimeConflictWinsThenBaselineRebases(t *testing.T) {
	path, live, persistence := livePersistenceFixture(t)
	rewriteClaudeCode(t, path, map[string]any{"authMode": "proxy", "authModeMigratedAt": "2026-07-26T00:00:00Z"})
	live.ClaudeCode = &ClaudeCodeConfig{AuthMode: "subscription", AuthModeMigratedAt: "2026-07-26T00:00:00Z", SystemEnv: true}
	if err := persistence.Save(); err != nil {
		t.Fatal(err)
	}
	if got := loadedClaudeMode(t, path); got != "subscription" {
		t.Fatalf("conflict authMode = %q", got)
	}
	rewriteClaudeCode(t, path, map[string]any{"systemEnv": true, "authMode": "proxy", "authModeMigratedAt": "2026-07-26T00:00:00Z"})
	live.Port++
	if err := persistence.Save(); err != nil {
		t.Fatal(err)
	}
	if got := loadedClaudeMode(t, path); got != "proxy" {
		t.Fatalf("rebased authMode = %q", got)
	}
}

func TestLivePersistenceIgnoresKeyOrderAndFallsBackForMalformedFile(t *testing.T) {
	path, live, persistence := livePersistenceFixture(t)
	rewriteClaudeCode(t, path, map[string]any{"authModeMigratedAt": "2026-07-26T00:00:00Z", "authMode": "subscription"})
	live.Port++
	if err := persistence.Save(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("{not-json"), 0o600); err != nil {
		t.Fatal(err)
	}
	live.Port++
	if err := persistence.Save(); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); err != nil {
		t.Fatalf("fallback save did not repair malformed file: %v", err)
	}
}

func TestLivePersistenceSerializesConcurrentUpdates(t *testing.T) {
	path, live, persistence := livePersistenceFixture(t)
	var wait sync.WaitGroup
	for index := 0; index < 32; index++ {
		index := index
		wait.Add(1)
		go func() {
			defer wait.Done()
			if err := persistence.Update(func(cfg *Config) { cfg.Port = 11000 + index }); err != nil {
				t.Errorf("Update() error = %v", err)
			}
		}()
	}
	wait.Wait()
	if _, err := Load(path); err != nil {
		t.Fatal(err)
	}
	if live.Port < 11000 || live.Port >= 11032 {
		t.Fatalf("live port = %d", live.Port)
	}
}

func TestLivePersistenceUpdateRollsBackCompleteConfigWhenSaveFails(t *testing.T) {
	blocker := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(blocker, []byte("block"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := FreshInstall()
	cfg.Port = 10100
	cfg.Providers["acme"] = ProviderConfig{Adapter: "openai", APIKey: "key-one"}
	persistence := NewLivePersistence(filepath.Join(blocker, "config.json"), &cfg)

	err := persistence.Update(func(live *Config) {
		live.Port = 20200
		provider := live.Providers["acme"]
		provider.APIKey = "key-two"
		live.Providers["acme"] = provider
	})
	if err == nil {
		t.Fatal("Update() error = nil, want durable write failure")
	}
	if cfg.Port != 10100 || cfg.Providers["acme"].APIKey != "key-one" {
		t.Fatalf("failed update leaked live mutation: port=%d provider=%#v", cfg.Port, cfg.Providers["acme"])
	}
}

func TestLivePersistenceSaveRollsBackPreservedClaudeEditOnFailure(t *testing.T) {
	path, live, persistence := livePersistenceFixture(t)
	rewriteClaudeCode(t, path, map[string]any{"authMode": "proxy", "authModeMigratedAt": "2026-07-26T00:00:00Z"})
	persistence.save = func(string, *Config) error { return errors.New("injected save failure") }

	if err := persistence.Save(); err == nil {
		t.Fatal("Save() error = nil, want injected failure")
	}
	if live.ClaudeCode == nil || live.ClaudeCode.AuthMode != "subscription" {
		t.Fatalf("failed save leaked preserved edit into live config: %#v", live.ClaudeCode)
	}
	if got := loadedClaudeMode(t, path); got != "proxy" {
		t.Fatalf("disk authMode = %q, want untouched proxy edit", got)
	}
}
