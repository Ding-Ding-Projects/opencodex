package config

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/lidge-jun/opencodex-go/internal/providers"
)

const openAITierBackupSuffix = ".pre-openai-tiers-v2.bak"

// MigrateOpenAITiers projects legacy openai-multi/chatgpt configuration into
// the canonical openai provider while preserving unrelated provider settings.
func MigrateOpenAITiers(cfg Config) (Config, bool, error) {
	projectedProviders := make(map[string]providers.OpenAITierProvider, len(cfg.Providers))
	for name, provider := range cfg.Providers {
		projectedProviders[name] = providers.OpenAITierProvider{
			ProviderConfig: providers.ProviderConfig{
				Adapter: provider.Adapter, BaseURL: provider.BaseURL, AuthMode: provider.AuthMode,
				CodexAccountMode: provider.CodexAccountMode,
			},
			Disabled: provider.Disabled, SelectedModels: append([]string(nil), provider.SelectedModels...),
		}
	}
	projection, err := providers.ProjectOpenAITierMigration(providers.OpenAITierConfig{
		Providers: projectedProviders, DefaultProvider: cfg.DefaultProvider,
		OpenAIProviderTierVersion: cfg.OpenAIProviderTierVersion,
		DisabledModels:            append([]string(nil), cfg.DisabledModels...),
		SubagentModels:            append([]string(nil), cfg.SubagentModels...), InjectionModel: cfg.InjectionModel,
		ProviderContextCaps: cloneIntValues(cfg.ProviderContextCaps),
	})
	if err != nil || !projection.Changed {
		return cfg, false, err
	}
	out := cfg
	out.Providers = cloneProviderValues(cfg.Providers)
	delete(out.Providers, providers.LegacyOpenAIMultiProviderID)
	delete(out.Providers, providers.LegacyChatGPTProviderID)
	if migrated, exists := projection.Config.Providers[providers.OpenAICodexProviderID]; exists {
		provider := out.Providers[providers.OpenAICodexProviderID]
		provider.Adapter = migrated.Adapter
		provider.BaseURL = migrated.BaseURL
		provider.AuthMode = migrated.AuthMode
		provider.CodexAccountMode = migrated.CodexAccountMode
		provider.Disabled = migrated.Disabled
		provider.SelectedModels = append([]string(nil), migrated.SelectedModels...)
		out.Providers[providers.OpenAICodexProviderID] = provider
	}
	out.DefaultProvider = projection.Config.DefaultProvider
	out.OpenAIProviderTierVersion = projection.Config.OpenAIProviderTierVersion
	out.DisabledModels = projection.Config.DisabledModels
	out.SubagentModels = projection.Config.SubagentModels
	out.InjectionModel = projection.Config.InjectionModel
	out.ProviderContextCaps = projection.Config.ProviderContextCaps
	return out, true, nil
}

// LoadMigrated performs the startup migration transaction: load, project,
// create/reuse a protected pre-migration snapshot, then atomically save.
func LoadMigrated(path string) (*Config, error) {
	cfg, err := Load(path)
	if err != nil {
		return nil, err
	}
	migrated, changed, err := MigrateOpenAITiers(*cfg)
	if err != nil || !changed {
		return cfg, err
	}
	if err := backupBeforeOpenAITierMigration(path); err != nil {
		return nil, err
	}
	if err := Save(path, &migrated); err != nil {
		return nil, fmt.Errorf("save OpenAI tier migration: %w", err)
	}
	return &migrated, nil
}

func backupBeforeOpenAITierMigration(path string) error {
	original, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	backup := path + openAITierBackupSuffix
	if existing, readErr := os.ReadFile(backup); readErr == nil {
		if bytes.Equal(existing, original) {
			return nil
		}
		if classifyOpenAITierBackup(existing) == "rollback" {
			return fmt.Errorf("existing OpenAI tier backup differs from the current config")
		}
		if err := os.Remove(backup); err != nil {
			return err
		}
	} else if !os.IsNotExist(readErr) {
		return readErr
	}
	temp, err := os.CreateTemp(filepath.Dir(path), ".openai-tier-backup-*.tmp")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	if err := temp.Chmod(0o600); err != nil {
		temp.Close()
		return err
	}
	if _, err := temp.Write(original); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	if err := os.Link(tempPath, backup); err != nil {
		if existing, readErr := os.ReadFile(backup); readErr == nil && bytes.Equal(existing, original) {
			return nil
		}
		return err
	}
	return nil
}

func classifyOpenAITierBackup(data []byte) string {
	var value struct {
		Version int `json:"openaiProviderTierVersion"`
	}
	if json.Unmarshal(data, &value) != nil || value.Version == providers.OpenAIProviderTierVersion {
		return "stale"
	}
	return "rollback"
}

func cloneIntValues(values map[string]int) map[string]int {
	if values == nil {
		return nil
	}
	out := make(map[string]int, len(values))
	for key, value := range values {
		out[key] = value
	}
	return out
}

func cloneProviderValues(values map[string]ProviderConfig) map[string]ProviderConfig {
	out := make(map[string]ProviderConfig, len(values))
	for key, value := range values {
		out[key] = value
	}
	return out
}
