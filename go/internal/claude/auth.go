package claude

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

type AuthPresence string

const (
	AuthPresent AuthPresence = "present"
	AuthAbsent  AuthPresence = "absent"
	AuthUnknown AuthPresence = "unknown"

	ProxyMarker = "opencodex-proxy"
)

type AuthSourceID string

const (
	AuthSourceClaudeJSON      AuthSourceID = "claude-json-oauth"
	AuthSourceCredentialsFile AuthSourceID = "claude-credentials-file"
	AuthSourceMacOSKeychain   AuthSourceID = "macos-keychain"
	AuthSourceExportedEnv     AuthSourceID = "exported-env"
)

type AuthSourceResult struct {
	Source   AuthSourceID
	Presence AuthPresence
	Detail   string
}

type AuthDetectResult struct {
	Presence         AuthPresence
	FoundBy          AuthSourceID
	Sources          []AuthSourceResult
	StaleProxyMarker bool
}

type AuthDetectDeps struct {
	ReadClaudeJSON        func() (map[string]any, bool, error)
	CredentialsFileExists func() (bool, error)
	KeychainProbe         func() AuthPresence
	Env                   func() (map[string]string, error)
	OwnTokens             []string
}

func DetectClaudeAuth(deps AuthDetectDeps) AuthDetectResult {
	sources := []AuthSourceResult{
		detectClaudeJSON(deps),
		detectCredentialsFile(deps),
		detectKeychain(deps),
		detectExportedEnv(deps),
	}
	stale := false
	if deps.Env != nil {
		if env, err := deps.Env(); err == nil {
			stale = strings.TrimSpace(env["ANTHROPIC_AUTH_TOKEN"]) == ProxyMarker
		}
	}
	result := AuthDetectResult{Presence: AuthAbsent, Sources: sources, StaleProxyMarker: stale}
	for _, source := range sources {
		if source.Presence == AuthPresent {
			result.Presence = AuthPresent
			result.FoundBy = source.Source
			return result
		}
	}
	for _, source := range sources {
		if source.Presence == AuthUnknown {
			result.Presence = AuthUnknown
			break
		}
	}
	return result
}

func detectClaudeJSON(deps AuthDetectDeps) AuthSourceResult {
	result := AuthSourceResult{Source: AuthSourceClaudeJSON, Presence: AuthAbsent}
	if deps.ReadClaudeJSON == nil {
		result.Presence, result.Detail = AuthUnknown, "unreadable"
		return result
	}
	value, exists, err := deps.ReadClaudeJSON()
	if err != nil {
		result.Presence, result.Detail = AuthUnknown, "unreadable"
		return result
	}
	if !exists {
		return result
	}
	account, ok := value["oauthAccount"].(map[string]any)
	if !ok {
		return result
	}
	email, _ := account["emailAddress"].(string)
	if strings.TrimSpace(email) != "" {
		result.Presence, result.Detail = AuthPresent, "oauthAccount"
	}
	return result
}

func detectCredentialsFile(deps AuthDetectDeps) AuthSourceResult {
	result := AuthSourceResult{Source: AuthSourceCredentialsFile, Presence: AuthAbsent}
	if deps.CredentialsFileExists == nil {
		result.Presence, result.Detail = AuthUnknown, "unreadable"
		return result
	}
	exists, err := deps.CredentialsFileExists()
	if err != nil {
		result.Presence, result.Detail = AuthUnknown, "unreadable"
	} else if exists {
		result.Presence = AuthPresent
	}
	return result
}

func detectKeychain(deps AuthDetectDeps) (result AuthSourceResult) {
	result = AuthSourceResult{Source: AuthSourceMacOSKeychain, Presence: AuthUnknown}
	if deps.KeychainProbe == nil {
		return result
	}
	defer func() {
		if recover() != nil {
			result.Presence, result.Detail = AuthUnknown, "probe failed"
		}
	}()
	result.Presence = deps.KeychainProbe()
	if result.Presence != AuthPresent && result.Presence != AuthAbsent && result.Presence != AuthUnknown {
		result.Presence = AuthUnknown
	}
	return result
}

func detectExportedEnv(deps AuthDetectDeps) AuthSourceResult {
	result := AuthSourceResult{Source: AuthSourceExportedEnv, Presence: AuthAbsent}
	if deps.Env == nil {
		result.Presence = AuthUnknown
		return result
	}
	env, err := deps.Env()
	if err != nil {
		result.Presence = AuthUnknown
		return result
	}
	own := make(map[string]struct{}, len(deps.OwnTokens)+1)
	own[ProxyMarker] = struct{}{}
	for _, token := range deps.OwnTokens {
		if token = strings.TrimSpace(token); token != "" {
			own[token] = struct{}{}
		}
	}
	for _, key := range []string{"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"} {
		value := strings.TrimSpace(env[key])
		if value == "" {
			continue
		}
		if _, ours := own[value]; ours {
			continue
		}
		result.Presence, result.Detail = AuthPresent, key
		return result
	}
	return result
}

func AuthConfigDir(env map[string]string) string {
	if explicit := strings.TrimSpace(env["CLAUDE_CONFIG_DIR"]); explicit != "" {
		return explicit
	}
	home := strings.TrimSpace(env["HOME"])
	if home == "" {
		home = strings.TrimSpace(env["USERPROFILE"])
	}
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	return filepath.Join(home, ".claude")
}

func DefaultAuthDetectDeps(env map[string]string, ownTokens []string) AuthDetectDeps {
	if env == nil {
		env = currentEnvironment()
	}
	boundEnv := cloneAuthEnv(env)
	configDir := AuthConfigDir(boundEnv)
	claudeJSONPath := filepath.Join(filepath.Dir(configDir), ".claude.json")
	return AuthDetectDeps{
		ReadClaudeJSON: func() (map[string]any, bool, error) {
			data, err := os.ReadFile(claudeJSONPath)
			if errors.Is(err, os.ErrNotExist) {
				return nil, false, nil
			}
			if err != nil {
				return nil, false, err
			}
			var value map[string]any
			if err := json.Unmarshal(data, &value); err != nil {
				return nil, true, err
			}
			return value, true, nil
		},
		CredentialsFileExists: func() (bool, error) {
			_, err := os.Stat(filepath.Join(configDir, ".credentials.json"))
			if errors.Is(err, os.ErrNotExist) {
				return false, nil
			}
			return err == nil, err
		},
		KeychainProbe: defaultKeychainProbe,
		Env:           func() (map[string]string, error) { return cloneAuthEnv(boundEnv), nil },
		OwnTokens:     append([]string(nil), ownTokens...),
	}
}

func currentEnvironment() map[string]string {
	env := make(map[string]string)
	for _, entry := range os.Environ() {
		key, value, ok := strings.Cut(entry, "=")
		if ok {
			env[key] = value
		}
	}
	return env
}

func cloneAuthEnv(source map[string]string) map[string]string {
	clone := make(map[string]string, len(source))
	for key, value := range source {
		clone[key] = value
	}
	return clone
}

type MarkerMode string
type AuthModeOrigin string
type AuthModeIntent string

const (
	MarkerProxy            MarkerMode     = "proxy"
	MarkerSubscription     MarkerMode     = "subscription"
	AuthOriginManual       AuthModeOrigin = "manual"
	AuthOriginAutoPresent  AuthModeOrigin = "auto-present"
	AuthOriginAutoAbsent   AuthModeOrigin = "auto-absent"
	AuthOriginAutoUnknown  AuthModeOrigin = "auto-unknown"
	AuthIntentAuto         AuthModeIntent = "auto"
	AuthIntentProxy        AuthModeIntent = "proxy"
	AuthIntentSubscription AuthModeIntent = "subscription"
)

type ResolvedAuthMode struct {
	MarkerMode MarkerMode
	Origin     AuthModeOrigin
	FoundBy    AuthSourceID
	Detection  AuthDetectResult
}

func ResolveAuthMode(stored string, detection AuthDetectResult) ResolvedAuthMode {
	if stored == string(MarkerProxy) {
		return ResolvedAuthMode{MarkerMode: MarkerProxy, Origin: AuthOriginManual, Detection: detection}
	}
	if stored == string(MarkerSubscription) {
		return ResolvedAuthMode{MarkerMode: MarkerSubscription, Origin: AuthOriginManual, Detection: detection}
	}
	switch detection.Presence {
	case AuthPresent:
		return ResolvedAuthMode{MarkerMode: MarkerSubscription, Origin: AuthOriginAutoPresent, FoundBy: detection.FoundBy, Detection: detection}
	case AuthAbsent:
		return ResolvedAuthMode{MarkerMode: MarkerProxy, Origin: AuthOriginAutoAbsent, Detection: detection}
	default:
		return ResolvedAuthMode{MarkerMode: MarkerSubscription, Origin: AuthOriginAutoUnknown, Detection: detection}
	}
}

func StoredAuthModeIntent(stored string) AuthModeIntent {
	switch stored {
	case string(MarkerProxy):
		return AuthIntentProxy
	case string(MarkerSubscription):
		return AuthIntentSubscription
	default:
		return AuthIntentAuto
	}
}
