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
