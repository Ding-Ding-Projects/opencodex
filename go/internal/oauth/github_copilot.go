package oauth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	GithubCopilotOAuthClientID = "Iv1.b507a08c87ecfe98"
	GithubDeviceCodeURL        = "https://github.com/login/device/code"
	GithubAccessTokenURL       = "https://github.com/login/oauth/access_token"
	GithubCopilotTokenURL      = "https://api.github.com/copilot_internal/v2/token"
	GithubUserURL              = "https://api.github.com/user"
	GithubCopilotDefaultAPI    = "https://api.githubcopilot.com"
)

type GithubCopilotFlow struct {
	Client        HTTPDoer
	DeviceCodeURL string
	AccessURL     string
	CopilotURL    string
	UserURL       string
	Now           func() time.Time
	Wait          func(context.Context, time.Duration) error
}

func NewGithubCopilotFlow(client HTTPDoer) *GithubCopilotFlow {
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	return &GithubCopilotFlow{Client: client, DeviceCodeURL: GithubDeviceCodeURL, AccessURL: GithubAccessTokenURL, CopilotURL: GithubCopilotTokenURL, UserURL: GithubUserURL, Now: time.Now, Wait: waitForDevicePoll}
}

func (f *GithubCopilotFlow) DeviceFlow() *DeviceFlow {
	allowInsecure := strings.HasPrefix(f.DeviceCodeURL, "http://") && strings.HasPrefix(f.AccessURL, "http://")
	return &DeviceFlow{Client: f.Client, Config: DeviceFlowConfig{
		ClientID: GithubCopilotOAuthClientID, Scope: "read:user", DeviceAuthorizationURL: f.DeviceCodeURL, TokenURL: f.AccessURL,
		Headers: http.Header{"User-Agent": {"opencodex"}}, DefaultExpiresIn: 15 * time.Minute,
		DefaultPollInterval: 5 * time.Second, MinimumPollInterval: time.Second, AllowInsecureEndpoints: allowInsecure,
		AllowInsecureVerifyURL: allowInsecure,
	}, Now: f.Now, Wait: f.Wait}
}

func (f *GithubCopilotFlow) Login(ctx context.Context, onAuth func(Authorization)) (OAuthCredentials, error) {
	device := f.DeviceFlow()
	authorization, err := device.Start(ctx)
	if err != nil {
		return OAuthCredentials{}, err
	}
	verifyURL, err := BuildGithubDeviceVerifyURL(authorization.UserCode)
	if err != nil {
		return OAuthCredentials{}, err
	}
	if onAuth != nil {
		onAuth(Authorization{URL: verifyURL, Instructions: "Enter code: " + authorization.UserCode})
	}
	github, err := device.Poll(ctx, authorization)
	if err != nil {
		return OAuthCredentials{}, err
	}
	durable := github.Refresh
	if durable == "" {
		durable = github.Access
	}
	return f.credentialsFromGithubAccess(ctx, github.Access, durable)
}

func (f *GithubCopilotFlow) Refresh(ctx context.Context, durableGrant string) (OAuthCredentials, error) {
	if strings.TrimSpace(durableGrant) == "" {
		return OAuthCredentials{}, errors.New("GitHub Copilot durable grant is required")
	}
	githubAccess := durableGrant
	refreshedGrant := durableGrant
	if strings.HasPrefix(durableGrant, "ghr_") {
		values := url.Values{"client_id": {GithubCopilotOAuthClientID}, "grant_type": {"refresh_token"}, "refresh_token": {durableGrant}}
		request, err := http.NewRequestWithContext(ctx, http.MethodPost, f.AccessURL, strings.NewReader(values.Encode()))
		if err != nil {
			return OAuthCredentials{}, err
		}
		request.Header.Set("Accept", "application/json")
		request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		request.Header.Set("User-Agent", "opencodex")
		response, err := f.Client.Do(request)
		if err != nil {
			return OAuthCredentials{}, errors.New("GitHub Copilot token refresh failed")
		}
		body, err := readOAuthBody(response)
		if err != nil {
			return OAuthCredentials{}, err
		}
		var payload struct {
			AccessToken  string `json:"access_token"`
			RefreshToken string `json:"refresh_token"`
			Error        string `json:"error"`
		}
		_ = json.Unmarshal(body, &payload)
		if response.StatusCode < 200 || response.StatusCode >= 300 || payload.AccessToken == "" {
			code := ""
			if payload.Error == "invalid_grant" || payload.Error == "access_denied" || payload.Error == "expired_token" {
				code = ": " + payload.Error
			}
			return OAuthCredentials{}, fmt.Errorf("GitHub Copilot token refresh failed%s (HTTP %d)", code, response.StatusCode)
		}
		githubAccess = payload.AccessToken
		if payload.RefreshToken != "" {
			refreshedGrant = payload.RefreshToken
		}
	}
	return f.credentialsFromGithubAccess(ctx, githubAccess, refreshedGrant)
}

func (f *GithubCopilotFlow) credentialsFromGithubAccess(ctx context.Context, githubAccess, durableGrant string) (OAuthCredentials, error) {
	copilot, err := f.exchangeCopilot(ctx, githubAccess)
	if err != nil {
		return OAuthCredentials{}, err
	}
	accountID, email, err := f.githubIdentity(ctx, githubAccess)
	if err != nil {
		return OAuthCredentials{}, err
	}
	copilot.Refresh, copilot.AccountID, copilot.Email, copilot.Source = durableGrant, accountID, email, SourceOAuth
	return copilot, nil
}

func (f *GithubCopilotFlow) exchangeCopilot(ctx context.Context, access string) (OAuthCredentials, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, f.CopilotURL, nil)
	if err != nil {
		return OAuthCredentials{}, err
	}
	request.Header.Set("Authorization", "token "+access)
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", "opencodex")
	request.Header.Set("Editor-Version", "opencodex/0.1.0")
	request.Header.Set("Editor-Plugin-Version", "opencodex/0.1.0")
	request.Header.Set("Copilot-Integration-Id", "vscode-chat")
	response, err := f.Client.Do(request)
	if err != nil {
		return OAuthCredentials{}, errors.New("GitHub Copilot token exchange failed")
	}
	body, err := readOAuthBody(response)
	if err != nil {
		return OAuthCredentials{}, err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return OAuthCredentials{}, fmt.Errorf("GitHub Copilot token exchange failed (%d)", response.StatusCode)
	}
	var payload struct {
		Token     string `json:"token"`
		ExpiresAt int64  `json:"expires_at"`
		RefreshIn int64  `json:"refresh_in"`
		Endpoints struct {
			API string `json:"api"`
		} `json:"endpoints"`
	}
	if json.Unmarshal(body, &payload) != nil || payload.Token == "" {
		return OAuthCredentials{}, errors.New("GitHub Copilot token exchange missing token")
	}
	expires := f.now().Add(23 * time.Minute).UnixMilli()
	if payload.ExpiresAt > 0 {
		expires = time.Unix(payload.ExpiresAt, 0).Add(-2 * time.Minute).UnixMilli()
	} else if payload.RefreshIn > 0 {
		expires = f.now().Add(time.Duration(payload.RefreshIn)*time.Second - 2*time.Minute).UnixMilli()
	}
	return OAuthCredentials{Access: payload.Token, Expires: expires, APIBaseURL: ResolveCopilotAPIBaseURL(payload.Endpoints.API)}, nil
}

func (f *GithubCopilotFlow) githubIdentity(ctx context.Context, access string) (string, string, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, f.UserURL, nil)
	if err != nil {
		return "", "", err
	}
	request.Header.Set("Authorization", "Bearer "+access)
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("User-Agent", "opencodex")
	response, err := f.Client.Do(request)
	if err != nil {
		return "", "", errors.New("GitHub Copilot identity lookup failed")
	}
	body, err := readOAuthBody(response)
	if err != nil {
		return "", "", err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", "", fmt.Errorf("GitHub Copilot identity lookup failed (%d)", response.StatusCode)
	}
	var payload struct {
		Login string `json:"login"`
		Email string `json:"email"`
		ID    int64  `json:"id"`
	}
	if json.Unmarshal(body, &payload) != nil {
		return "", "", errors.New("GitHub Copilot identity lookup returned invalid JSON")
	}
	accountID := payload.Login
	if payload.ID > 0 {
		accountID = strconv.FormatInt(payload.ID, 10)
	}
	if accountID == "" {
		return "", "", errors.New("could not verify GitHub account identity")
	}
	return accountID, strings.ToLower(payload.Email), nil
}

func BuildGithubDeviceVerifyURL(userCode string) (string, error) {
	code := strings.TrimSpace(userCode)
	if code == "" {
		return "", errors.New("GitHub Copilot device flow returned an invalid user code")
	}
	for _, char := range code {
		if !(char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9' || char == '-') {
			return "", errors.New("GitHub Copilot device flow returned an invalid user code")
		}
	}
	return "https://github.com/login/device?" + url.Values{"user_code": {code}}.Encode(), nil
}

func ValidateCopilotAPIBaseURL(raw string) string {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Scheme != "https" || parsed.User != nil || parsed.Port() != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return ""
	}
	host := strings.ToLower(parsed.Hostname())
	if host != "api.githubcopilot.com" && !strings.HasSuffix(host, ".githubcopilot.com") {
		return ""
	}
	return "https://" + host
}

func ResolveCopilotAPIBaseURL(raw string) string {
	if validated := ValidateCopilotAPIBaseURL(raw); validated != "" {
		return validated
	}
	return GithubCopilotDefaultAPI
}

func (f *GithubCopilotFlow) now() time.Time {
	if f.Now != nil {
		return f.Now()
	}
	return time.Now()
}
