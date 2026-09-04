package server

import (
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/search"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

func TestBaseChatHandlerConfigWiresClaudeOverridesSearchAndUsage(t *testing.T) {
	loop := &search.Loop{MaxSearches: 7}
	var usage *types.Usage
	cfg := config.Default()
	cfg.ClaudeCode = &config.ClaudeCodeConfig{
		ModelMap:      map[string]string{"claude-opus": "provider/model"},
		BlockedSkills: []string{"WebFetch"},
	}
	handler := baseChatHandlerConfig(Config{
		ManagementConfig: &cfg,
		SearchLoop:       loop,
		OnUsage:          func(value *types.Usage) { usage = value },
	}, nil)
	if handler.SearchLoop != loop || handler.ClaudeModelMap["claude-opus"] != "provider/model" || len(handler.ClaudeBlockedSkills) != 1 || handler.ClaudeBlockedSkills[0] != "WebFetch" {
		t.Fatalf("handler config=%#v", handler)
	}
	want := &types.Usage{InputTokens: 3}
	handler.OnUsage(want)
	if usage != want {
		t.Fatalf("usage callback got %#v", usage)
	}
	cfg.ClaudeCode.ModelMap["claude-opus"] = "mutated"
	cfg.ClaudeCode.BlockedSkills[0] = "mutated"
	if handler.ClaudeModelMap["claude-opus"] != "provider/model" || handler.ClaudeBlockedSkills[0] != "WebFetch" {
		t.Fatal("handler retained mutable management config aliases")
	}
}
