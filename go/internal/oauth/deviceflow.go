package oauth

import (
	"bytes"
	"context"
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
	deviceGrantType           = "urn:ietf:params:oauth:grant-type:device_code"
	defaultDeviceFlowTTL      = 15 * time.Minute
	defaultDevicePollInterval = 5 * time.Second
	minimumDevicePollInterval = time.Second
	deviceSlowDownIncrement   = 5 * time.Second
	maxDeviceResponseBytes    = 1 << 20
)

type DeviceFlowConfig struct {
	ClientID               string
	Scope                  string
	DeviceAuthorizationURL string
	TokenURL               string
	Headers                http.Header
	DefaultExpiresIn       time.Duration
	DefaultPollInterval    time.Duration
	MinimumPollInterval    time.Duration
	ExpirySkew             time.Duration
	AllowInsecureVerifyURL bool
	AllowInsecureEndpoints bool
}

type DeviceAuthorization struct {
	DeviceCode              string
	UserCode                string
	VerificationURI         string
	VerificationURIComplete string
	ExpiresAt               time.Time
	Interval                time.Duration
}

type DeviceAuthorizationError struct {
	Code        string
	Description string
}

func (e *DeviceAuthorizationError) Error() string {
	if e.Description == "" {
		return "OAuth device flow failed: " + e.Code
	}
	return "OAuth device flow failed: " + e.Code + ": " + e.Description
}

type DeviceFlow struct {
	Client HTTPDoer
	Config DeviceFlowConfig
	Now    func() time.Time
	Wait   func(context.Context, time.Duration) error
}

func NewDeviceFlow(client HTTPDoer, config DeviceFlowConfig) *DeviceFlow {
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	return &DeviceFlow{Client: client, Config: config, Now: time.Now, Wait: waitForDevicePoll}
}

// Start requests an RFC 8628 device code. DeviceCode is intentionally returned
// only as opaque state and is never included in errors.
func (f *DeviceFlow) Start(ctx context.Context) (DeviceAuthorization, error) {
	if err := f.validate(); err != nil {
		return DeviceAuthorization{}, err
	}
	values := url.Values{"client_id": {f.Config.ClientID}}
	if f.Config.Scope != "" {
		values.Set("scope", f.Config.Scope)
	}
	body, status, err := f.postForm(ctx, f.Config.DeviceAuthorizationURL, values)
	if err != nil {
		return DeviceAuthorization{}, fmt.Errorf("device authorization request: %w", err)
	}
	if status < 200 || status >= 300 {
		return DeviceAuthorization{}, safeOAuthHTTPError("device authorization", status, body)
	}
	var response struct {
		DeviceCode              string `json:"device_code"`
		UserCode                string `json:"user_code"`
		VerificationURI         string `json:"verification_uri"`
		VerificationURIComplete string `json:"verification_uri_complete"`
		ExpiresIn               int64  `json:"expires_in"`
		Interval                int64  `json:"interval"`
	}
	if err := decodeSingleJSON(body, &response); err != nil {
		return DeviceAuthorization{}, fmt.Errorf("device authorization returned invalid JSON: %w", err)
	}
	if strings.TrimSpace(response.DeviceCode) == "" || strings.TrimSpace(response.UserCode) == "" || strings.TrimSpace(response.VerificationURI) == "" {
		return DeviceAuthorization{}, errors.New("device authorization response is missing required fields")
	}
	verifyURI, err := validateVerificationURI(response.VerificationURI, f.Config.AllowInsecureVerifyURL)
	if err != nil {
		return DeviceAuthorization{}, err
	}
	complete := response.VerificationURIComplete
	if complete == "" {
		complete = verifyURI
	} else if complete, err = validateVerificationURI(complete, f.Config.AllowInsecureVerifyURL); err != nil {
		return DeviceAuthorization{}, err
	}
	if !sameOrigin(verifyURI, complete) {
		return DeviceAuthorization{}, errors.New("device authorization verification URI changed origin")
	}
	expiresIn := time.Duration(response.ExpiresIn) * time.Second
	if expiresIn <= 0 {
		expiresIn = f.defaultTTL()
	}
	interval := time.Duration(response.Interval) * time.Second
	if interval <= 0 {
		interval = f.defaultInterval()
	}
	interval = max(interval, f.minimumInterval())
	return DeviceAuthorization{
		DeviceCode: response.DeviceCode, UserCode: response.UserCode,
		VerificationURI: verifyURI, VerificationURIComplete: complete,
		ExpiresAt: f.now().Add(expiresIn), Interval: interval,
	}, nil
}

// Poll waits before every token request as required by RFC 8628 section 3.5.
func (f *DeviceFlow) Poll(ctx context.Context, authorization DeviceAuthorization) (OAuthCredentials, error) {
	if err := f.validate(); err != nil {
		return OAuthCredentials{}, err
	}
	if authorization.DeviceCode == "" || authorization.ExpiresAt.IsZero() {
		return OAuthCredentials{}, errors.New("invalid device authorization state")
	}
	interval := max(authorization.Interval, f.minimumInterval())
	for f.now().Before(authorization.ExpiresAt) {
		if err := f.wait(ctx, interval); err != nil {
			return OAuthCredentials{}, err
		}
		if !f.now().Before(authorization.ExpiresAt) {
			break
		}
		values := url.Values{
			"client_id":   {f.Config.ClientID},
			"device_code": {authorization.DeviceCode},
			"grant_type":  {deviceGrantType},
		}
		body, status, err := f.postForm(ctx, f.Config.TokenURL, values)
		if err != nil {
			return OAuthCredentials{}, fmt.Errorf("device token poll: %w", err)
		}
		var response struct {
			AccessToken      string `json:"access_token"`
			RefreshToken     string `json:"refresh_token"`
			ExpiresIn        int64  `json:"expires_in"`
			Error            string `json:"error"`
			ErrorDescription string `json:"error_description"`
			Interval         int64  `json:"interval"`
		}
		if err := decodeSingleJSON(body, &response); err != nil {
			return OAuthCredentials{}, fmt.Errorf("device token poll returned invalid JSON: %w", err)
		}
		if status >= 200 && status < 300 && response.AccessToken != "" {
			expiresIn := time.Duration(response.ExpiresIn) * time.Second
			if expiresIn <= 0 {
				expiresIn = time.Hour
			}
			expiresAt := f.now().Add(expiresIn - min(f.Config.ExpirySkew, expiresIn))
			return OAuthCredentials{
				Access: response.AccessToken, Refresh: response.RefreshToken,
				Expires: expiresAt.UnixMilli(), Source: SourceOAuth,
			}, nil
		}
		switch response.Error {
		case "authorization_pending":
			continue
		case "slow_down":
			serverInterval := time.Duration(response.Interval) * time.Second
			interval = max(interval+deviceSlowDownIncrement, serverInterval, f.minimumInterval())
			continue
		case "access_denied", "expired_token":
			return OAuthCredentials{}, &DeviceAuthorizationError{Code: response.Error, Description: redactDeviceSecret(response.ErrorDescription, authorization.DeviceCode)}
		case "":
			if status < 200 || status >= 300 {
				return OAuthCredentials{}, fmt.Errorf("device token poll failed: HTTP %d", status)
			}
			return OAuthCredentials{}, errors.New("device token response is missing an access token")
		default:
			return OAuthCredentials{}, &DeviceAuthorizationError{Code: response.Error, Description: redactDeviceSecret(response.ErrorDescription, authorization.DeviceCode)}
		}
	}
	return OAuthCredentials{}, &DeviceAuthorizationError{Code: "expired_token", Description: "device authorization timed out"}
}

func (f *DeviceFlow) validate() error {
	if strings.TrimSpace(f.Config.ClientID) == "" {
		return errors.New("device flow client ID is required")
	}
	for label, raw := range map[string]string{"device authorization": f.Config.DeviceAuthorizationURL, "token": f.Config.TokenURL} {
		parsed, err := url.Parse(raw)
		secureScheme := parsed != nil && (parsed.Scheme == "https" || (f.Config.AllowInsecureEndpoints && parsed.Scheme == "http"))
		if err != nil || parsed.Host == "" || parsed.User != nil || !secureScheme {
			return fmt.Errorf("invalid %s URL", label)
		}
	}
	return nil
}

func (f *DeviceFlow) postForm(ctx context.Context, endpoint string, values url.Values) ([]byte, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(values.Encode()))
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	for name, values := range f.Config.Headers {
		for _, value := range values {
			req.Header.Add(name, value)
		}
	}
	response, err := f.Client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, maxDeviceResponseBytes+1))
	if err != nil {
		return nil, response.StatusCode, err
	}
	if len(body) > maxDeviceResponseBytes {
		return nil, response.StatusCode, errors.New("OAuth response exceeds size limit")
	}
	return body, response.StatusCode, nil
}

func (f *DeviceFlow) now() time.Time {
	if f.Now != nil {
		return f.Now()
	}
	return time.Now()
}

func (f *DeviceFlow) wait(ctx context.Context, duration time.Duration) error {
	if f.Wait != nil {
		return f.Wait(ctx, duration)
	}
	return waitForDevicePoll(ctx, duration)
}

func (f *DeviceFlow) defaultTTL() time.Duration {
	if f.Config.DefaultExpiresIn > 0 {
		return f.Config.DefaultExpiresIn
	}
	return defaultDeviceFlowTTL
}

func (f *DeviceFlow) defaultInterval() time.Duration {
	if f.Config.DefaultPollInterval > 0 {
		return f.Config.DefaultPollInterval
	}
	return defaultDevicePollInterval
}

func (f *DeviceFlow) minimumInterval() time.Duration {
	if f.Config.MinimumPollInterval > 0 {
		return f.Config.MinimumPollInterval
	}
	return minimumDevicePollInterval
}

func validateVerificationURI(raw string, allowInsecure bool) (string, error) {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" || parsed.User != nil || (parsed.Scheme != "https" && !(allowInsecure && parsed.Scheme == "http")) {
		return "", errors.New("device authorization returned an unsafe verification URI")
	}
	return parsed.String(), nil
}

func sameOrigin(left, right string) bool {
	a, errA := url.Parse(left)
	b, errB := url.Parse(right)
	return errA == nil && errB == nil && strings.EqualFold(a.Scheme, b.Scheme) && strings.EqualFold(a.Host, b.Host)
}

func redactDeviceSecret(description, secret string) string {
	if secret == "" {
		return description
	}
	return strings.ReplaceAll(description, secret, "[REDACTED]")
}

func decodeSingleJSON(body []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(body))
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("trailing JSON value")
		}
		return err
	}
	return nil
}

func waitForDevicePoll(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
