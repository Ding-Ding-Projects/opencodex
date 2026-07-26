package cli

import (
	"context"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/oauth"
)

type cursorDiscoveryRoundTrip func(*http.Request) (*http.Response, error)

func (fn cursorDiscoveryRoundTrip) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}

func TestConfiguredCursorDiscoveryUsesStoredCredentialAndPopulatesCatalog(t *testing.T) {
	store := oauth.NewCredentialStore(filepath.Join(t.TempDir(), "auth.json"))
	credential := oauth.OAuthCredentials{Access: "cursor-secret", Refresh: "refresh", Expires: time.Now().Add(time.Hour).UnixMilli()}
	if err := store.SaveCredential(context.Background(), "cursor", credential); err != nil {
		t.Fatal(err)
	}
	cfg := config.Default()
	cfg.Providers["cursor"] = config.ProviderConfig{Adapter: "cursor", BaseURL: "https://cursor.example", AuthMode: "oauth"}
	payload := cursorModelsPayload("model-b", "model-a")
	client := &http.Client{Transport: cursorDiscoveryRoundTrip(func(request *http.Request) (*http.Response, error) {
		if request.URL.Path != "/agent.v1.AgentService/GetUsableModels" {
			t.Fatalf("path = %s", request.URL.Path)
		}
		if request.Header.Get("Authorization") != "Bearer cursor-secret" {
			t.Fatalf("authorization = %q", request.Header.Get("Authorization"))
		}
		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(string(payload)))}, nil
	})}
	models, err := discoverConfiguredCursorModels(context.Background(), cfg, store, client)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(models, ",") != "model-a,model-b" {
		t.Fatalf("models = %#v", models)
	}
	rows := configuredRegistryWithCursorModels(cfg, models).ListModels()
	var cursorRows []string
	for _, row := range rows {
		if row.Provider == "cursor" {
			cursorRows = append(cursorRows, row.ID)
		}
	}
	if strings.Join(cursorRows, ",") != "cursor/auto,cursor/model-a,cursor/model-b" {
		t.Fatalf("cursor catalog rows = %#v", cursorRows)
	}
}

func TestConfiguredCursorDiscoverySkipsWithoutCredentialOrWhenDisabled(t *testing.T) {
	cfg := config.Default()
	cfg.Providers["cursor"] = config.ProviderConfig{Adapter: "cursor", BaseURL: "https://cursor.example", Disabled: true}
	called := false
	client := &http.Client{Transport: cursorDiscoveryRoundTrip(func(*http.Request) (*http.Response, error) { called = true; return nil, nil })}
	models, err := discoverConfiguredCursorModels(context.Background(), cfg, nil, client)
	if err != nil || len(models) != 0 || called {
		t.Fatalf("models=%#v called=%v err=%v", models, called, err)
	}
	cfg.Providers["cursor"] = config.ProviderConfig{Adapter: "cursor", BaseURL: "https://cursor.example"}
	models, err = discoverConfiguredCursorModels(context.Background(), cfg, nil, client)
	if err != nil || len(models) != 0 || called {
		t.Fatalf("credential-less discovery models=%#v called=%v err=%v", models, called, err)
	}
}

func cursorModelsPayload(ids ...string) []byte {
	var out []byte
	for _, id := range ids {
		inner := append([]byte{0x0a, byte(len(id))}, []byte(id)...)
		out = append(out, 0x0a, byte(len(inner)))
		out = append(out, inner...)
	}
	return out
}
