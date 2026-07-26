package oauth

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestAntigravityExchangeDiscoversProject(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	client := flowRoundTrip(func(request *http.Request) (*http.Response, error) {
		switch {
		case strings.Contains(request.URL.Path, "/token"):
			return flowResponse(200, `{"access_token":"access","refresh_token":"refresh","expires_in":3600}`), nil
		case strings.Contains(request.URL.Path, "loadCodeAssist"):
			return flowResponse(200, `{"cloudaicompanionProject":{"id":"project-1"}}`), nil
		default:
			return nil, fmt.Errorf("unexpected request %s", request.URL)
		}
	})
	flow := NewAntigravityFlow(client)
	flow.AuthURL, flow.TokenURL, flow.ProdAPI, flow.DailyAPI = "https://accounts.example/auth", "https://oauth.example/token", "https://cloud.example", "https://daily.example"
	flow.Now = func() time.Time { return now }
	if _, err := flow.AuthorizationURL(context.Background(), "state", "http://127.0.0.1/callback"); err != nil {
		t.Fatal(err)
	}
	credential, err := flow.Exchange(context.Background(), "code", "state", "http://127.0.0.1/callback")
	if err != nil {
		t.Fatal(err)
	}
	if credential.ProjectID != "project-1" || credential.Refresh != "refresh" {
		t.Fatalf("credential = %+v", credential)
	}
}

func TestKiroImportDiscoversSQLiteCredential(t *testing.T) {
	path := filepath.Join(t.TempDir(), "kiro data.sqlite3")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
		`CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
		`INSERT INTO auth_kv(key,value) VALUES ('kirocli:oidc:device-registration','{"clientId":"client","clientSecret":"client-secret","region":"us-west-2"}')`,
		`INSERT INTO auth_kv(key,value) VALUES ('kirocli:oidc:token','{"accessToken":"access-secret","refreshToken":"refresh-secret","expiresAt":"2030-01-02T03:04:05Z"}')`,
		`INSERT INTO state(key,value) VALUES ('api.codewhisperer.profile','{"arn":"arn:aws:codewhisperer:eu-central-1:1:profile/test"}')`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	flow := NewKiroFlow(nil)
	flow.Env = func(key string) string {
		if key == "KIROCLI_DB_PATH" {
			return path
		}
		return ""
	}
	imported, found, err := flow.Import("")
	if err != nil || !found {
		t.Fatalf("Import() found=%v err=%v", found, err)
	}
	if imported.Access != "access-secret" || imported.Refresh != "refresh-secret" || imported.ClientID != "client" || imported.APIRegion != "eu-central-1" || imported.Source != SourceLocalCLI {
		t.Fatalf("imported metadata mismatch: source=%s auth=%s region=%s", imported.Source, imported.AuthType, imported.APIRegion)
	}
	wantExpiry, _ := time.Parse(time.RFC3339, "2030-01-02T03:04:05Z")
	if imported.Expires != wantExpiry.UnixMilli() {
		t.Fatalf("expires=%d want=%d", imported.Expires, wantExpiry.UnixMilli())
	}
}

func TestKiroImportRejectsAmbiguousSQLiteTokensWithoutLeakingValues(t *testing.T) {
	path := filepath.Join(t.TempDir(), "data.sqlite3")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO auth_kv(key,value) VALUES ('custom:a:token','{"accessToken":"first-secret"}'),('custom:b:token','{"accessToken":"second-secret"}')`); err != nil {
		t.Fatal(err)
	}
	_ = db.Close()
	flow := NewKiroFlow(nil)
	flow.Env = func(key string) string {
		if key == "KIROCLI_DB_PATH" {
			return path
		}
		return ""
	}
	_, found, err := flow.Import("")
	if err == nil || found {
		t.Fatalf("Import() found=%v err=%v", found, err)
	}
	if strings.Contains(err.Error(), "first-secret") || strings.Contains(err.Error(), "second-secret") {
		t.Fatal("ambiguity error leaked token")
	}
}

func TestKiroImportRegionAndRefresh(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	flow := NewKiroFlow(flowRoundTrip(func(request *http.Request) (*http.Response, error) {
		if request.URL.Host != "prod.us-west-2.auth.desktop.kiro.dev" {
			t.Fatalf("host = %s", request.URL.Host)
		}
		return flowResponse(200, `{"accessToken":"fresh","expiresIn":600}`), nil
	}))
	flow.Now = func() time.Time { return now }
	flow.Region = "us-west-2"
	flow.ReadFile = func(string) ([]byte, error) {
		return []byte(`{"accessToken":"old","refreshToken":"durable","profileArn":"arn:aws:codewhisperer:eu-west-1:1:profile/test"}`), nil
	}
	imported, ok, err := flow.Import("credentials.json")
	if err != nil || !ok {
		t.Fatalf("import ok=%v err=%v", ok, err)
	}
	if imported.APIRegion != "eu-west-1" || imported.Source != SourceCredentialFile {
		t.Fatalf("imported = %+v", imported)
	}
	refreshed, err := flow.Refresh(context.Background(), imported)
	if err != nil {
		t.Fatal(err)
	}
	if refreshed.Access != "fresh" || refreshed.Refresh != "durable" {
		t.Fatalf("refreshed = %+v", refreshed)
	}
}
