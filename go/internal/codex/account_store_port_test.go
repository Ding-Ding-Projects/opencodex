package codex

import (
	"context"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestAccountStoreLegacyGenerationAndTombstone(t *testing.T) {
	path := filepath.Join(t.TempDir(), "codex-accounts.json")
	legacy := `{"legacy":{"accessToken":"a","refreshToken":"r","expiresAt":123,"chatgptAccountId":"c"}}`
	if err := os.WriteFile(path, []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	store := NewAccountStore(path)
	record, ok, err := store.ReadRecord("legacy")
	if err != nil || !ok || record.Generation != 0 || record.Credential == nil {
		t.Fatalf("legacy record = %#v, %v, %v", record, ok, err)
	}
	if record.RefreshGrantFingerprint != RefreshGrantFingerprint("r") {
		t.Fatalf("missing normalized refresh fingerprint")
	}

	updated := AccountCredentials{"a2", "r", 456, "c"}
	if err := store.SaveCredential("legacy", updated); err != nil {
		t.Fatal(err)
	}
	record, ok, err = store.ReadRecord("legacy")
	if err != nil || !ok || record.Generation != 1 || record.ReplacedAt == nil {
		t.Fatalf("saved record = %#v, %v, %v", record, ok, err)
	}
	saved, err := store.SaveCredentialIfGeneration("legacy", 0, updated)
	if err != nil || saved {
		t.Fatalf("stale CAS = %v, %v", saved, err)
	}
	generation, err := store.Tombstone("legacy")
	if err != nil || generation != 2 || store.IsGenerationLive("legacy", 1) {
		t.Fatalf("tombstone = %d, %v", generation, err)
	}
	ids, err := store.ListAccountIDs()
	if err != nil || len(ids) != 0 {
		t.Fatalf("live ids = %v, %v", ids, err)
	}
}

func TestAccountStoreValidationMetadataSurvivesReplacement(t *testing.T) {
	store := NewAccountStore(filepath.Join(t.TempDir(), "codex-accounts.json"))
	first := AccountCredentials{"a", "r", 1, "c"}
	if err := store.SaveCredential("id", first); err != nil {
		t.Fatal(err)
	}
	at := time.UnixMilli(1234)
	if err := store.MarkValidated("id", at); err != nil {
		t.Fatal(err)
	}
	if err := store.MarkValidationFailed("id", "upstream rejected"); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveCredential("id", AccountCredentials{"b", "r2", 2, "c"}); err != nil {
		t.Fatal(err)
	}
	record, _, err := store.ReadRecord("id")
	if err != nil || record.LastCodexValidatedAt == nil || *record.LastCodexValidatedAt != 1234 ||
		record.LastCodexValidationStatus != AccountValidationFailed || record.LastCodexValidationError != "upstream rejected" {
		t.Fatalf("metadata not preserved: %#v, %v", record, err)
	}
}

func TestAccountStoreInvalidJSONIsBackedUp(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "codex-accounts.json")
	if err := os.WriteFile(path, []byte("{broken"), 0o600); err != nil {
		t.Fatal(err)
	}
	store := NewAccountStore(path)
	store.now = func() time.Time { return time.UnixMilli(99) }
	credentials, err := store.Load()
	if err != nil || len(credentials) != 0 {
		t.Fatalf("load invalid = %v, %v", credentials, err)
	}
	if _, err := os.Stat(path + ".invalid-99"); err != nil {
		t.Fatalf("invalid backup missing: %v", err)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) { return fn(request) }

func TestAccountStoreRefreshesAndPersistsToken(t *testing.T) {
	store := NewAccountStore(filepath.Join(t.TempDir(), "codex-accounts.json"))
	now := time.Unix(1_700_000_000, 0)
	store.now = func() time.Time { return now }
	if err := store.SaveCredential("id", AccountCredentials{"old", "refresh", 0, "acct"}); err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		body, _ := io.ReadAll(request.Body)
		if request.URL.String() != chatGPTTokenURL || !strings.Contains(string(body), "refresh_token=refresh") {
			t.Fatalf("unexpected refresh request: %s %s", request.URL, body)
		}
		return &http.Response{
			StatusCode: 200,
			Body:       io.NopCloser(strings.NewReader(`{"access_token":"new","refresh_token":"rotated","expires_in":3600}`)),
			Header:     make(http.Header),
		}, nil
	})}
	token, err := store.GetValidToken(context.Background(), "id", client)
	if err != nil || token.AccessToken != "new" || token.Generation != 2 {
		t.Fatalf("token = %#v, %v", token, err)
	}
	record, _, _ := store.ReadRecord("id")
	if record.Credential == nil || record.Credential.RefreshToken != "rotated" || record.Credential.ExpiresAt != now.UnixMilli()+3_600_000 {
		t.Fatalf("persisted refresh = %#v", record)
	}
}

func TestAccountStoreAdoptsFreshCredentialSharingGrant(t *testing.T) {
	store := NewAccountStore(filepath.Join(t.TempDir(), "codex-accounts.json"))
	now := time.Unix(1_700_000_000, 0)
	store.now = func() time.Time { return now }
	if err := store.SaveCredential("a", AccountCredentials{"old-a", "shared", 0, "acct"}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveCredential("b", AccountCredentials{"fresh", "shared", now.Add(time.Hour).UnixMilli(), "acct"}); err != nil {
		t.Fatal(err)
	}
	token, err := store.GetValidToken(context.Background(), "a", &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		t.Fatal("network refresh should not run")
		return nil, nil
	})})
	if err != nil || token.AccessToken != "fresh" || token.Generation != 2 {
		t.Fatalf("adopted token = %#v, %v", token, err)
	}
}
