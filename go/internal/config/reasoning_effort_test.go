package config

import (
	"reflect"
	"testing"
)

func TestIsCodexReasoningEffort(t *testing.T) {
	for _, e := range []string{"low", "medium", "high", "xhigh", "max", "ultra"} {
		if !IsCodexReasoningEffort(e) {
			t.Errorf("IsCodexReasoningEffort(%q) = false, want true", e)
		}
	}
	for _, e := range []string{"", "none", "minimal", "enabled", "disabled"} {
		if IsCodexReasoningEffort(e) {
			t.Errorf("IsCodexReasoningEffort(%q) = true, want false", e)
		}
	}
}

func TestCodexEffortRank(t *testing.T) {
	if r := CodexEffortRank("low"); r != 0 {
		t.Errorf("rank(low) = %d, want 0", r)
	}
	if r := CodexEffortRank("ultra"); r != 5 {
		t.Errorf("rank(ultra) = %d, want 5", r)
	}
	if r := CodexEffortRank("bogus"); r != -1 {
		t.Errorf("rank(bogus) = %d, want -1", r)
	}
}

func TestSanitizeCodexReasoningEfforts(t *testing.T) {
	got := SanitizeCodexReasoningEfforts([]string{"high", "low", "bogus", "high", "max"})
	want := []string{"low", "high", "max"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("Sanitize = %v, want %v", got, want)
	}
	if SanitizeCodexReasoningEfforts(nil) != nil {
		t.Error("nil input should return nil")
	}
}

func TestModelRecordValue(t *testing.T) {
	record := map[string][]string{
		"gpt-4o":       {"low", "high"},
		"claude":       {"medium"},
		"o3":           {"low", "medium", "high"},
	}
	if v, ok := ModelRecordValue(record, "gpt-4o"); !ok || len(v) != 2 {
		t.Errorf("exact match failed: %v %v", v, ok)
	}
	if v, ok := ModelRecordValue(record, "gpt-4o:latest"); !ok || len(v) != 2 {
		t.Errorf("family prefix failed: %v %v", v, ok)
	}
	if v, ok := ModelRecordValue(record, "GPT-4O"); !ok || len(v) != 2 {
		t.Errorf("case-insensitive failed: %v %v", v, ok)
	}
	if _, ok := ModelRecordValue(record, "unknown"); ok {
		t.Error("unknown should not match")
	}
}

func TestModelInList(t *testing.T) {
	list := []string{"gpt-4o", "claude-3.5-sonnet"}
	if !ModelInList(list, "gpt-4o") {
		t.Error("exact match")
	}
	if !ModelInList(list, "gpt-4o:latest") {
		t.Error("family prefix")
	}
	if !ModelInList(list, "GPT-4O") {
		t.Error("case-insensitive")
	}
	if ModelInList(list, "gpt-3.5") {
		t.Error("should not match")
	}
}

func TestConfiguredReasoningEfforts(t *testing.T) {
	provider := ProviderConfig{
		Adapter:          "openai-chat",
		BaseURL:          "https://example.com",
		ReasoningEfforts: []string{"low", "medium", "high"},
		NoReasoningModels: []string{"gpt-3.5-turbo"},
	}
	got := ConfiguredReasoningEfforts(provider, "gpt-4o")
	want := []string{"low", "medium", "high"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("ConfiguredReasoningEfforts = %v, want %v", got, want)
	}
	got = ConfiguredReasoningEfforts(provider, "gpt-3.5-turbo")
	if len(got) != 0 {
		t.Errorf("noReasoningModel should return empty, got %v", got)
	}
}

func TestMapReasoningEffort(t *testing.T) {
	provider := ProviderConfig{
		Adapter:          "openai-chat",
		BaseURL:          "https://example.com",
		ReasoningEfforts: []string{"low", "medium", "high"},
	}
	if got := MapReasoningEffort(provider, "gpt-4o", "high"); got != "high" {
		t.Errorf("MapReasoningEffort(high) = %q, want high", got)
	}
	if got := MapReasoningEffort(provider, "gpt-4o", "ultra"); got != "high" {
		t.Errorf("MapReasoningEffort(ultra) = %q, want high (clamped)", got)
	}
	if got := MapReasoningEffort(provider, "gpt-4o", ""); got != "" {
		t.Errorf("MapReasoningEffort(empty) = %q, want empty", got)
	}
	// Wire map override
	provider.ReasoningEffortMap = map[string]string{"high": "thinking_budget_high"}
	if got := MapReasoningEffort(provider, "gpt-4o", "high"); got != "thinking_budget_high" {
		t.Errorf("MapReasoningEffort(high with wire map) = %q, want thinking_budget_high", got)
	}
}
