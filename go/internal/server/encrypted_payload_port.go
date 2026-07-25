package server

import (
	"encoding/base64"
	"regexp"
	"strings"
)

var (
	fernetCandidate      = regexp.MustCompile(`g[A-Za-z0-9_-]{97,}={0,2}`)
	fernetBoundary       = regexp.MustCompile(`[A-Za-z0-9_=-]`)
	opaqueCiphertext     = regexp.MustCompile(`^[A-Za-z0-9+/=_-]+$`)
	agentRoutingEnvelope = regexp.MustCompile(`(?is)(?:^|\n)Message Type\s*:\s*NEW_TASK[^\n]*\nTask name\s*:[^\n]*\nSender\s*:[^\n]*\nPayload\s*:\s*(?:\n|$)`)
)

type encryptedRun struct {
	start int
	end   int
	token string
}

// IsStructurallyValidFernetToken validates the key-independent Fernet wire
// shape: version, timestamp, IV, block-aligned ciphertext, and HMAC.
func IsStructurallyValidFernetToken(token string) bool {
	if len(token) < 100 || len(token)%4 != 0 {
		return false
	}
	trimmed := strings.TrimRight(token, "=")
	expectedPadding := (4 - len(trimmed)%4) % 4
	if expectedPadding > 2 || len(token)-len(trimmed) != expectedPadding {
		return false
	}
	decoded, err := base64.RawURLEncoding.DecodeString(trimmed)
	if err != nil || len(decoded) < 73 || decoded[0] != 0x80 {
		return false
	}
	return (len(decoded)-57)%16 == 0
}

func isBackendCiphertextSlot(payload string) bool {
	trimmed := strings.TrimSpace(payload)
	return len(trimmed) >= 64 && opaqueCiphertext.MatchString(trimmed)
}

func fernetRuns(payload string) []encryptedRun {
	indices := fernetCandidate.FindAllStringIndex(payload, -1)
	runs := make([]encryptedRun, 0, len(indices))
	for _, index := range indices {
		if index[0] > 0 && fernetBoundary.MatchString(payload[index[0]-1:index[0]]) {
			continue
		}
		if index[1] < len(payload) && fernetBoundary.MatchString(payload[index[1]:index[1]+1]) {
			continue
		}
		token := payload[index[0]:index[1]]
		if IsStructurallyValidFernetToken(token) {
			runs = append(runs, encryptedRun{start: index[0], end: index[1], token: token})
		}
	}
	return runs
}

// EncryptedSlotParts separates plaintext control metadata from embedded Fernet
// ciphertext without relabeling the opaque token.
func EncryptedSlotParts(payload string) []map[string]any {
	runs := fernetRuns(payload)
	parts := make([]map[string]any, 0, len(runs)*2+1)
	last := 0
	for _, run := range runs {
		if text := payload[last:run.start]; strings.TrimSpace(text) != "" {
			parts = append(parts, map[string]any{"type": "input_text", "text": text})
		}
		parts = append(parts, map[string]any{"type": "encrypted_content", "encrypted_content": run.token})
		last = run.end
	}
	if text := payload[last:]; strings.TrimSpace(text) != "" {
		parts = append(parts, map[string]any{"type": "input_text", "text": text})
	}
	if len(parts) == 0 {
		return []map[string]any{{"type": "input_text", "text": payload}}
	}
	return parts
}

// SanitizeEncryptedContentSlots rewrites plaintext mislabeled as encrypted
// content and splits mixed plaintext/ciphertext slots in place.
func SanitizeEncryptedContentSlots(input any) int {
	return sanitizeEncryptedNode(input)
}

// SanitizeEncryptedContentSlice is the top-level slice form. A pointer is used
// because splitting one mixed slot can grow the slice header.
func SanitizeEncryptedContentSlice(input *[]any) int {
	if input == nil {
		return 0
	}
	updated, rewritten := sanitizeEncryptedSlice(*input)
	*input = updated
	return rewritten
}

func sanitizeEncryptedNode(node any) int {
	rewritten := 0
	switch value := node.(type) {
	case []any:
		_, rewritten = sanitizeEncryptedSlice(value)
	case map[string]any:
		for key, child := range value {
			if items, ok := child.([]any); ok {
				updated, count := sanitizeEncryptedSlice(items)
				value[key] = updated
				rewritten += count
			} else {
				rewritten += sanitizeEncryptedNode(child)
			}
		}
	}
	return rewritten
}

func sanitizeEncryptedSlice(value []any) ([]any, int) {
	rewritten := 0
	for index := 0; index < len(value); index++ {
		part, ok := value[index].(map[string]any)
		payload, payloadOK := part["encrypted_content"].(string)
		if ok && payloadOK && part["type"] == "encrypted_content" && !isBackendCiphertextSlot(payload) {
			replacements := EncryptedSlotParts(payload)
			items := make([]any, len(replacements))
			for i := range replacements {
				items[i] = replacements[i]
			}
			value = append(value[:index], append(items, value[index+1:]...)...)
			index += len(items) - 1
			rewritten++
			continue
		}
		rewritten += sanitizeEncryptedNode(value[index])
	}
	return value, rewritten
}

// HasUnreadableEncryptedAgentTask inspects only the latest task-bearing item;
// historical encrypted agent messages do not poison a newer turn.
func HasUnreadableEncryptedAgentTask(input any) bool {
	items, ok := input.([]any)
	if !ok {
		return false
	}
	index := len(items) - 1
	for index >= 0 {
		item, _ := items[index].(map[string]any)
		kind, _ := item["type"].(string)
		if kind != "compaction_trigger" && kind != "additional_tools" {
			break
		}
		index--
	}
	if index < 0 {
		return false
	}
	item, _ := items[index].(map[string]any)
	if item["type"] != "agent_message" {
		return false
	}
	content, _ := item["content"].([]any)
	var readable strings.Builder
	hasCipher := false
	for _, rawPart := range content {
		part, _ := rawPart.(map[string]any)
		if text, ok := part["text"].(string); ok && (part["type"] == "text" || part["type"] == "input_text") {
			readable.WriteString(text)
			readable.WriteString("\n\n")
		}
		payload, ok := part["encrypted_content"].(string)
		if !ok || part["type"] != "encrypted_content" {
			continue
		}
		runs := fernetRuns(payload)
		if len(runs) > 0 {
			hasCipher = true
		}
		last := 0
		for _, run := range runs {
			readable.WriteString(payload[last:run.start])
			last = run.end
		}
		readable.WriteString(payload[last:])
	}
	plain := agentRoutingEnvelope.ReplaceAllString(readable.String(), "\n")
	plain = stripCXCControlParagraphs(plain)
	return hasCipher && strings.TrimSpace(plain) == ""
}

func stripCXCControlParagraphs(value string) string {
	// Go's regexp engine intentionally has no negative lookahead, so remove one
	// CXC paragraph at a time and stop at a blank line or routing envelope.
	lines := strings.Split(value, "\n")
	out := make([]string, 0, len(lines))
	for index := 0; index < len(lines); {
		if strings.HasPrefix(strings.TrimSpace(lines[index]), "[CXC-") {
			index++
			for index < len(lines) && strings.TrimSpace(lines[index]) != "" && !strings.HasPrefix(lines[index], "Message Type:") {
				index++
			}
			continue
		}
		out = append(out, lines[index])
		index++
	}
	return strings.Join(out, "\n")
}
