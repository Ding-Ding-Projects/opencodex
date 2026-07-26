package claude

import (
	"strings"
	"testing"
)

func TestDesktopProfileSelectionPerFamily(t *testing.T) {
	models := []DesktopProfileModel{
		{Route: "native/gpt-5.6", Label: "GPT 5.6 (native)", ContextWindow: OneMillion},
		{Route: "openrouter/fable", Label: "Fable (openrouter)"},
		{Route: "openrouter/sonnet", Label: "Sonnet (openrouter)"},
		{Route: "openrouter/haiku", Label: "Haiku (openrouter)"},
	}
	profile, err := ReconcileDesktopProfile(nil, models)
	if err != nil {
		t.Fatal(err)
	}
	for route, family := range map[string]DesktopFamily{
		"openrouter/fable":  DesktopFamilyFable,
		"openrouter/sonnet": DesktopFamilySonnet,
		"openrouter/haiku":  DesktopFamilyHaiku,
	} {
		profile, err = MoveDesktopRoute(profile, route, family, true)
		if err != nil {
			t.Fatal(err)
		}
	}
	rendered, err := RenderDesktopProfile(profile, models)
	if err != nil {
		t.Fatal(err)
	}
	if len(rendered) != 4 {
		t.Fatalf("rendered models = %#v", rendered)
	}
	wantFamilies := []DesktopFamily{DesktopFamilyOpus, DesktopFamilyFable, DesktopFamilySonnet, DesktopFamilyHaiku}
	for i, family := range wantFamilies {
		if rendered[i].Family != family || !rendered[i].IsFamilyDefault {
			t.Fatalf("rendered[%d] = %#v", i, rendered[i])
		}
	}
	if !rendered[0].Supports1M {
		t.Fatalf("1M capability missing: %#v", rendered[0])
	}
}

func TestDesktopProfileAliasAllocationStableAcrossInputOrder(t *testing.T) {
	forward := []DesktopProfileModel{{Route: "p/a", Label: "A"}, {Route: "p/b", Label: "B"}}
	reverse := []DesktopProfileModel{{Route: "p/b", Label: "B"}, {Route: "p/a", Label: "A"}}
	a, err := ReconcileDesktopProfile(nil, forward)
	if err != nil {
		t.Fatal(err)
	}
	b, err := ReconcileDesktopProfile(nil, reverse)
	if err != nil {
		t.Fatal(err)
	}
	for _, route := range []string{"p/a", "p/b"} {
		if a.Assignments[route].Alias != b.Assignments[route].Alias {
			t.Fatalf("alias for %s changed: %q != %q", route, a.Assignments[route].Alias, b.Assignments[route].Alias)
		}
	}
}

func TestDesktopProfileRejectsClaudeShapedAliasCollision(t *testing.T) {
	_, err := ParseDesktopProfile(map[string]any{
		"version": 1,
		"assignments": map[string]any{
			"anthropic/claude-opus-4-8-20260101": map[string]any{"family": "opus", "alias": "claude-opus-4-8-20260101"},
			"openrouter/model":                   map[string]any{"family": "fable", "alias": "claude-opus-4-8-20260101"},
		},
		"defaults": map[string]any{"opus": "anthropic/claude-opus-4-8-20260101", "fable": "openrouter/model", "sonnet": nil, "haiku": nil},
	})
	if err == nil || !strings.Contains(err.Error(), "collides") {
		t.Fatalf("collision error = %v", err)
	}
}
