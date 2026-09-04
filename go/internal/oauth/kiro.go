package oauth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const KiroCLIInstallCommand = "curl -fsSL https://cli.kiro.dev/install | bash"

func KiroCLIPrerequisite() string {
	return "install the Kiro CLI (`" + KiroCLIInstallCommand + "`) and run `kiro-cli login`"
}

var kiroRegionPattern = regexp.MustCompile(`^[a-z]{2}(?:-[a-z]+)+-\d$`)

type KiroImportedCredential struct {
	OAuthCredentials
	AuthType, ProfileARN, SSORegion, APIRegion, ClientID, ClientSecret string
}

type KiroFlow struct {
	Client   HTTPDoer
	Region   string
	Now      func() time.Time
	Env      func(string) string
	ReadFile func(string) ([]byte, error)
	HomeDir  func() (string, error)
}

func NewKiroFlow(client HTTPDoer) *KiroFlow {
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	return &KiroFlow{Client: client, Region: "us-east-1", Now: time.Now, Env: os.Getenv, ReadFile: os.ReadFile, HomeDir: os.UserHomeDir}
}

func NormalizeKiroRegion(region string) string {
	region = strings.TrimSpace(region)
	if kiroRegionPattern.MatchString(region) {
		return region
	}
	return ""
}

func InferKiroRegionFromProfileARN(arn string) string {
	parts := strings.Split(arn, ":")
	if len(parts) > 3 {
		return NormalizeKiroRegion(parts[3])
	}
	return ""
}

func (f *KiroFlow) Import(path string) (KiroImportedCredential, bool, error) {
	env := f.Env
	if env == nil {
		env = os.Getenv
	}
	if path == "" {
		path = strings.TrimSpace(env("KIRO_CREDS_FILE"))
		if path == "" {
			path = strings.TrimSpace(env("KIRO_CREDENTIALS_FILE"))
		}
	}
	if path != "" {
		path = f.expandPath(path)
		read := f.ReadFile
		if read == nil {
			read = os.ReadFile
		}
		data, err := read(path)
		if err != nil {
			return KiroImportedCredential{}, false, err
		}
		credential, err := parseKiroCredential(data, f.now())
		return credential, err == nil, err
	}
	credential, found, err := f.importSQLite()
	if err != nil || found {
		return credential, found, err
	}
	access := strings.TrimSpace(env("KIRO_ACCESS_TOKEN"))
	if access == "" {
		return KiroImportedCredential{}, false, nil
	}
	return KiroImportedCredential{OAuthCredentials: OAuthCredentials{Access: access, Refresh: strings.TrimSpace(env("KIRO_REFRESH_TOKEN")), Expires: f.now().Add(time.Hour).UnixMilli(), Source: SourceEnvironment}}, true, nil
}

func (f *KiroFlow) expandPath(path string) string {
	if path == "~" || strings.HasPrefix(path, "~/") {
		home := f.HomeDir
		if home == nil {
			home = os.UserHomeDir
		}
		if value, err := home(); err == nil {
			return filepath.Join(value, strings.TrimPrefix(strings.TrimPrefix(path, "~"), "/"))
		}
	}
	return path
}

func parseKiroCredential(data []byte, now time.Time) (KiroImportedCredential, error) {
	var payload map[string]any
	if err := json.Unmarshal(data, &payload); err != nil {
		return KiroImportedCredential{}, errors.New("Kiro credential file contains invalid JSON")
	}
	field := func(names ...string) string {
		for _, name := range names {
			if value, ok := payload[name].(string); ok && value != "" {
				return value
			}
		}
		return ""
	}
	access := field("accessToken", "access_token")
	if access == "" {
		return KiroImportedCredential{}, errors.New("Kiro credential file has no access token")
	}
	refresh, profile, region := field("refreshToken", "refresh_token"), field("profileArn", "profile_arn"), field("region")
	apiRegion := field("apiRegion", "api_region")
	if apiRegion == "" {
		apiRegion = InferKiroRegionFromProfileARN(profile)
	}
	if apiRegion == "" {
		apiRegion = NormalizeKiroRegion(region)
	}
	expiryValue, expiryPresent := payload["expiresAt"]
	if !expiryPresent {
		expiryValue, expiryPresent = payload["expires_at"]
	}
	expires := parseKiroExpiry(expiryValue, expiryPresent, refresh != "", now)
	clientID, clientSecret := field("clientId", "client_id"), field("clientSecret", "client_secret")
	authType := "kiro_desktop"
	if clientID != "" && clientSecret != "" {
		authType = "aws_sso_oidc"
	}
	return KiroImportedCredential{OAuthCredentials: OAuthCredentials{Access: access, Refresh: refresh, Expires: expires, Source: SourceCredentialFile}, AuthType: authType, ProfileARN: profile, SSORegion: NormalizeKiroRegion(region), APIRegion: apiRegion, ClientID: clientID, ClientSecret: clientSecret}, nil
}

func parseKiroExpiry(value any, present, hasRefresh bool, now time.Time) int64 {
	switch typed := value.(type) {
	case float64:
		if typed < 10_000_000_000 {
			typed *= 1000
		}
		return int64(typed)
	case string:
		if parsed, err := time.Parse(time.RFC3339, typed); err == nil {
			return parsed.UnixMilli()
		}
	}
	if present && hasRefresh {
		return 0
	}
	return now.Add(time.Hour).UnixMilli()
}

func (f *KiroFlow) Refresh(ctx context.Context, imported KiroImportedCredential) (OAuthCredentials, error) {
	if imported.Refresh == "" {
		return OAuthCredentials{}, errors.New("Kiro: no refresh token available")
	}
	region := NormalizeKiroRegion(f.Region)
	if region == "" {
		region = imported.SSORegion
	}
	if region == "" {
		region = "us-east-1"
	}
	endpoint := "https://prod." + region + ".auth.desktop.kiro.dev/refreshToken"
	payload := map[string]string{"refreshToken": imported.Refresh}
	if imported.AuthType == "aws_sso_oidc" && imported.ClientID != "" && imported.ClientSecret != "" {
		endpoint = "https://oidc." + region + ".amazonaws.com/token"
		payload = map[string]string{"grantType": "refresh_token", "clientId": imported.ClientID, "clientSecret": imported.ClientSecret, "refreshToken": imported.Refresh}
	}
	body, _ := json.Marshal(payload)
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(string(body)))
	if err != nil {
		return OAuthCredentials{}, err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := f.Client.Do(request)
	if err != nil {
		return OAuthCredentials{}, errors.New("Kiro token refresh failed")
	}
	responseBody, err := readOAuthBody(response)
	if err != nil {
		return OAuthCredentials{}, err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return OAuthCredentials{}, fmt.Errorf("Kiro token refresh failed: HTTP %d", response.StatusCode)
	}
	var wire struct {
		Access  string `json:"accessToken"`
		Refresh string `json:"refreshToken"`
		Expires int64  `json:"expiresIn"`
	}
	if json.Unmarshal(responseBody, &wire) != nil || wire.Access == "" {
		return OAuthCredentials{}, errors.New("Kiro refresh returned no accessToken")
	}
	if wire.Refresh == "" {
		wire.Refresh = imported.Refresh
	}
	if wire.Expires <= 0 {
		wire.Expires = 3600
	}
	return OAuthCredentials{Access: wire.Access, Refresh: wire.Refresh, Expires: f.now().Add(time.Duration(wire.Expires) * time.Second).UnixMilli(), Source: imported.Source}, nil
}

func (f *KiroFlow) now() time.Time {
	if f.Now != nil {
		return f.Now()
	}
	return time.Now()
}
