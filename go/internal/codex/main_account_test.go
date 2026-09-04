package codex

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func TestReadMainAccountTokenAndExpiry(t *testing.T) {
	expiry := time.Now().Add(time.Hour).Unix()
	payload := base64.RawURLEncoding.EncodeToString([]byte(`{"exp":` + strconv.FormatInt(expiry, 10) + `}`))
	path := filepath.Join(t.TempDir(), "auth.json")
	if err := os.WriteFile(path, []byte(`{"tokens":{"access_token":"e30.`+payload+`.sig","account_id":"acct"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	token, ok := ReadMainAccountToken(path)
	if !ok || token.ChatGPTAccountID != "acct" || !token.Live(time.Now()) {
		t.Fatalf("token=%#v ok=%v", token, ok)
	}
}

func TestReadMainAccountTokenRejectsMalformed(t *testing.T) {
	path := filepath.Join(t.TempDir(), "auth.json")
	if err := os.WriteFile(path, []byte(`{"tokens":{}} trailing`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, ok := ReadMainAccountToken(path); ok {
		t.Fatal("malformed token accepted")
	}
}
