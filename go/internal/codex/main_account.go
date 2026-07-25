package codex

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"strings"
	"time"
)

const maxCodexAuthBytes = 2 << 20

// ReadMainAccountToken reads the Codex CLI credential without importing or
// refreshing it. Malformed and missing files are treated as logged out.
func ReadMainAccountToken(path string) (MainAccountToken, bool) {
	file, err := os.Open(path)
	if err != nil {
		return MainAccountToken{}, false
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || info.Size() > maxCodexAuthBytes {
		return MainAccountToken{}, false
	}
	var document struct {
		Tokens struct {
			AccessToken string `json:"access_token"`
			AccountID   string `json:"account_id"`
		} `json:"tokens"`
	}
	decoder := json.NewDecoder(file)
	if err := decoder.Decode(&document); err != nil || decoder.Decode(&struct{}{}) != io.EOF {
		return MainAccountToken{}, false
	}
	access := strings.TrimSpace(document.Tokens.AccessToken)
	if access == "" {
		return MainAccountToken{}, false
	}
	return MainAccountToken{AccessToken: access, ChatGPTAccountID: strings.TrimSpace(document.Tokens.AccountID), ExpiresAt: jwtExpiry(access)}, true
}

func jwtExpiry(token string) time.Time {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return time.Time{}
	}
	payload, err := decodeJWTPart(parts[1])
	if err != nil {
		return time.Time{}
	}
	var claims struct {
		Exp json.Number `json:"exp"`
	}
	decoder := json.NewDecoder(strings.NewReader(string(payload)))
	decoder.UseNumber()
	if decoder.Decode(&claims) != nil || claims.Exp == "" {
		return time.Time{}
	}
	seconds, err := claims.Exp.Int64()
	if err != nil || seconds <= 0 {
		return time.Time{}
	}
	return time.Unix(seconds, 0)
}

func decodeJWTPart(part string) ([]byte, error) {
	for len(part)%4 != 0 {
		part += "="
	}
	decoded, err := jwtBase64Decode(part)
	if err != nil {
		return nil, errors.New("invalid JWT payload")
	}
	return decoded, nil
}
