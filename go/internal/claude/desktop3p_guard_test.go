package claude

import (
	"os"
	"strings"
	"testing"
)

func TestAssertDesktop3pModelsValid(t *testing.T) {
	valid := Desktop3pModelEntry{
		Name:                "claude-opus-4-8-abc",
		LabelOverride:       "Kimi K2 1M (openrouter)",
		AnthropicFamilyTier: "opus",
	}
	tests := []struct {
		name    string
		models  []Desktop3pModelEntry
		wantErr string
	}{
		{name: "valid list", models: []Desktop3pModelEntry{valid}},
		{name: "invalid name", models: []Desktop3pModelEntry{{Name: "gpt-5.6", LabelOverride: "GPT 5.6"}}, wantErr: "Desktop 3P model name is not a valid Claude-shaped id: gpt-5.6"},
		{name: "duplicate name", models: []Desktop3pModelEntry{valid, valid}, wantErr: "Desktop 3P model name duplicated: claude-opus-4-8-abc"},
		{name: "raw marker", models: []Desktop3pModelEntry{{Name: "claude-opus-4-8-def", LabelOverride: "Kimi K2 [1m]"}}, wantErr: "Desktop 3P label carries a raw capability marker: Kimi K2 [1m]"},
		{name: "overlong label", models: []Desktop3pModelEntry{{Name: "claude-opus-4-8-ghi", LabelOverride: strings.Repeat("x", 81)}}, wantErr: "Desktop 3P label exceeds 80 chars: " + strings.Repeat("x", 81)},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := AssertDesktop3pModelsValid(test.models)
			if test.wantErr == "" {
				if err != nil {
					t.Fatalf("valid models rejected: %v", err)
				}
				return
			}
			if err == nil || err.Error() != test.wantErr {
				t.Fatalf("validation error = %v, want %q", err, test.wantErr)
			}
		})
	}
}

func TestApplyDesktop3pConfigNormalizesCapabilityMarkersBeforeValidation(t *testing.T) {
	dir := t.TempDir()
	result, err := ApplyDesktop3pConfig(
		dir,
		10100,
		nil,
		[]Desktop3pRoutedModel{{Provider: "openrouter", ID: "kimi-k2[1m]"}},
		"ocx",
		Desktop3pStatic,
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(result.Path)
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := DecodeDesktop3pConfig(data)
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.InferenceModels) != 1 {
		t.Fatalf("inference models = %#v", cfg.InferenceModels)
	}
	if got := cfg.InferenceModels[0].LabelOverride; got != "Kimi K2 1M (openrouter)" {
		t.Fatalf("normalized label = %q", got)
	}
	if err := AssertDesktop3pModelsValid(cfg.InferenceModels); err != nil {
		t.Fatalf("normalized models rejected: %v", err)
	}
}
