package oauth

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

type flowRoundTrip func(*http.Request) (*http.Response, error)

func (fn flowRoundTrip) Do(request *http.Request) (*http.Response, error) { return fn(request) }

func flowResponse(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: http.Header{}}
}

func testJWT(payload string) string {
	return "e30." + base64.RawURLEncoding.EncodeToString([]byte(payload)) + ".sig"
}

func TestCursorFlowPollRefreshAndIdentity(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	access := testJWT(`{"sub":"cursor-user","email":"USER@example.com","exp":1800003600}`)
	polls := 0
	client := flowRoundTrip(func(request *http.Request) (*http.Response, error) {
		switch {
		case strings.Contains(request.URL.Path, "/poll"):
			polls++
			if polls == 1 {
				return flowResponse(http.StatusNotFound, `{}`), nil
			}
			return flowResponse(http.StatusOK, fmt.Sprintf(`{"accessToken":%q,"refreshToken":"refresh"}`, access)), nil
		case strings.Contains(request.URL.Path, "/refresh"):
			if request.Header.Get("Authorization") != "Bearer refresh" {
				t.Fatal("refresh token header missing")
			}
			return flowResponse(http.StatusOK, fmt.Sprintf(`{"accessToken":%q}`, access)), nil
		default:
			return nil, fmt.Errorf("unexpected request: %s", request.URL)
		}
	})
	flow := NewCursorFlow(client)
	flow.PollURL, flow.RefreshURL, flow.Now = "https://cursor.example/poll", "https://cursor.example/refresh", func() time.Time { return now }
	flow.Wait = func(context.Context, time.Duration) error { return nil }
	credential, err := flow.Poll(context.Background(), "uuid", "verifier")
	if err != nil {
		t.Fatal(err)
	}
	if credential.AccountID != "cursor-user" || credential.Email != "user@example.com" || polls != 2 {
		t.Fatalf("unexpected credential: %+v polls=%d", credential, polls)
	}
	refreshed, err := flow.Refresh(context.Background(), "refresh")
	if err != nil {
		t.Fatal(err)
	}
	if refreshed.Refresh != "refresh" || refreshed.AccountID != "cursor-user" {
		t.Fatalf("unexpected refresh: %+v", refreshed)
	}
}

func TestKimiIdentityPrefersUserIDAcrossTokens(t *testing.T) {
	access := testJWT(`{"sub":"weak","email":"ACCESS@EXAMPLE.COM"}`)
	refresh := testJWT(`{"user_id":"strong","email":"refresh@example.com"}`)
	account, email := KimiIdentity(access, refresh)
	if account != "strong" || email != "access@example.com" {
		t.Fatalf("identity = %q %q", account, email)
	}
}

func TestGithubCopilotValidationAndExchange(t *testing.T) {
	if _, err := BuildGithubDeviceVerifyURL("bad code!"); err == nil {
		t.Fatal("unsafe code accepted")
	}
	if got := ResolveCopilotAPIBaseURL("https://evil.example/path"); got != GithubCopilotDefaultAPI {
		t.Fatalf("unsafe API base = %q", got)
	}
	now := time.Unix(1_800_000_000, 0)
	client := flowRoundTrip(func(request *http.Request) (*http.Response, error) {
		switch request.URL.Path {
		case "/copilot":
			if request.Header.Get("Authorization") != "token gho_durable" {
				t.Fatal("durable grant not exchanged")
			}
			return flowResponse(http.StatusOK, `{"token":"copilot","refresh_in":1500,"endpoints":{"api":"https://eastus.githubcopilot.com/path"}}`), nil
		case "/user":
			return flowResponse(http.StatusOK, `{"id":42,"login":"octo","email":"Octo@Example.com"}`), nil
		default:
			return nil, fmt.Errorf("unexpected request: %s", request.URL)
		}
	})
	flow := NewGithubCopilotFlow(client)
	flow.CopilotURL, flow.UserURL, flow.Now = "https://github.example/copilot", "https://github.example/user", func() time.Time { return now }
	credential, err := flow.Refresh(context.Background(), "gho_durable")
	if err != nil {
		t.Fatal(err)
	}
	if credential.Access != "copilot" || credential.Refresh != "gho_durable" || credential.AccountID != "42" || credential.Email != "octo@example.com" {
		t.Fatalf("unexpected credential: %+v", credential)
	}
	if credential.APIBaseURL != "https://eastus.githubcopilot.com" {
		t.Fatalf("API base = %q", credential.APIBaseURL)
	}
}
