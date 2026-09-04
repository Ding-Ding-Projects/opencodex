package oauth

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestDetectGrokCLITokenAndGenerationRules(t *testing.T) {
	path := filepath.Join(t.TempDir(), "auth.json")
	if err := os.WriteFile(path, []byte(`{"https://auth.x.ai::profile":{"key":"access","refresh_token":"refresh","expires_at":"2030-01-01T00:00:00Z","user_id":"u1","email":"USER@EXAMPLE.COM"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	credential, ok := DetectGrokCLIToken(path)
	if !ok || credential.Source != SourceLocalCLI || credential.Email != "user@example.com" {
		t.Fatalf("credential=%#v ok=%v", credential, ok)
	}
	stored := OAuthCredentials{AccountID: "u1", Expires: credential.Expires - 1}
	if !HasComparableGrokIdentity(stored, credential) || !IsSameGrokIdentity(stored, credential) {
		t.Fatal("identity comparison failed")
	}
	if !ShouldAdoptGrokGeneration(stored, credential, time.Unix(0, 0), time.Minute) {
		t.Fatal("newer live generation was not adopted")
	}
}

func TestDetectClaudeCodeTokenFromExplicitProfile(t *testing.T) {
	dir := t.TempDir()
	data := `{"claudeAiOauth":{"accessToken":"access-secret","refreshToken":"refresh-secret","expiresAt":4102444800000}}`
	if err := os.WriteFile(filepath.Join(dir, ".credentials.json"), []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
	credential, ok := DetectClaudeCodeToken(dir)
	if !ok || credential.Access != "access-secret" || credential.Refresh != "refresh-secret" || credential.Expires != 4102444800000 || credential.Source != SourceLocalCLI {
		t.Fatalf("Claude credential metadata mismatch: found=%t source=%q expires=%d", ok, credential.Source, credential.Expires)
	}
}

func TestParseClaudeOAuthPayloadRejectsIncompleteAndOversizedData(t *testing.T) {
	for _, data := range [][]byte{
		[]byte(`{"claudeAiOauth":{"accessToken":"access-only"}}`),
		make([]byte, maxLocalTokenFileBytes+1),
	} {
		if _, ok := ParseClaudeOAuthPayload(data); ok {
			t.Fatal("invalid Claude credential was accepted")
		}
	}
}
