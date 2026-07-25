package oauth

import (
	"encoding/json"
	"os"
	"strings"
	"time"
)

const maxLocalTokenFileBytes = 2 << 20

// DetectGrokCLIToken reads but never mutates the Grok CLI credential store.
func DetectGrokCLIToken(path string) (OAuthCredentials, bool) {
	data, err := os.ReadFile(path)
	if err != nil || len(data) > maxLocalTokenFileBytes {
		return OAuthCredentials{}, false
	}
	var document map[string]struct {
		Key          string `json:"key"`
		RefreshToken string `json:"refresh_token"`
		ExpiresAt    string `json:"expires_at"`
		UserID       string `json:"user_id"`
		Email        string `json:"email"`
	}
	if json.Unmarshal(data, &document) != nil {
		return OAuthCredentials{}, false
	}
	for key, entry := range document {
		if !strings.HasPrefix(key, "https://auth.x.ai::") || entry.Key == "" || entry.RefreshToken == "" {
			continue
		}
		expires, _ := time.Parse(time.RFC3339, entry.ExpiresAt)
		return OAuthCredentials{Access: entry.Key, Refresh: entry.RefreshToken, Expires: expires.UnixMilli(), AccountID: entry.UserID, Email: strings.ToLower(entry.Email), Source: SourceLocalCLI}, true
	}
	return OAuthCredentials{}, false
}

func HasComparableGrokIdentity(stored, disk OAuthCredentials) bool {
	return (stored.AccountID != "" && disk.AccountID != "") || (stored.Email != "" && disk.Email != "")
}

func IsSameGrokIdentity(stored, disk OAuthCredentials) bool {
	if stored.AccountID != "" && disk.AccountID != "" {
		return stored.AccountID == disk.AccountID
	}
	return stored.Email != "" && disk.Email != "" && strings.EqualFold(stored.Email, disk.Email)
}

func ShouldAdoptGrokGeneration(stored, disk OAuthCredentials, now time.Time, refreshSkew time.Duration) bool {
	if disk.Expires <= now.Add(refreshSkew).UnixMilli() {
		return false
	}
	if stored.Expires > 0 && disk.Expires > 0 {
		return disk.Expires >= stored.Expires
	}
	return true
}
