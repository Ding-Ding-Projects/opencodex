package oauth

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

type xaiRoundTrip func(*http.Request) (*http.Response, error)

func (fn xaiRoundTrip) Do(request *http.Request) (*http.Response, error) { return fn(request) }

func TestXAIFlowDiscoveryAuthorizationAndRefresh(t *testing.T) {
	requests := 0
	client := xaiRoundTrip(func(request *http.Request) (*http.Response, error) {
		requests++
		if request.Method == http.MethodGet {
			return xaiResponse(200, `{"authorization_endpoint":"https://auth.x.ai/authorize","token_endpoint":"https://auth.x.ai/token"}`), nil
		}
		body, _ := io.ReadAll(request.Body)
		if !strings.Contains(string(body), "grant_type=refresh_token") {
			t.Fatalf("token body = %q", body)
		}
		token := jwtForXAITest(map[string]any{"sub": "account-1", "email": "USER@EXAMPLE.COM"})
		return xaiResponse(200, `{"access_token":"`+token+`","refresh_token":"next","expires_in":3600}`), nil
	})
	flow := NewXAIFlow(client)
	flow.now = func() time.Time { return time.Unix(1_700_000_000, 0) }
	auth, err := flow.AuthorizationURL(context.Background(), "state", flow.CallbackOptions().RedirectURI)
	if err != nil || !strings.Contains(auth.URL, "code_challenge=") || !strings.Contains(auth.URL, "state=state") {
		t.Fatalf("auth=%#v err=%v", auth, err)
	}
	credential, err := flow.Refresh(context.Background(), "old")
	if err != nil {
		t.Fatal(err)
	}
	if credential.AccountID != "account-1" || credential.Email != "user@example.com" || credential.Refresh != "next" {
		t.Fatalf("credential = %#v", credential)
	}
	if requests != 3 {
		t.Fatalf("requests = %d", requests)
	}
}

func TestXAIFlowRejectsDiscoveryHostAndRedactsTokenError(t *testing.T) {
	flow := NewXAIFlow(xaiRoundTrip(func(*http.Request) (*http.Response, error) {
		return xaiResponse(200, `{"authorization_endpoint":"https://evil.test/authorize","token_endpoint":"https://auth.x.ai/token"}`), nil
	}))
	if _, err := flow.Discover(context.Background()); err == nil {
		t.Fatal("expected endpoint rejection")
	}
	err := safeXAITokenError(400, []byte(`{"error":"invalid_grant","error_description":"refresh-secret"}`))
	if strings.Contains(err.Error(), "refresh-secret") || !strings.Contains(err.Error(), "invalid_grant") {
		t.Fatalf("unsafe error = %q", err)
	}
}

func xaiResponse(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}
}

func jwtForXAITest(claims map[string]any) string {
	payload, _ := json.Marshal(claims)
	return "e30." + base64.RawURLEncoding.EncodeToString(payload) + ".sig"
}
