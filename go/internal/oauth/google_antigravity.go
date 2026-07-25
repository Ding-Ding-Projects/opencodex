package oauth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const (
	AntigravityClientID     = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com"
	AntigravityClientSecret = "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"
	AntigravityAuthURL      = "https://accounts.google.com/o/oauth2/v2/auth"
	AntigravityTokenURL     = "https://oauth2.googleapis.com/token"
	AntigravityProdAPI      = "https://cloudcode-pa.googleapis.com"
	AntigravityDailyAPI     = "https://daily-cloudcode-pa.googleapis.com"
)

type AntigravityFlow struct {
	Client             HTTPDoer
	ClientID           string
	ClientSecret       string
	AuthURL            string
	TokenURL           string
	ProdAPI            string
	DailyAPI           string
	ForceAccountSelect bool
	Now                func() time.Time
	Wait               func(context.Context, time.Duration) error
	mu                 sync.Mutex
	verifier           string
}

func NewAntigravityFlow(client HTTPDoer) *AntigravityFlow {
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	return &AntigravityFlow{Client: client, ClientID: AntigravityClientID, ClientSecret: AntigravityClientSecret, AuthURL: AntigravityAuthURL, TokenURL: AntigravityTokenURL, ProdAPI: AntigravityProdAPI, DailyAPI: AntigravityDailyAPI, Now: time.Now, Wait: waitForDevicePoll}
}

func (f *AntigravityFlow) CallbackOptions() CallbackOptions {
	return CallbackOptions{PreferredPort: 51121, Path: "/callback", CallbackHostname: "127.0.0.1", BindHostname: "127.0.0.1", RedirectURI: "http://127.0.0.1:51121/callback"}
}

func (f *AntigravityFlow) AuthorizationURL(_ context.Context, state, redirectURI string) (Authorization, error) {
	pkce, err := GeneratePKCE()
	if err != nil {
		return Authorization{}, err
	}
	f.mu.Lock()
	f.verifier = pkce.Verifier
	f.mu.Unlock()
	prompt := "consent"
	if f.ForceAccountSelect {
		prompt = "consent select_account"
	}
	values := url.Values{
		"response_type": {"code"}, "client_id": {f.ClientID}, "redirect_uri": {redirectURI},
		"scope":          {strings.Join([]string{"https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/userinfo.profile", "https://www.googleapis.com/auth/cclog", "https://www.googleapis.com/auth/experimentsandconfigs"}, " ")},
		"code_challenge": {pkce.Challenge}, "code_challenge_method": {"S256"}, "access_type": {"offline"}, "prompt": {prompt}, "state": {state},
	}
	return Authorization{URL: f.AuthURL + "?" + values.Encode(), Instructions: "Complete Google (Antigravity) login in your browser."}, nil
}

func (f *AntigravityFlow) Exchange(ctx context.Context, code, _ string, redirectURI string) (OAuthCredentials, error) {
	f.mu.Lock()
	verifier := f.verifier
	f.mu.Unlock()
	if verifier == "" {
		return OAuthCredentials{}, errors.New("Antigravity OAuth PKCE verifier was not initialized")
	}
	credential, err := f.postToken(ctx, url.Values{"grant_type": {"authorization_code"}, "client_id": {f.ClientID}, "client_secret": {f.ClientSecret}, "code": {code}, "redirect_uri": {redirectURI}, "code_verifier": {verifier}}, "")
	if err != nil {
		return OAuthCredentials{}, err
	}
	project, err := f.DiscoverProject(ctx, credential.Access)
	if err != nil || project == "" {
		return OAuthCredentials{}, errors.New("Antigravity login could not discover a Cloud Code Assist project")
	}
	credential.ProjectID = project
	return credential, nil
}

func (f *AntigravityFlow) Refresh(ctx context.Context, refreshToken string) (OAuthCredentials, error) {
	if refreshToken == "" {
		return OAuthCredentials{}, errors.New("Antigravity refresh token is required")
	}
	credential, err := f.postToken(ctx, url.Values{"grant_type": {"refresh_token"}, "client_id": {f.ClientID}, "client_secret": {f.ClientSecret}, "refresh_token": {refreshToken}}, refreshToken)
	if err != nil {
		return OAuthCredentials{}, err
	}
	if project, _ := f.DiscoverProject(ctx, credential.Access); project != "" {
		credential.ProjectID = project
	}
	return credential, nil
}

func (f *AntigravityFlow) postToken(ctx context.Context, values url.Values, refreshFallback string) (OAuthCredentials, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, f.TokenURL, strings.NewReader(values.Encode()))
	if err != nil {
		return OAuthCredentials{}, err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response, err := f.Client.Do(request)
	if err != nil {
		return OAuthCredentials{}, errors.New("Antigravity token request failed")
	}
	body, err := readOAuthBody(response)
	if err != nil {
		return OAuthCredentials{}, err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return OAuthCredentials{}, fmt.Errorf("Antigravity token request failed: HTTP %d", response.StatusCode)
	}
	var payload struct {
		Access, Refresh string
		Expires         int64
		IDToken         string
	}
	var wire struct {
		Access  string `json:"access_token"`
		Refresh string `json:"refresh_token"`
		Expires int64  `json:"expires_in"`
		IDToken string `json:"id_token"`
	}
	if json.Unmarshal(body, &wire) != nil || wire.Access == "" {
		return OAuthCredentials{}, errors.New("Antigravity token response did not include an access token")
	}
	payload.Access, payload.Refresh, payload.Expires, payload.IDToken = wire.Access, wire.Refresh, wire.Expires, wire.IDToken
	if payload.Refresh == "" {
		payload.Refresh = refreshFallback
	}
	if payload.Refresh == "" {
		return OAuthCredentials{}, errors.New("Antigravity token response did not include a refresh token")
	}
	if payload.Expires <= 0 {
		payload.Expires = 3600
	}
	claims := decodeJWTClaims(payload.IDToken)
	if len(claims) == 0 {
		claims = decodeJWTClaims(payload.Access)
	}
	email, _ := claims["email"].(string)
	return OAuthCredentials{Access: payload.Access, Refresh: payload.Refresh, Expires: f.now().Add(time.Duration(payload.Expires)*time.Second - 50*time.Minute).UnixMilli(), Email: strings.ToLower(email), Source: SourceOAuth}, nil
}

func (f *AntigravityFlow) DiscoverProject(ctx context.Context, accessToken string) (string, error) {
	if project := f.projectRequest(ctx, strings.TrimRight(f.ProdAPI, "/")+"/v1internal:loadCodeAssist", accessToken, map[string]any{"metadata": map[string]any{"ideType": "ANTIGRAVITY"}}); project != "" {
		return project, nil
	}
	for attempt := 0; attempt < 5; attempt++ {
		project, retry, err := f.onboardRequest(ctx, accessToken)
		if err != nil {
			return "", err
		}
		if project != "" {
			return project, nil
		}
		if !retry {
			break
		}
		if err := f.wait(ctx, 2*time.Second); err != nil {
			return "", err
		}
	}
	return "", errors.New("Cloud Code Assist project is unavailable")
}

func (f *AntigravityFlow) projectRequest(ctx context.Context, endpoint, token string, payload map[string]any) string {
	body, _ := json.Marshal(payload)
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(string(body)))
	if err != nil {
		return ""
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", "antigravity/opencodex")
	response, err := f.Client.Do(request)
	if err != nil {
		return ""
	}
	data, err := readOAuthBody(response)
	if err != nil || response.StatusCode < 200 || response.StatusCode >= 300 {
		return ""
	}
	var document map[string]any
	if json.Unmarshal(data, &document) != nil {
		return ""
	}
	return extractAntigravityProject(document)
}

func (f *AntigravityFlow) onboardRequest(ctx context.Context, token string) (string, bool, error) {
	endpoint := strings.TrimRight(f.DailyAPI, "/") + "/v1internal:onboardUser"
	body, _ := json.Marshal(map[string]any{"tier_id": "free-tier", "metadata": map[string]any{"ide_type": "ANTIGRAVITY", "ide_name": "antigravity"}})
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(string(body)))
	if err != nil {
		return "", false, err
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", "antigravity/opencodex")
	response, err := f.Client.Do(request)
	if err != nil {
		return "", true, nil
	}
	data, readErr := readOAuthBody(response)
	if readErr != nil {
		return "", false, readErr
	}
	if response.StatusCode == 429 || response.StatusCode >= 500 {
		return "", true, nil
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", false, nil
	}
	var document map[string]any
	if json.Unmarshal(data, &document) != nil {
		return "", true, nil
	}
	if document["done"] != true {
		return "", true, nil
	}
	responseDocument, _ := document["response"].(map[string]any)
	return extractAntigravityProject(responseDocument), false, nil
}

func extractAntigravityProject(document map[string]any) string {
	for _, key := range []string{"cloudaicompanionProject", "projectId", "project"} {
		if value, ok := document[key].(string); ok && value != "" {
			return value
		}
		if row, ok := document[key].(map[string]any); ok {
			if value, ok := row["id"].(string); ok {
				return value
			}
		}
	}
	return ""
}
func (f *AntigravityFlow) now() time.Time {
	if f.Now != nil {
		return f.Now()
	}
	return time.Now()
}
func (f *AntigravityFlow) wait(ctx context.Context, delay time.Duration) error {
	if f.Wait != nil {
		return f.Wait(ctx, delay)
	}
	return waitForDevicePoll(ctx, delay)
}
