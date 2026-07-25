package oauth

import (
	"context"
	"fmt"
	"net/http"
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
