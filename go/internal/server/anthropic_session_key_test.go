package server

import (
	"net/http"
	"testing"
)

// The Anthropic pool needs the oracle's session key, and reusing the Codex
// thread id produced an empty one for requests carrying only session-id. An
// empty key is not harmless: the pool reads it as "no session identity" and
// holds the active account instead of rotating, so both affinity and rotation
// were wrong on that path.
func TestAuthSelectionKeyUsesTheAnthropicContractOnlyForAnthropic(t *testing.T) {
	sessionOnly := http.Header{}
	sessionOnly.Set("session-id", "S")

	if got := authSelectionKey("anthropic", sessionOnly, "", false); got != "S" {
		t.Fatalf("anthropic with only session-id = %q, oracle derives S", got)
	}
	// Every other provider keeps the existing thread-id contract untouched.
	if got := authSelectionKey("openai", sessionOnly, "", false); got != "" {
		t.Fatalf("openai key = %q, want the unchanged thread-id behaviour", got)
	}

	// Priority: client thread id beats the session header, which beats
	// thread-id. authThreadID has the opposite order, which is why the two
	// cannot share an implementation.
	full := http.Header{}
	full.Set("X-Codex-Parent-Thread-Id", "CT")
	full.Set("session-id", "S")
	full.Set("Thread-Id", "T")
	if got := authSelectionKey("anthropic", full, "P", false); got != "CT" {
		t.Fatalf("anthropic full headers = %q, oracle prefers the client thread id", got)
	}
	if got := authSelectionKey("openai", full, "P", false); got != "T" {
		t.Fatalf("openai full headers = %q, authThreadID prefers Thread-Id", got)
	}

	// The underscore spelling is accepted too, since the oracle reads
	// session_id before session-id.
	underscore := http.Header{}
	underscore.Set("session_id", "U")
	if got := authSelectionKey("anthropic", underscore, "", false); got != "U" {
		t.Fatalf("session_id spelling = %q, want U", got)
	}

	// A prompt cache key is the last resort, and a shared Desktop cohort key is
	// refused so unrelated users are not pinned onto one account.
	bare := http.Header{}
	if got := authSelectionKey("anthropic", bare, "P", false); got != "P" {
		t.Fatalf("prompt cache fallback = %q, want P", got)
	}
	if got := authSelectionKey("anthropic", bare, "P", true); got != "" {
		t.Fatalf("shared cohort key = %q, want no key", got)
	}
}
