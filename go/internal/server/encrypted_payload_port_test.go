package server

import (
	"encoding/base64"
	"strings"
	"testing"
)

func validFernetToken() string {
	payload := make([]byte, 73)
	payload[0] = 0x80
	return base64.URLEncoding.EncodeToString(payload)
}

func TestEncryptedSlotPartsAndUnreadableTask(t *testing.T) {
	token := validFernetToken()
	if !IsStructurallyValidFernetToken(token) {
		t.Fatal("fixture should be structurally valid")
	}
	parts := EncryptedSlotParts("prefix\n" + token + "\nsuffix")
	if len(parts) != 3 || parts[1]["encrypted_content"] != token {
		t.Fatalf("parts = %#v", parts)
	}
	controlOnly := []any{map[string]any{
		"type": "agent_message", "content": []any{map[string]any{
			"type": "encrypted_content", "encrypted_content": "[CXC-SUBAGENT-SCOPE] bounded\n\nMessage Type: NEW_TASK\nTask name: x\nSender: y\nPayload:\n" + token,
		}},
	}}
	if !HasUnreadableEncryptedAgentTask(controlOnly) {
		t.Fatal("control-only encrypted task should be unreadable")
	}
	controlOnly[0].(map[string]any)["content"].([]any)[0].(map[string]any)["encrypted_content"] = token + "\nreal task"
	if HasUnreadableEncryptedAgentTask(controlOnly) {
		t.Fatal("plaintext task should remain readable")
	}
}

func TestSanitizeEncryptedContentSlots(t *testing.T) {
	token := validFernetToken()
	content := []any{map[string]any{"type": "encrypted_content", "encrypted_content": "note " + token}}
	if got := SanitizeEncryptedContentSlice(&content); got != 1 {
		t.Fatalf("rewritten = %d", got)
	}
	if len(content) != 2 {
		t.Fatalf("content = %#v", content)
	}
	if !strings.Contains(content[0].(map[string]any)["text"].(string), "note") {
		t.Fatalf("plaintext part = %#v", content[0])
	}
	opaque := []any{map[string]any{"type": "encrypted_content", "encrypted_content": strings.Repeat("A", 64)}}
	if got := SanitizeEncryptedContentSlice(&opaque); got != 0 || len(opaque) != 1 {
		t.Fatalf("opaque ciphertext was rewritten: %#v", opaque)
	}
}
