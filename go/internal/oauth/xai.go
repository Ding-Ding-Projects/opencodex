package oauth

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	XAIOAuthDiscoveryURL = "https://auth.x.ai/.well-known/openid-configuration"
	XAIOAuthClientID     = "b1a00492-073a-47ea-816f-4c329264a828"
	XAIOAuthScope        = "openid profile email offline_access grok-cli:access api:access"
	xaiRefreshSkew       = 2 * time.Minute
	maxXAITokenBytes     = 1 << 20
)

type XAIDiscovery struct {
	AuthorizationEndpoint string
	TokenEndpoint         string
}

type XAIFlow struct {
	Client       HTTPDoer
	DiscoveryURL string

	mu        sync.Mutex
	verifier  string
	discovery XAIDiscovery
	now       func() time.Time
	sleep     func(context.Context, time.Duration) error
}

func NewXAIFlow(client HTTPDoer) *XAIFlow {
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	return &XAIFlow{Client: client, DiscoveryURL: XAIOAuthDiscoveryURL, now: time.Now, sleep: waitForDevicePoll}
}

func (f *XAIFlow) CallbackOptions() CallbackOptions {
	return CallbackOptions{PreferredPort: 56121, Path: "/callback", CallbackHostname: "127.0.0.1", BindHostname: "127.0.0.1", RedirectURI: "http://127.0.0.1:56121/callback"}
}

func (f *XAIFlow) AuthorizationURL(ctx context.Context, state, redirectURI string) (Authorization, error) {
	pkce, err := GeneratePKCE()
	if err != nil {
		return Authorization{}, err
	}
	discovery, err := f.Discover(ctx)
	if err != nil {
		return Authorization{}, err
	}
	nonce, err := randomXAINonce()
	if err != nil {
		return Authorization{}, err
	}
	f.mu.Lock()
	f.verifier, f.discovery = pkce.Verifier, discovery
	f.mu.Unlock()
	parameters := url.Values{
		"response_type":         {"code"},
		"client_id":             {XAIOAuthClientID},
		"redirect_uri":          {redirectURI},
		"scope":                 {XAIOAuthScope},
		"code_challenge":        {pkce.Challenge},
		"code_challenge_method": {"S256"},
		"state":                 {state},
		"nonce":                 {nonce},
	}
	return Authorization{URL: discovery.AuthorizationEndpoint + "?" + parameters.Encode(), Instructions: "Complete xAI/Grok login in your browser."}, nil
}

func (f *XAIFlow) Exchange(ctx context.Context, code, _ string, redirectURI string) (OAuthCredentials, error) {
	f.mu.Lock()
	verifier, discovery := f.verifier, f.discovery
	f.mu.Unlock()
	if verifier == "" {
		return OAuthCredentials{}, errors.New("xAI OAuth PKCE verifier was not initialized")
	}
	if discovery.TokenEndpoint == "" {
		var err error
		discovery, err = f.Discover(ctx)
		if err != nil {
			return OAuthCredentials{}, err
		}
	}
	return f.postToken(ctx, discovery.TokenEndpoint, url.Values{
		"grant_type": {"authorization_code"}, "client_id": {XAIOAuthClientID}, "code": {code},
		"redirect_uri": {redirectURI}, "code_verifier": {verifier},
	}, "")
}

func (f *XAIFlow) Refresh(ctx context.Context, refreshToken string) (OAuthCredentials, error) {
	if strings.TrimSpace(refreshToken) == "" {
		return OAuthCredentials{}, errors.New("xAI credentials do not include a refresh token")
	}
	discovery, err := f.Discover(ctx)
	if err != nil {
		return OAuthCredentials{}, err
	}
	return f.postToken(ctx, discovery.TokenEndpoint, url.Values{
		"grant_type": {"refresh_token"}, "client_id": {XAIOAuthClientID}, "refresh_token": {refreshToken},
	}, refreshToken)
}

func (f *XAIFlow) Discover(ctx context.Context) (XAIDiscovery, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, f.DiscoveryURL, nil)
	if err != nil {
		return XAIDiscovery{}, err
	}
	req.Header.Set("Accept", "application/json")
	response, err := f.Client.Do(req)
	if err != nil {
		return XAIDiscovery{}, fmt.Errorf("xAI OAuth discovery: %w", err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, maxXAITokenBytes+1))
	if err != nil || len(body) > maxXAITokenBytes {
		return XAIDiscovery{}, errors.New("xAI OAuth discovery response is invalid")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return XAIDiscovery{}, fmt.Errorf("xAI OAuth discovery failed: HTTP %d", response.StatusCode)
	}
	var payload struct {
		AuthorizationEndpoint string `json:"authorization_endpoint"`
		TokenEndpoint         string `json:"token_endpoint"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return XAIDiscovery{}, errors.New("xAI OAuth discovery returned invalid JSON")
	}
	authorizationEndpoint, err := validateXAIEndpoint(payload.AuthorizationEndpoint)
	if err != nil {
		return XAIDiscovery{}, err
	}
	tokenEndpoint, err := validateXAIEndpoint(payload.TokenEndpoint)
	if err != nil {
		return XAIDiscovery{}, err
	}
	return XAIDiscovery{AuthorizationEndpoint: authorizationEndpoint, TokenEndpoint: tokenEndpoint}, nil
}

func (f *XAIFlow) postToken(ctx context.Context, endpoint string, values url.Values, refreshFallback string) (OAuthCredentials, error) {
	var last error
	for attempt := 1; attempt <= 3; attempt++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(values.Encode()))
		if err != nil {
			return OAuthCredentials{}, err
		}
		req.Header.Set("Accept", "application/json")
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		response, err := f.Client.Do(req)
		if err != nil {
			last = errors.New("xAI token request failed: network error")
			if attempt < 3 {
				if waitErr := f.sleep(ctx, time.Duration(attempt)*100*time.Millisecond); waitErr != nil {
					return OAuthCredentials{}, waitErr
				}
				continue
			}
			return OAuthCredentials{}, last
		}
		body, readErr := io.ReadAll(io.LimitReader(response.Body, maxXAITokenBytes+1))
		_ = response.Body.Close()
		if readErr != nil || len(body) > maxXAITokenBytes {
			return OAuthCredentials{}, errors.New("xAI token response is invalid")
		}
		if response.StatusCode >= 200 && response.StatusCode < 300 {
			return f.credentialsFromToken(body, refreshFallback)
		}
		last = safeXAITokenError(response.StatusCode, body)
		if attempt == 3 || (response.StatusCode != http.StatusTooManyRequests && response.StatusCode < 500) {
			return OAuthCredentials{}, last
		}
		delay := time.Duration(attempt) * 100 * time.Millisecond
		if seconds, err := strconv.Atoi(response.Header.Get("Retry-After")); err == nil && seconds > 0 {
			delay = min(time.Duration(seconds)*time.Second, 2*time.Second)
		}
		if err := f.sleep(ctx, delay); err != nil {
			return OAuthCredentials{}, err
		}
	}
	return OAuthCredentials{}, last
}

func (f *XAIFlow) credentialsFromToken(body []byte, refreshFallback string) (OAuthCredentials, error) {
	var payload struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int64  `json:"expires_in"`
		IDToken      string `json:"id_token"`
	}
	if err := json.Unmarshal(body, &payload); err != nil || payload.AccessToken == "" {
		return OAuthCredentials{}, errors.New("xAI token response did not include an access token")
	}
	if payload.RefreshToken == "" {
		payload.RefreshToken = refreshFallback
	}
	if payload.RefreshToken == "" {
		return OAuthCredentials{}, errors.New("xAI token response did not include a refresh token")
	}
	claims := decodeJWTClaims(payload.IDToken)
	if claims == nil {
		claims = decodeJWTClaims(payload.AccessToken)
	}
	expiresIn := payload.ExpiresIn
	if expiresIn <= 0 {
		expiresIn = 3600
	}
	return OAuthCredentials{
		Access: payload.AccessToken, Refresh: payload.RefreshToken,
		Expires:   f.now().Add(time.Duration(expiresIn)*time.Second - xaiRefreshSkew).UnixMilli(),
		AccountID: stringClaim(claims, "sub"), Email: strings.ToLower(stringClaim(claims, "email")), Source: SourceOAuth,
	}, nil
}

func validateXAIEndpoint(raw string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Scheme != "https" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", errors.New("xAI OAuth discovery returned an unexpected endpoint")
	}
	host := strings.ToLower(parsed.Hostname())
	if host != "x.ai" && !strings.HasSuffix(host, ".x.ai") {
		return "", errors.New("xAI OAuth discovery returned an unexpected endpoint")
	}
	return parsed.String(), nil
}

func safeXAITokenError(status int, body []byte) error {
	var payload struct {
		Error string `json:"error"`
	}
	_ = json.Unmarshal(body, &payload)
	if payload.Error != "" {
		return fmt.Errorf("xAI token request failed: HTTP %d %s", status, payload.Error)
	}
	return fmt.Errorf("xAI token request failed: HTTP %d", status)
}

func randomXAINonce() (string, error) {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return hex.EncodeToString(bytes), nil
}

func stringClaim(claims map[string]any, name string) string {
	value, _ := claims[name].(string)
	return value
}
