package config

import (
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
)

func TestConfigLoadSaveRoundTripAndEnvironmentExpansion(t *testing.T) {
	t.Setenv("OCX_TEST_KEY", `key-with-"quotes"`)
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	cfg := Default()
	cfg.AuthToken = "${OCX_TEST_KEY}"
	cfg.Providers["test"] = ProviderConfig{
		Adapter: "openai-chat",
		BaseURL: "https://example.com/v1",
		APIKey:  "$OCX_TEST_KEY",
	}
	cfg.DefaultProvider = "test"
	cfg.Debug.Enabled = true
	cfg.Log.Level = "debug"

	if err := Save(path, &cfg); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); runtime.GOOS != "windows" && got != 0o600 {
		t.Fatalf("config permissions = %o, want 600", got)
	}

	loaded, err := Load(path)
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	wantSecret := `key-with-"quotes"`
	if loaded.AuthToken != wantSecret || loaded.Providers["test"].APIKey != wantSecret {
		t.Fatalf("environment expansion failed: %#v", loaded)
	}

	expected := cfg
	expected.AuthToken = wantSecret
	provider := expected.Providers["test"]
	provider.APIKey = wantSecret
	expected.Providers["test"] = provider
	if !reflect.DeepEqual(*loaded, expected) {
		t.Fatalf("round trip mismatch\n got: %#v\nwant: %#v", *loaded, expected)
	}
}

func TestLoadRejectsInvalidPort(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(`{"port":70000,"hostname":"127.0.0.1","providers":{},"defaultProvider":"openai"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); !IsConfigError(err) {
		t.Fatalf("Load() error = %v, want ConfigError", err)
	}
}

func TestValidateModelAdapters(t *testing.T) {
	tests := []struct {
		name         string
		providerName string
		provider     ProviderConfig
		wantErr      bool
	}{
		{
			name:         "empty modelAdapters",
			providerName: "test",
			provider:     ProviderConfig{Adapter: "openai-chat", BaseURL: "https://example.com/v1"},
			wantErr:      false,
		},
		{
			name:         "valid override",
			providerName: "grok",
			provider: ProviderConfig{
				Adapter:       "openai-chat",
				BaseURL:       "https://api.x.ai/v1",
				ModelAdapters: map[string]string{"grok-3": "openai-responses"},
			},
			wantErr: false,
		},
		{
			name:         "invalid wire",
			providerName: "test",
			provider: ProviderConfig{
				Adapter:       "openai-chat",
				BaseURL:       "https://example.com/v1",
				ModelAdapters: map[string]string{"gpt-4o": "cursor"},
			},
			wantErr: true,
		},
		{
			name:         "pinned model override rejected",
			providerName: "opencode-go",
			provider: ProviderConfig{
				Adapter:       "openai-chat",
				BaseURL:       "https://example.com/v1",
				ModelAdapters: map[string]string{"minimax-m2.5": "openai-chat"},
			},
			wantErr: true,
		},
		{
			name:         "canonical forward override rejected",
			providerName: "openai",
			provider: ProviderConfig{
				Adapter:       "openai-responses",
				AuthMode:      "forward",
				BaseURL:       "https://chatgpt.com/backend-api/codex",
				ModelAdapters: map[string]string{"gpt-4o": "openai-chat"},
			},
			wantErr: true,
		},
		{
			name:         "blank model id rejected",
			providerName: "test",
			provider: ProviderConfig{
				Adapter:       "openai-chat",
				BaseURL:       "https://example.com/v1",
				ModelAdapters: map[string]string{"  ": "openai-chat"},
			},
			wantErr: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateModelAdapters(tt.providerName, tt.provider)
			if (err != nil) != tt.wantErr {
				t.Errorf("ValidateModelAdapters() error = %v, wantErr %v", err, tt.wantErr)
			}
			if err != nil && !IsConfigError(err) {
				t.Errorf("ValidateModelAdapters() error = %v, want ConfigError", err)
			}
		})
	}
}
