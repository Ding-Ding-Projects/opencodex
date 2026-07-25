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
	"strings"
	"time"
)

const (
	CursorLoginURL   = "https://cursor.com/loginDeepControl"
	CursorPollURL    = "https://api2.cursor.sh/auth/poll"
	CursorRefreshURL = "https://api2.cursor.sh/auth/exchange_user_api_key"
)

type CursorAuthParams struct {
	Verifier, Challenge, UUID, LoginURL string
}

type CursorFlow struct {
	Client       HTTPDoer
	LoginURL     string
	PollURL      string
	RefreshURL   string
	PollInterval time.Duration
	MaxAttempts  int
	Now          func() time.Time
	Wait         func(context.Context, time.Duration) error
}

func NewCursorFlow(client HTTPDoer) *CursorFlow {
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}
	return &CursorFlow{Client: client, LoginURL: CursorLoginURL, PollURL: CursorPollURL, RefreshURL: CursorRefreshURL, PollInterval: time.Second, MaxAttempts: 150, Now: time.Now, Wait: waitForDevicePoll}
}

func (f *CursorFlow) GenerateAuthParams() (CursorAuthParams, error) {
	pkce, err := GeneratePKCE()
	if err != nil {
		return CursorAuthParams{}, err
	}
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return CursorAuthParams{}, fmt.Errorf("generate Cursor login id: %w", err)
	}
	uuid := hex.EncodeToString(random)
	values := url.Values{"challenge": {pkce.Challenge}, "uuid": {uuid}, "mode": {"login"}, "redirectTarget": {"cli"}}
	return CursorAuthParams{Verifier: pkce.Verifier, Challenge: pkce.Challenge, UUID: uuid, LoginURL: f.LoginURL + "?" + values.Encode()}, nil
}

func (f *CursorFlow) Login(ctx context.Context, onAuth func(Authorization)) (OAuthCredentials, error) {
	params, err := f.GenerateAuthParams()
	if err != nil {
		return OAuthCredentials{}, err
	}
	if onAuth != nil {
		onAuth(Authorization{URL: params.LoginURL, Instructions: "Approve the Cursor login in your browser, then return here."})
	}
	return f.Poll(ctx, params.UUID, params.Verifier)
}

func (f *CursorFlow) Poll(ctx context.Context, uuid, verifier string) (OAuthCredentials, error) {
	if strings.TrimSpace(uuid) == "" || strings.TrimSpace(verifier) == "" {
		return OAuthCredentials{}, errors.New("Cursor auth state is incomplete")
	}
	delay := f.PollInterval
	if delay <= 0 {
		delay = time.Second
	}
	attempts := f.MaxAttempts
	if attempts <= 0 {
		attempts = 150
	}
	consecutiveErrors := 0
	for attempt := 0; attempt < attempts; attempt++ {
		if err := f.wait(ctx, delay); err != nil {
			return OAuthCredentials{}, err
		}
		endpoint := f.PollURL + "?" + url.Values{"uuid": {uuid}, "verifier": {verifier}}.Encode()
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
		if err != nil {
			return OAuthCredentials{}, err
		}
		response, err := f.Client.Do(request)
		if err != nil {
			consecutiveErrors++
			if consecutiveErrors >= 3 {
				return OAuthCredentials{}, errors.New("too many consecutive errors during Cursor auth polling")
			}
			delay = cursorNextDelay(delay)
			continue
		}
		body, readErr := readOAuthBody(response)
		if readErr != nil {
			return OAuthCredentials{}, readErr
		}
		if response.StatusCode == http.StatusNotFound {
			consecutiveErrors = 0
			delay = cursorNextDelay(delay)
			continue
		}
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			return OAuthCredentials{}, fmt.Errorf("Cursor auth poll failed: HTTP %d", response.StatusCode)
		}
		var payload struct {
			AccessToken  string `json:"accessToken"`
			RefreshToken string `json:"refreshToken"`
		}
		if err := json.Unmarshal(body, &payload); err != nil || payload.AccessToken == "" || payload.RefreshToken == "" {
			return OAuthCredentials{}, errors.New("Cursor auth response missing tokens")
		}
		return CredentialsFromCursorTokens(payload.AccessToken, payload.RefreshToken, f.now()), nil
	}
	return OAuthCredentials{}, errors.New("Cursor authentication polling timeout")
}

func (f *CursorFlow) Refresh(ctx context.Context, refreshToken string) (OAuthCredentials, error) {
	if strings.TrimSpace(refreshToken) == "" {
		return OAuthCredentials{}, errors.New("Cursor refresh token is required")
	}
	var last error
	for attempt := 0; attempt < 3; attempt++ {
		request, err := http.NewRequestWithContext(ctx, http.MethodPost, f.RefreshURL, strings.NewReader("{}"))
		if err != nil {
			return OAuthCredentials{}, err
		}
		request.Header.Set("Authorization", "Bearer "+refreshToken)
		request.Header.Set("Content-Type", "application/json")
		response, err := f.Client.Do(request)
		if err != nil {
			last = errors.New("Cursor token refresh failed")
		} else {
			body, readErr := readOAuthBody(response)
			if readErr != nil {
				return OAuthCredentials{}, readErr
			}
			if response.StatusCode >= 200 && response.StatusCode < 300 {
				var payload struct {
					AccessToken  string `json:"accessToken"`
					RefreshToken string `json:"refreshToken"`
				}
				if json.Unmarshal(body, &payload) != nil || payload.AccessToken == "" {
					return OAuthCredentials{}, errors.New("Cursor refresh response missing access token")
				}
				if payload.RefreshToken == "" {
					payload.RefreshToken = refreshToken
				}
				return CredentialsFromCursorTokens(payload.AccessToken, payload.RefreshToken, f.now()), nil
			}
			if !cursorRetryable(response.StatusCode) {
				return OAuthCredentials{}, fmt.Errorf("Cursor token refresh failed: HTTP %d", response.StatusCode)
			}
			last = fmt.Errorf("Cursor token refresh failed: HTTP %d", response.StatusCode)
		}
		if attempt < 2 {
			if err := f.wait(ctx, time.Duration(300*(1<<attempt))*time.Millisecond); err != nil {
				return OAuthCredentials{}, err
			}
		}
	}
	return OAuthCredentials{}, last
}

func CredentialsFromCursorTokens(accessToken, refreshToken string, now time.Time) OAuthCredentials {
	claims := decodeJWTClaims(accessToken)
	if len(claims) == 0 {
		claims = decodeJWTClaims(refreshToken)
	}
	expires := now.Add(time.Hour).UnixMilli()
	if exp, ok := claims["exp"].(float64); ok {
		expires = time.Unix(int64(exp), 0).Add(-5 * time.Minute).UnixMilli()
	}
	credential := OAuthCredentials{Access: accessToken, Refresh: refreshToken, Expires: expires, Source: SourceOAuth}
	if value, ok := claims["sub"].(string); ok {
		credential.AccountID = value
	}
	if value, ok := claims["email"].(string); ok {
		credential.Email = strings.ToLower(value)
	}
	return credential
}

func (f *CursorFlow) now() time.Time {
	if f.Now != nil {
		return f.Now()
	}
	return time.Now()
}

func (f *CursorFlow) wait(ctx context.Context, delay time.Duration) error {
	if f.Wait != nil {
		return f.Wait(ctx, delay)
	}
	return waitForDevicePoll(ctx, delay)
}

func cursorNextDelay(delay time.Duration) time.Duration {
	next := time.Duration(float64(delay) * 1.2)
	if next > 10*time.Second {
		return 10 * time.Second
	}
	return next
}

func cursorRetryable(status int) bool { return status == 429 || status >= 500 && status <= 504 }

func readOAuthBody(response *http.Response) ([]byte, error) {
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, maxDeviceResponseBytes+1))
	if err != nil {
		return nil, err
	}
	if len(body) > maxDeviceResponseBytes {
		return nil, errors.New("OAuth response exceeds size limit")
	}
	return body, nil
}
