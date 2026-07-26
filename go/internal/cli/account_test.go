package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/oauth"
)

func TestAccountListCurrentUseAndConfirmedRemove(t *testing.T) {
	home := t.TempDir()
	t.Setenv("OPENCODEX_HOME", home)
	store := oauth.NewCredentialStore(filepath.Join(home, "auth.json"))
	ctx := context.Background()
	for _, credential := range []oauth.OAuthCredentials{
		{Access: "one", Refresh: "refresh-one", Expires: time.Now().Add(time.Hour).UnixMilli(), Email: "one@example.test", Source: oauth.SourceOAuth},
		{Access: "two", Refresh: "refresh-two", Expires: time.Now().Add(time.Hour).UnixMilli(), Email: "two@example.test", Source: oauth.SourceOAuth},
	} {
		if err := store.SaveCredential(ctx, "kimi", credential); err != nil {
			t.Fatal(err)
		}
	}
	set, ok, err := store.GetAccountSet("kimi")
	if err != nil || !ok || len(set.Accounts) != 2 {
		t.Fatalf("account set = %#v, %v, %v", set, ok, err)
	}
	firstID := set.Accounts[0].ID

	var list bytes.Buffer
	if err := accountList(store, []string{"kimi", "--json"}, IO{Out: &list, Err: &list}); err != nil {
		t.Fatal(err)
	}
	var payload struct {
		Accounts []accountRow `json:"accounts"`
	}
	if err := json.Unmarshal(list.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Accounts) != 2 || payload.Accounts[0].Email != "one@example.test" {
		t.Fatalf("list payload = %#v", payload)
	}

	var use bytes.Buffer
	if err := accountUse(ctx, store, []string{"kimi", firstID, "--json"}, IO{Out: &use, Err: &use}); err != nil {
		t.Fatal(err)
	}
	if err := accountCurrent(store, []string{"kimi", "--json"}, IO{Out: &use, Err: &use}); err != nil {
		t.Fatal(err)
	}
	updated, _, _ := store.GetAccountSet("kimi")
	if updated.ActiveAccountID != firstID {
		t.Fatalf("active id = %q, want %q", updated.ActiveAccountID, firstID)
	}

	if err := accountRemove(ctx, store, []string{"kimi", firstID}, IO{Out: &use, Err: &use}); err == nil {
		t.Fatal("remove without --yes succeeded")
	}
	if err := accountRemove(ctx, store, []string{"kimi", firstID, "--yes"}, IO{Out: &use, Err: &use}); err != nil {
		t.Fatal(err)
	}
	remaining, _, _ := store.GetAccountSet("kimi")
	if len(remaining.Accounts) != 1 || remaining.Accounts[0].ID == firstID {
		t.Fatalf("remaining set = %#v", remaining)
	}
}

func TestAccountAutoSwitchPersistsValidatedThreshold(t *testing.T) {
	home := t.TempDir()
	t.Setenv("OPENCODEX_HOME", home)
	cfg := config.Default()
	cfg.DefaultProvider = "openai"
	cfg.Providers["openai"] = config.ProviderConfig{Adapter: "openai-responses", BaseURL: "https://chatgpt.com/backend-api/codex", AuthMode: "forward", CodexAccountMode: "pool"}
	if err := config.Save(filepath.Join(home, "config.json"), &cfg); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err := accountAutoSwitch([]string{"openai", "threshold", "65", "--json"}, IO{Out: &output, Err: &output}); err != nil {
		t.Fatal(err)
	}
	loaded, err := config.Load(filepath.Join(home, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	if loaded.AutoSwitchThreshold != 65 {
		t.Fatalf("threshold = %d", loaded.AutoSwitchThreshold)
	}
	if err := accountAutoSwitch([]string{"openai", "threshold", "101"}, IO{Out: &output, Err: &output}); err == nil {
		t.Fatal("out-of-range threshold succeeded")
	}
}

func TestAccountAPIKeyPoolCRUDNeverPrintsSecret(t *testing.T) {
	home := t.TempDir()
	t.Setenv("OPENCODEX_HOME", home)
	cfg := config.Default()
	cfg.DefaultProvider = "test"
	cfg.Providers["test"] = config.ProviderConfig{Adapter: "openai-chat", BaseURL: "https://example.test/v1", APIKey: "legacy-secret-value"}
	if err := config.Save(filepath.Join(home, "config.json"), &cfg); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	streams := IO{In: bytes.NewBufferString("second-secret-value\n"), Out: &output, Err: &output}
	if err := accountAddKey([]string{"test", "--label", "backup", "--json"}, streams); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(output.Bytes(), []byte("second-secret-value")) {
		t.Fatal("add-key output leaked secret")
	}
	loaded, err := config.Load(filepath.Join(home, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	activeID, keys := config.ListAPIKeys(loaded, "test")
	if len(keys) != 2 || activeID == "" {
		t.Fatalf("keys=%#v active=%q", keys, activeID)
	}
	output.Reset()
	if err := accountAlias(context.Background(), oauth.NewCredentialStore(filepath.Join(home, "auth.json")), []string{"test", activeID, "renamed"}, streams); err != nil {
		t.Fatal(err)
	}
	if err := accountKeyUse("test", keys[0].ID, false, streams); err != nil {
		t.Fatal(err)
	}
	if err := accountKeyRemove("test", keys[0].ID, true, streams); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(output.String(), "legacy-secret-value") || strings.Contains(output.String(), "second-secret-value") {
		t.Fatal("key CRUD output leaked secret")
	}
}

func TestAccountAliasPersistsInOAuthStore(t *testing.T) {
	home := t.TempDir()
	t.Setenv("OPENCODEX_HOME", home)
	store := oauth.NewCredentialStore(filepath.Join(home, "auth.json"))
	credential := oauth.OAuthCredentials{Access: "secret", Refresh: "refresh", Expires: time.Now().Add(time.Hour).UnixMilli(), Email: "alias@example.test"}
	if err := store.SaveCredential(context.Background(), "kimi", credential); err != nil {
		t.Fatal(err)
	}
	set, _, _ := store.GetAccountSet("kimi")
	var output bytes.Buffer
	if err := accountAlias(context.Background(), store, []string{"kimi", set.Accounts[0].ID, "Work"}, IO{Out: &output}); err != nil {
		t.Fatal(err)
	}
	set, _, _ = store.GetAccountSet("kimi")
	if set.Accounts[0].Alias != "Work" {
		t.Fatalf("alias = %q", set.Accounts[0].Alias)
	}
}
