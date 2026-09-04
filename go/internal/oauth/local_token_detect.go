package oauth

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const maxLocalTokenFileBytes = 2 << 20
const claudeKeychainService = "Claude Code-credentials"

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

// ParseClaudeOAuthPayload parses Claude Code's secure-storage envelope without
// exposing credential values in errors or logs.
func ParseClaudeOAuthPayload(data []byte) (OAuthCredentials, bool) {
	if len(data) == 0 || len(data) > maxLocalTokenFileBytes {
		return OAuthCredentials{}, false
	}
	var document struct {
		OAuth struct {
			AccessToken  string `json:"accessToken"`
			RefreshToken string `json:"refreshToken"`
			ExpiresAt    int64  `json:"expiresAt"`
		} `json:"claudeAiOauth"`
	}
	if json.Unmarshal(data, &document) != nil || document.OAuth.AccessToken == "" || document.OAuth.RefreshToken == "" {
		return OAuthCredentials{}, false
	}
	return OAuthCredentials{
		Access: document.OAuth.AccessToken, Refresh: document.OAuth.RefreshToken,
		Expires: document.OAuth.ExpiresAt, Source: SourceLocalCLI,
	}, true
}

// DetectClaudeCodeToken reads Claude Code secure storage. An explicit configDir
// selects that profile's file before the default macOS Keychain credential.
func DetectClaudeCodeToken(configDir string) (OAuthCredentials, bool) {
	explicit := strings.TrimSpace(configDir) != ""
	if !explicit {
		configDir = strings.TrimSpace(os.Getenv("CLAUDE_CONFIG_DIR"))
		explicit = configDir != ""
	}
	if configDir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return OAuthCredentials{}, false
		}
		configDir = filepath.Join(home, ".claude")
	}
	readFile := func() (OAuthCredentials, bool) {
		data, err := os.ReadFile(filepath.Join(configDir, ".credentials.json"))
		if err != nil {
			return OAuthCredentials{}, false
		}
		return ParseClaudeOAuthPayload(data)
	}
	readKeychain := func() (OAuthCredentials, bool) {
		if runtime.GOOS != "darwin" {
			return OAuthCredentials{}, false
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		data, err := exec.CommandContext(ctx, "security", "find-generic-password", "-s", claudeKeychainService, "-w").Output()
		if err != nil {
			return OAuthCredentials{}, false
		}
		return ParseClaudeOAuthPayload(data)
	}
	if explicit {
		if credential, ok := readFile(); ok {
			return credential, true
		}
		return readKeychain()
	}
	if credential, ok := readKeychain(); ok {
		return credential, true
	}
	return readFile()
}
