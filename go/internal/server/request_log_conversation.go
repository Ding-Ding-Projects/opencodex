package server

// Best-effort chat/session correlation for request logs and usage.jsonl,
// ported from src/server/request-log-conversation.ts.
//
// The inputs here are CLIENT-CONTROLLED headers. A user id, an email, or a
// short secret can arrive in any of them, so nothing is ever persisted raw:
// every id is hashed before it can reach a log file the user might paste into
// an issue.

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

const (
	// logConversationInputMax rejects absurd client strings before hashing, so
	// a large header cannot be turned into work or JSONL bloat.
	logConversationInputMax = 4096
	// LogConversationIDLen is the persisted length. Always a hex digest.
	LogConversationIDLen = 32
)

// utf16Length counts the code units a JavaScript string would report.
// Characters outside the basic multilingual plane cost two.
func utf16Length(value string) int {
	units := 0
	for _, character := range value {
		if character > 0xffff {
			units += 2
		} else {
			units++
		}
	}
	return units
}

func hasControlChars(value string) bool {
	for index := 0; index < len(value); index++ {
		if value[index] <= 0x1f || value[index] == 0x7f {
			return true
		}
	}
	return false
}

// NormalizeLogConversationID caps and hashes a correlation id for persistence.
//
// It ALWAYS hashes, even for something that already looks like a digest: the
// point is that no client-controlled text ever lands in usage.jsonl, and an
// exception for "looks safe" is how the raw values get in.
func NormalizeLogConversationID(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	// Control characters would break JSONL and a UI paste.
	if hasControlChars(trimmed) {
		return ""
	}
	// Counted in UTF-16 code units, not bytes, because that is what the oracle
	// counts. A CJK id of 1366 characters is 4098 bytes but only 1366 units:
	// capping on bytes would refuse here what TypeScript accepted, and the
	// same conversation would stop grouping the moment it crossed runtimes.
	if utf16Length(trimmed) > logConversationInputMax {
		return ""
	}
	digest := sha256.Sum256([]byte(trimmed))
	return hex.EncodeToString(digest[:])[:LogConversationIDLen]
}

// MatchesLogConversationID accepts either the stored digest or the original
// preimage, so pasting from the Logs detail and pasting the client-facing
// session id both work.
func MatchesLogConversationID(stored, query string) bool {
	if stored == "" {
		return false
	}
	trimmed := strings.TrimSpace(query)
	if trimmed == "" {
		return false
	}
	if stored == trimmed {
		return true
	}
	hashed := NormalizeLogConversationID(trimmed)
	return hashed != "" && stored == hashed
}

// ConversationIDFromResponsesRequest picks the id this turn correlates on.
//
// The order is Codex/Claude/Cursor priority: an explicit parent thread beats a
// session header, which beats a thread header, which beats Cursor's own
// conversation id. Taking a later one first would split one conversation
// across ids when a client sends more than one.
//
// Selection stops at the first PRESENT source, not the first non-blank one.
// The oracle uses `??`, which falls through on absent but not on empty, so a
// client sending an empty parent thread correlates on nothing rather than
// silently falling through to a different id. Matching that keeps a
// conversation grouped identically across the two runtimes, which is the only
// reason the digest is shared at all.
func ConversationIDFromResponsesRequest(clientThreadID, sessionIDHeader, threadIDHeader, cursorConversationID string) string {
	return NormalizeLogConversationID(firstPresent(clientThreadID, sessionIDHeader, threadIDHeader, cursorConversationID))
}

// firstPresent returns the first source the client actually sent, empty or not.
// Absence is signalled by "", so a caller that must distinguish an empty header
// from a missing one has to resolve that at the header boundary.
func firstPresent(candidates ...string) string {
	for _, candidate := range candidates {
		if candidate != "" {
			return candidate
		}
	}
	return ""
}

// SessionIDHeader reads the two spellings clients actually send.
//
// Presence rather than non-emptiness: an explicitly empty session_id shadows
// session-id here exactly as `??` shadows it in the oracle.
func SessionIDHeader(header interface{ Get(string) string }) string {
	if values, ok := header.(interface{ Values(string) []string }); ok {
		if present := values.Values("session_id"); len(present) > 0 {
			return present[0]
		}
		if present := values.Values("session-id"); len(present) > 0 {
			return present[0]
		}
		return ""
	}
	if value := header.Get("session_id"); value != "" {
		return value
	}
	return header.Get("session-id")
}

// ConversationIDFromClaudeMetadata uses Claude Code's metadata.user_id ONLY.
//
// Never the Desktop system-hash fallback: that value is derived from the
// machine rather than the conversation, so it would group every Desktop
// request on a host into one thread.
//
// The Claude ingress carries the raw id through as
// claude.AnthropicRequestTranslation.ConversationUserID. It is hashed HERE
// rather than at the ingress, so the persistence rule lives in one place with
// the sanitising and the cap.
func ConversationIDFromClaudeMetadata(metadata map[string]any) string {
	if metadata == nil {
		return ""
	}
	userID, ok := metadata["user_id"].(string)
	if !ok {
		return ""
	}
	return NormalizeLogConversationID(userID)
}
