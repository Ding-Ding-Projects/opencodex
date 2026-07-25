package providers

import "testing"

func TestSlugCodecExactAliasAndAmbiguity(t *testing.T) {
	if got := RoutedSlug("openrouter", "anthropic/claude"); got != "openrouter/anthropic-claude" {
		t.Fatal(got)
	}
	if got := DecodeRoutedModelID("anthropic-claude", []string{"anthropic/claude"}); got != "anthropic/claude" {
		t.Fatal(got)
	}
	if got := DecodeRoutedModelID("a-b", []string{"a/b", "a-b"}); got != "a-b" {
		t.Fatal(got)
	}
}
func TestSlugEquivalence(t *testing.T) {
	if !SlugsEquivalent("openrouter/a/b", "openrouter/a-b") || SlugsEquivalent("x/a-b", "y/a/b") {
		t.Fatal("equivalence mismatch")
	}
}
