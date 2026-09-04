package types

import "testing"

func TestToolChoiceNamespacingAndAliases(t *testing.T) {
	tool := Tool{Name: "lookup", Namespace: "mcp__docs"}
	if got := NamespacedToolName(tool.Namespace, tool.Name); got != "mcp__docs__lookup" {
		t.Fatalf("NamespacedToolName() = %q", got)
	}
	aliases := ToolChoiceAliases(tool)
	if len(aliases) != 2 || aliases[0] != "mcp__docs__lookup" || aliases[1] != "mcp__docs.lookup" {
		t.Fatalf("ToolChoiceAliases() = %#v", aliases)
	}
	allowed := map[string]struct{}{"mcp__docs.lookup": {}}
	if !ToolAllowedByChoice(tool, allowed) {
		t.Fatal("dot alias should allow namespaced tool")
	}
	if got := ResolveToolChoiceWireName([]Tool{tool}, "mcp__docs.lookup"); got != "mcp__docs__lookup" {
		t.Fatalf("ResolveToolChoiceWireName() = %q", got)
	}
}

func TestModelInListMatchesTaggedFamilyOnly(t *testing.T) {
	list := []string{"gpt-oss", "grok-build-0.1"}
	for _, model := range []string{"gpt-oss", "gpt-oss:120b", "grok-build-0.1"} {
		if !ModelInList(list, model) {
			t.Errorf("ModelInList(%q) = false", model)
		}
	}
	for _, model := range []string{"gpt", "other:120b"} {
		if ModelInList(list, model) {
			t.Errorf("ModelInList(%q) = true", model)
		}
	}
}
