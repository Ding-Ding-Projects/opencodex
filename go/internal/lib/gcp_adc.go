package lib

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	googleOAuthTokenURL = "https://oauth2.googleapis.com/token"
	googleMetadataURL   = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token"
	cloudPlatformScope  = "https://www.googleapis.com/auth/cloud-platform"
	jwtBearerGrant      = "urn:ietf:params:oauth:grant-type:jwt-bearer"
	googleTokenAttempts = 3
	googleRetryBase     = 300 * time.Millisecond
)

type adcFile struct {
	Type         string `json:"type"`
	ClientEmail  string `json:"client_email"`
	PrivateKey   string `json:"private_key"`
	PrivateKeyID string `json:"private_key_id"`
	ClientID     string `json:"client_id"`
	ClientSecret string `json:"client_secret"`
	RefreshToken string `json:"refresh_token"`
}

type googleTokenResponse struct {
	AccessToken string `json:"access_token"`
	ExpiresIn   int64  `json:"expires_in"`
}

type cachedGoogleToken struct {
	token     string
	expiresAt time.Time
}

type adcResult struct {
	source string
	token  googleTokenResponse
}

// ADCResolver resolves Vertex AI Application Default Credentials without an
// external Google authentication dependency. A resolver is safe for concurrent use.
type ADCResolver struct {
	Client *http.Client
	Env    func(string) string
	Home   func() (string, error)
	Now    func() time.Time
	Sleep  func(context.Context, time.Duration) error

	mu       sync.Mutex
	cache    map[string]cachedGoogleToken
	inflight map[string]*adcCall
}

type adcCall struct {
	done  chan struct{}
	token string
	err   error
}

func NewADCResolver() *ADCResolver {
	return &ADCResolver{
		Client:   &http.Client{Timeout: 15 * time.Second},
		Env:      os.Getenv,
		Home:     os.UserHomeDir,
		Now:      time.Now,
		Sleep:    sleepContext,
		cache:    make(map[string]cachedGoogleToken),
		inflight: make(map[string]*adcCall),
	}
}

var defaultADCResolver = NewADCResolver()

// GetVertexAccessToken returns a cached Bearer token suitable for Vertex AI.
func GetVertexAccessToken(ctx context.Context) (string, error) {
	return defaultADCResolver.AccessToken(ctx)
}

// ResetVertexTokenCache clears the process-wide resolver cache.
func ResetVertexTokenCache() { defaultADCResolver.Reset() }

func (r *ADCResolver) Reset() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.cache = make(map[string]cachedGoogleToken)
	r.inflight = make(map[string]*adcCall)
}

func (r *ADCResolver) AccessToken(ctx context.Context) (string, error) {
	if r.Client == nil || r.Env == nil || r.Home == nil || r.Now == nil || r.Sleep == nil {
		return "", errors.New("vertex ADC resolver is not fully configured")
	}
	source := r.currentSourceKey()
	now := r.Now()
	skew := r.refreshSkew()

	r.mu.Lock()
	if cached, ok := r.cache[source]; ok && cached.expiresAt.Add(-skew).After(now) {
		r.mu.Unlock()
		return cached.token, nil
	}
	if call := r.inflight[source]; call != nil {
		r.mu.Unlock()
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-call.done:
			return call.token, call.err
		}
	}
	call := &adcCall{done: make(chan struct{})}
	r.inflight[source] = call
	r.mu.Unlock()

	result, err := r.resolve(ctx)
	if err == nil {
		call.token = result.token.AccessToken
		if call.token == "" {
			err = errors.New("Google token response did not include an access token")
		} else {
			expires := time.Duration(maxInt64(0, result.token.ExpiresIn)) * time.Second
			r.mu.Lock()
			r.cache[result.source] = cachedGoogleToken{token: call.token, expiresAt: r.Now().Add(expires)}
			r.mu.Unlock()
		}
	}
	call.err = err
	r.mu.Lock()
	delete(r.inflight, source)
	close(call.done)
	r.mu.Unlock()
	return call.token, call.err
}

func (r *ADCResolver) refreshSkew() time.Duration {
	value, err := strconv.ParseInt(strings.TrimSpace(r.Env("GOOGLE_VERTEX_REFRESH_SKEW_MS")), 10, 64)
	if err == nil && value > 0 {
		return time.Duration(value) * time.Millisecond
	}
	return time.Minute
}

func (r *ADCResolver) currentSourceKey() string {
	if path := strings.TrimSpace(r.Env("GOOGLE_APPLICATION_CREDENTIALS")); path != "" {
		return fileSourceTag("gac", path)
	}
	path := r.userADCPath()
	if _, err := os.Stat(path); err == nil {
		return fileSourceTag("user", path)
	}
	return "metadata"
}

func (r *ADCResolver) userADCPath() string {
	if explicit := strings.TrimSpace(r.Env("CLOUDSDK_CONFIG")); explicit != "" {
		return filepath.Join(explicit, "application_default_credentials.json")
	}
	if runtime.GOOS == "windows" {
		if appData := strings.TrimSpace(r.Env("APPDATA")); appData != "" {
			return filepath.Join(appData, "gcloud", "application_default_credentials.json")
		}
	}
	home, _ := r.Home()
	return filepath.Join(home, ".config", "gcloud", "application_default_credentials.json")
}

func fileSourceTag(prefix, path string) string {
	info, err := os.Stat(path)
	if err != nil {
		return prefix + ":" + path
	}
	return fmt.Sprintf("%s:%s:%d:%d", prefix, path, info.Size(), info.ModTime().UnixMilli())
}

func (r *ADCResolver) resolve(ctx context.Context) (adcResult, error) {
	path := strings.TrimSpace(r.Env("GOOGLE_APPLICATION_CREDENTIALS"))
	prefix := "gac"
	if path == "" {
		path = r.userADCPath()
		prefix = "user"
	}
	if data, err := os.ReadFile(path); err == nil {
		var credentials adcFile
		if err := json.Unmarshal(data, &credentials); err != nil {
			return adcResult{}, fmt.Errorf("parse Google ADC file: %w", err)
		}
		token, err := r.exchangeFileCredentials(ctx, credentials)
		return adcResult{source: fileSourceTag(prefix, path), token: token}, err
	} else if prefix == "gac" {
		return adcResult{}, fmt.Errorf("GOOGLE_APPLICATION_CREDENTIALS points to an unreadable file: %s", path)
	} else if !errors.Is(err, os.ErrNotExist) {
		return adcResult{}, fmt.Errorf("read Google ADC file: %w", err)
	}

	token, ok, err := r.metadataToken(ctx)
	if err != nil {
		return adcResult{}, err
	}
	if ok {
		return adcResult{source: "metadata", token: token}, nil
	}
	return adcResult{}, errors.New("Vertex AI requires Application Default Credentials; set GOOGLE_APPLICATION_CREDENTIALS, run `gcloud auth application-default login`, or use a GCE/Cloud Run service account")
}

func (r *ADCResolver) exchangeFileCredentials(ctx context.Context, credentials adcFile) (googleTokenResponse, error) {
	values := url.Values{}
	switch credentials.Type {
	case "authorized_user":
		if credentials.ClientID == "" || credentials.ClientSecret == "" || credentials.RefreshToken == "" {
			return googleTokenResponse{}, errors.New("authorized_user ADC is missing required fields")
		}
		values.Set("client_id", credentials.ClientID)
		values.Set("client_secret", credentials.ClientSecret)
		values.Set("refresh_token", credentials.RefreshToken)
		values.Set("grant_type", "refresh_token")
	case "service_account":
		assertion, err := r.serviceAccountJWT(credentials)
		if err != nil {
			return googleTokenResponse{}, err
		}
		values.Set("grant_type", jwtBearerGrant)
		values.Set("assertion", assertion)
	default:
		return googleTokenResponse{}, fmt.Errorf("unsupported Google ADC credential type %q", credentials.Type)
	}
	return r.postToken(ctx, values)
}

func (r *ADCResolver) serviceAccountJWT(credentials adcFile) (string, error) {
	if credentials.ClientEmail == "" || credentials.PrivateKey == "" {
		return "", errors.New("service_account ADC is missing required fields")
	}
	block, _ := pem.Decode([]byte(credentials.PrivateKey))
	if block == nil {
		return "", errors.New("service_account ADC contains an invalid private key")
	}
	keyValue, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return "", fmt.Errorf("parse service account private key: %w", err)
	}
	key, ok := keyValue.(*rsa.PrivateKey)
	if !ok {
		return "", errors.New("service_account ADC private key is not RSA")
	}
	header := map[string]any{"alg": "RS256", "typ": "JWT"}
	if credentials.PrivateKeyID != "" {
		header["kid"] = credentials.PrivateKeyID
	}
	now := r.Now().Unix()
	claims := map[string]any{"iss": credentials.ClientEmail, "scope": cloudPlatformScope, "aud": googleOAuthTokenURL, "iat": now, "exp": now + 3600}
	headerJSON, _ := json.Marshal(header)
	claimsJSON, _ := json.Marshal(claims)
	encoded := base64.RawURLEncoding.EncodeToString(headerJSON) + "." + base64.RawURLEncoding.EncodeToString(claimsJSON)
	digest := sha256.Sum256([]byte(encoded))
	signature, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	if err != nil {
		return "", fmt.Errorf("sign service account assertion: %w", err)
	}
	return encoded + "." + base64.RawURLEncoding.EncodeToString(signature), nil
}

func (r *ADCResolver) postToken(ctx context.Context, values url.Values) (googleTokenResponse, error) {
	encoded := values.Encode()
	var lastErr error
	for attempt := 0; attempt < googleTokenAttempts; attempt++ {
		request, err := http.NewRequestWithContext(ctx, http.MethodPost, googleOAuthTokenURL, strings.NewReader(encoded))
		if err != nil {
			return googleTokenResponse{}, err
		}
		request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		response, err := r.Client.Do(request)
		if err == nil {
			if response.StatusCode >= 200 && response.StatusCode < 300 {
				token, decodeErr := decodeGoogleToken(response.Body)
				response.Body.Close()
				return token, decodeErr
			}
			status := response.StatusCode
			response.Body.Close()
			lastErr = fmt.Errorf("Google OAuth token exchange failed (%d)", status)
			if !retryableGoogleTokenStatus(status) {
				return googleTokenResponse{}, lastErr
			}
		} else {
			if ctx.Err() != nil {
				return googleTokenResponse{}, ctx.Err()
			}
			lastErr = fmt.Errorf("Google OAuth token exchange failed: %w", err)
		}
		if attempt+1 < googleTokenAttempts {
			if err := r.Sleep(ctx, googleRetryBase*time.Duration(1<<attempt)); err != nil {
				return googleTokenResponse{}, err
			}
		}
	}
	return googleTokenResponse{}, lastErr
}

func retryableGoogleTokenStatus(status int) bool {
	return status == http.StatusTooManyRequests || status == http.StatusInternalServerError ||
		status == http.StatusBadGateway || status == http.StatusServiceUnavailable || status == http.StatusGatewayTimeout
}

func (r *ADCResolver) metadataToken(ctx context.Context) (googleTokenResponse, bool, error) {
	requestCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, googleMetadataURL, nil)
	if err != nil {
		return googleTokenResponse{}, false, err
	}
	request.Header.Set("Metadata-Flavor", "Google")
	response, err := r.Client.Do(request)
	if err != nil {
		return googleTokenResponse{}, false, nil
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return googleTokenResponse{}, false, nil
	}
	token, err := decodeGoogleToken(response.Body)
	return token, err == nil, err
}

func decodeGoogleToken(reader io.Reader) (googleTokenResponse, error) {
	var token googleTokenResponse
	if err := json.NewDecoder(io.LimitReader(reader, 1<<20)).Decode(&token); err != nil {
		return token, fmt.Errorf("decode Google token response: %w", err)
	}
	if token.AccessToken == "" {
		return token, errors.New("Google token response did not include an access token")
	}
	return token, nil
}

func maxInt64(left, right int64) int64 {
	if left > right {
		return left
	}
	return right
}
