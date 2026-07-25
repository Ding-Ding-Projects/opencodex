package types

import "testing"

func TestIsWirePinnedModel(t *testing.T) {
	tests := []struct {
		provider string
		model    string
		want     bool
	}{
		{"opencode-go", "minimax-m2.5", true},
		{"opencode-go", "minimax-m2.7", true},
		{"opencode-go", "minimax-m3", true},
		{"opencode-go", "gpt-4o", false},
		{"other-provider", "minimax-m2.5", false},
		{"", "", false},
	}
	for _, tt := range tests {
		t.Run(tt.provider+"/"+tt.model, func(t *testing.T) {
			if got := IsWirePinnedModel(tt.provider, tt.model); got != tt.want {
				t.Errorf("IsWirePinnedModel(%q, %q) = %v, want %v", tt.provider, tt.model, got, tt.want)
			}
		})
	}
}

func TestPinnedWireAdapter(t *testing.T) {
	if got := PinnedWireAdapter("opencode-go", "minimax-m2.5"); got != "anthropic" {
		t.Errorf("PinnedWireAdapter(opencode-go, minimax-m2.5) = %q, want anthropic", got)
	}
	if got := PinnedWireAdapter("opencode-go", "gpt-4o"); got != "" {
		t.Errorf("PinnedWireAdapter(opencode-go, gpt-4o) = %q, want empty", got)
	}
	if got := PinnedWireAdapter("other", "minimax-m2.5"); got != "" {
		t.Errorf("PinnedWireAdapter(other, minimax-m2.5) = %q, want empty", got)
	}
}

func TestModelAdapterOverrideAllowed(t *testing.T) {
	if !ModelAdapterOverrideAllowed["openai-chat"] {
		t.Error("openai-chat should be allowed")
	}
	if !ModelAdapterOverrideAllowed["openai-responses"] {
		t.Error("openai-responses should be allowed")
	}
	if ModelAdapterOverrideAllowed["cursor"] {
		t.Error("cursor should not be allowed")
	}
	if ModelAdapterOverrideAllowed["anthropic"] {
		t.Error("anthropic should not be allowed")
	}
}

func TestEventAssistantBoundaryExists(t *testing.T) {
	if EventAssistantBoundary != "assistant_boundary" {
		t.Errorf("EventAssistantBoundary = %q, want assistant_boundary", EventAssistantBoundary)
	}
}
