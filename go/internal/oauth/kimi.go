package oauth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	KimiOAuthClientID = "17e5f671-d194-4dfb-9706-5516cb48c098"
	KimiOAuthHost     = "https://auth.kimi.com"
)

type KimiFlow struct {
	Client  HTTPDoer
	Host    string
	Headers http.Header
	Now     func() time.Time
	Wait    func(context.Context, time.Duration) error
}

func NewKimiFlow(client HTTPDoer) *KimiFlow {
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	return &KimiFlow{
		Client: client,
		Host:   KimiOAuthHost,
		Headers: http.Header{
			"User-Agent":     {"KimiCLI/0.14.0"},
			"X-Msh-Platform": {"kimi_code_cli"},
			"X-Msh-Version":  {"0.14.0"},
		},
		Now:  time.Now,
		Wait: waitForDevicePoll,
	}
}

func (f *KimiFlow) DeviceFlow() *DeviceFlow {
	host := strings.TrimRight(f.Host, "/")
	return &DeviceFlow{
		Client: f.Client,
		Config: DeviceFlowConfig{
			ClientID: KimiOAuthClientID, DeviceAuthorizationURL: host + "/api/oauth/device_authorization",
			TokenURL: host + "/api/oauth/token", Headers: f.Headers, DefaultExpiresIn: 15 * time.Minute,
			DefaultPollInterval: 5 * time.Second, MinimumPollInterval: time.Second, ExpirySkew: 5 * time.Minute,
			AllowInsecureEndpoints: strings.HasPrefix(host, "http://"), AllowInsecureVerifyURL: strings.HasPrefix(host, "http://"),
		},
		Now:  f.Now,
		Wait: f.Wait,
	}
}

func (f *KimiFlow) Login(ctx context.Context, onAuth func(Authorization)) (OAuthCredentials, error) {
	flow := f.DeviceFlow()
	authorization, err := flow.Start(ctx)
	if err != nil {
		return OAuthCredentials{}, err
	}
	if onAuth != nil {
		onAuth(Authorization{URL: authorization.VerificationURIComplete, Instructions: "Enter code: " + authorization.UserCode})
	}
	credential, err := flow.Poll(ctx, authorization)
	if err != nil {
		return OAuthCredentials{}, err
	}
	return decorateKimiCredential(credential, f.now()), nil
}

func (f *KimiFlow) Refresh(ctx context.Context, refreshToken string) (OAuthCredentials, error) {
	if strings.TrimSpace(refreshToken) == "" {
		return OAuthCredentials{}, errors.New("Kimi refresh token is required")
	}
	endpoint := strings.TrimRight(f.Host, "/") + "/api/oauth/token"
	values := url.Values{"client_id": {KimiOAuthClientID}, "grant_type": {"refresh_token"}, "refresh_token": {refreshToken}}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(values.Encode()))
	if err != nil {
		return OAuthCredentials{}, err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	for name, values := range f.Headers {
		for _, value := range values {
			request.Header.Add(name, value)
		}
	}
	response, err := f.Client.Do(request)
	if err != nil {
		return OAuthCredentials{}, errors.New("Kimi token refresh failed")
	}
	body, err := readOAuthBody(response)
	if err != nil {
		return OAuthCredentials{}, err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return OAuthCredentials{}, fmt.Errorf("Kimi token refresh failed: HTTP %d", response.StatusCode)
	}
	var payload struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int64  `json:"expires_in"`
	}
	if json.Unmarshal(body, &payload) != nil || payload.AccessToken == "" {
		return OAuthCredentials{}, errors.New("Kimi token response missing required fields")
	}
	if payload.RefreshToken == "" {
		payload.RefreshToken = refreshToken
	}
	if payload.ExpiresIn <= 0 {
		payload.ExpiresIn = 3600
	}
	credential := OAuthCredentials{Access: payload.AccessToken, Refresh: payload.RefreshToken, Expires: f.now().Add(time.Duration(payload.ExpiresIn)*time.Second - 5*time.Minute).UnixMilli(), Source: SourceOAuth}
	return decorateKimiCredential(credential, f.now()), nil
}

func KimiIdentity(accessToken, refreshToken string) (accountID, email string) {
	access := decodeJWTClaims(accessToken)
	refresh := decodeJWTClaims(refreshToken)
	for _, name := range []string{"user_id", "sub"} {
		for _, claims := range []map[string]any{access, refresh} {
			if value, ok := claims[name].(string); ok && value != "" {
				accountID = value
				break
			}
		}
		if accountID != "" {
			break
		}
	}
	for _, claims := range []map[string]any{access, refresh} {
		if value, ok := claims["email"].(string); ok && value != "" {
			email = strings.ToLower(value)
			break
		}
	}
	return accountID, email
}

func decorateKimiCredential(credential OAuthCredentials, now time.Time) OAuthCredentials {
	credential.AccountID, credential.Email = KimiIdentity(credential.Access, credential.Refresh)
	credential.Source = SourceOAuth
	if credential.Expires <= 0 {
		credential.Expires = now.Add(time.Hour - 5*time.Minute).UnixMilli()
	}
	return credential
}

func (f *KimiFlow) now() time.Time {
	if f.Now != nil {
		return f.Now()
	}
	return time.Now()
}
