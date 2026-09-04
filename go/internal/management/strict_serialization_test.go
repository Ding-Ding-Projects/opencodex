package management

import (
	"net/http"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/config"
)

func TestEffortCapsUseTypeScriptOrderAndAdvertisedLadder(t *testing.T) {
	cfg := config.Default()
	api := newParityAPI(t, &cfg)
	get := serveManagement(api, http.MethodGet, "/api/effort-caps", "")
	if want := `{"effortCap":null,"subagentEffortCap":null,"efforts":["low","medium","high","xhigh","max","ultra"]}`; get.Code != http.StatusOK || get.Body.String() != want {
		t.Fatalf("GET effort caps=%d %s", get.Code, get.Body.String())
	}
	put := serveManagement(api, http.MethodPut, "/api/effort-caps", `{"effortCap":"high","subagentEffortCap":"low"}`)
	if want := `{"ok":true,"effortCap":"high","subagentEffortCap":"low"}`; put.Code != http.StatusOK || put.Body.String() != want {
		t.Fatalf("PUT effort caps=%d %s", put.Code, put.Body.String())
	}
}

func TestOAuthAccountHealthUsesTypeScriptOrderAndExpiry(t *testing.T) {
	backend := &oauthBackendStub{providers: []string{"xai"}, accounts: OAuthAccountSet{ActiveAccountID: "acct-1", Accounts: []OAuthAccount{{
		ID: "acct-1", Active: true, ExpiresAt: 1_900_000_000_000,
		Health: OAuthAccountHealth{Status: "healthy"}, HealthLabel: "Healthy", HealthSummary: "xai account-…ct-1: healthy",
	}}}}
	api := newParityAPI(t, &config.Config{}, func(options *Options) { options.OAuth = backend })
	response := serveManagement(api, http.MethodGet, "/api/oauth/accounts?provider=xai", "")
	want := `{"activeAccountId":"acct-1","accounts":[{"id":"acct-1","active":true,"expiresAt":1900000000000,"health":{"status":"healthy"},"healthLabel":"Healthy","healthSummary":"xai account-…ct-1: healthy"}]}`
	if response.Code != http.StatusOK || response.Body.String() != want {
		t.Fatalf("OAuth accounts=%d %s", response.Code, response.Body.String())
	}
}
