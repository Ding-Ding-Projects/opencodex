# 091 — Literal patch: Claude auth core parity

Apply this unified diff against `ddd968a0` after extracting and applying
`061_response_state_literal_patch.md` and
`071_usage_snapshot_literal_patch.md` in that order. The patch is complete:
it includes the Go auth owner, build-tagged Keychain activation, schema and
startup migration changes, and all focused tests.

```diff
diff --git a/go/internal/claude/auth.go b/go/internal/claude/auth.go
new file mode 100644
index 00000000..b91cb265
--- /dev/null
+++ b/go/internal/claude/auth.go
@@ -0,0 +1,287 @@
+package claude
+
+import (
+	"encoding/json"
+	"errors"
+	"os"
+	"path/filepath"
+	"strings"
+)
+
+type AuthPresence string
+
+const (
+	AuthPresent AuthPresence = "present"
+	AuthAbsent  AuthPresence = "absent"
+	AuthUnknown AuthPresence = "unknown"
+
+	ProxyMarker = "opencodex-proxy"
+)
+
+type AuthSourceID string
+
+const (
+	AuthSourceClaudeJSON      AuthSourceID = "claude-json-oauth"
+	AuthSourceCredentialsFile AuthSourceID = "claude-credentials-file"
+	AuthSourceMacOSKeychain   AuthSourceID = "macos-keychain"
+	AuthSourceExportedEnv     AuthSourceID = "exported-env"
+)
+
+type AuthSourceResult struct {
+	Source   AuthSourceID
+	Presence AuthPresence
+	Detail   string
+}
+
+type AuthDetectResult struct {
+	Presence         AuthPresence
+	FoundBy          AuthSourceID
+	Sources          []AuthSourceResult
+	StaleProxyMarker bool
+}
+
+type AuthDetectDeps struct {
+	ReadClaudeJSON        func() (map[string]any, bool, error)
+	CredentialsFileExists func() (bool, error)
+	KeychainProbe         func() AuthPresence
+	Env                   func() (map[string]string, error)
+	OwnTokens             []string
+}
+
+func DetectClaudeAuth(deps AuthDetectDeps) AuthDetectResult {
+	sources := []AuthSourceResult{
+		detectClaudeJSON(deps),
+		detectCredentialsFile(deps),
+		detectKeychain(deps),
+		detectExportedEnv(deps),
+	}
+	stale := false
+	if deps.Env != nil {
+		if env, err := deps.Env(); err == nil {
+			stale = strings.TrimSpace(env["ANTHROPIC_AUTH_TOKEN"]) == ProxyMarker
+		}
+	}
+	result := AuthDetectResult{Presence: AuthAbsent, Sources: sources, StaleProxyMarker: stale}
+	for _, source := range sources {
+		if source.Presence == AuthPresent {
+			result.Presence = AuthPresent
+			result.FoundBy = source.Source
+			return result
+		}
+	}
+	for _, source := range sources {
+		if source.Presence == AuthUnknown {
+			result.Presence = AuthUnknown
+			break
+		}
+	}
+	return result
+}
+
+func detectClaudeJSON(deps AuthDetectDeps) AuthSourceResult {
+	result := AuthSourceResult{Source: AuthSourceClaudeJSON, Presence: AuthAbsent}
+	if deps.ReadClaudeJSON == nil {
+		result.Presence, result.Detail = AuthUnknown, "unreadable"
+		return result
+	}
+	value, exists, err := deps.ReadClaudeJSON()
+	if err != nil {
+		result.Presence, result.Detail = AuthUnknown, "unreadable"
+		return result
+	}
+	if !exists {
+		return result
+	}
+	account, ok := value["oauthAccount"].(map[string]any)
+	if !ok {
+		return result
+	}
+	email, _ := account["emailAddress"].(string)
+	if strings.TrimSpace(email) != "" {
+		result.Presence, result.Detail = AuthPresent, "oauthAccount"
+	}
+	return result
+}
+
+func detectCredentialsFile(deps AuthDetectDeps) AuthSourceResult {
+	result := AuthSourceResult{Source: AuthSourceCredentialsFile, Presence: AuthAbsent}
+	if deps.CredentialsFileExists == nil {
+		result.Presence, result.Detail = AuthUnknown, "unreadable"
+		return result
+	}
+	exists, err := deps.CredentialsFileExists()
+	if err != nil {
+		result.Presence, result.Detail = AuthUnknown, "unreadable"
+	} else if exists {
+		result.Presence = AuthPresent
+	}
+	return result
+}
+
+func detectKeychain(deps AuthDetectDeps) (result AuthSourceResult) {
+	result = AuthSourceResult{Source: AuthSourceMacOSKeychain, Presence: AuthUnknown}
+	if deps.KeychainProbe == nil {
+		return result
+	}
+	defer func() {
+		if recover() != nil {
+			result.Presence, result.Detail = AuthUnknown, "probe failed"
+		}
+	}()
+	result.Presence = deps.KeychainProbe()
+	if result.Presence != AuthPresent && result.Presence != AuthAbsent && result.Presence != AuthUnknown {
+		result.Presence = AuthUnknown
+	}
+	return result
+}
+
+func detectExportedEnv(deps AuthDetectDeps) AuthSourceResult {
+	result := AuthSourceResult{Source: AuthSourceExportedEnv, Presence: AuthAbsent}
+	if deps.Env == nil {
+		result.Presence = AuthUnknown
+		return result
+	}
+	env, err := deps.Env()
+	if err != nil {
+		result.Presence = AuthUnknown
+		return result
+	}
+	own := make(map[string]struct{}, len(deps.OwnTokens)+1)
+	own[ProxyMarker] = struct{}{}
+	for _, token := range deps.OwnTokens {
+		if token = strings.TrimSpace(token); token != "" {
+			own[token] = struct{}{}
+		}
+	}
+	for _, key := range []string{"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"} {
+		value := strings.TrimSpace(env[key])
+		if value == "" {
+			continue
+		}
+		if _, ours := own[value]; ours {
+			continue
+		}
+		result.Presence, result.Detail = AuthPresent, key
+		return result
+	}
+	return result
+}
+
+func AuthConfigDir(env map[string]string) string {
+	if explicit := strings.TrimSpace(env["CLAUDE_CONFIG_DIR"]); explicit != "" {
+		return explicit
+	}
+	home := strings.TrimSpace(env["HOME"])
+	if home == "" {
+		home = strings.TrimSpace(env["USERPROFILE"])
+	}
+	if home == "" {
+		home, _ = os.UserHomeDir()
+	}
+	return filepath.Join(home, ".claude")
+}
+
+func DefaultAuthDetectDeps(env map[string]string, ownTokens []string) AuthDetectDeps {
+	if env == nil {
+		env = currentEnvironment()
+	}
+	boundEnv := cloneAuthEnv(env)
+	configDir := AuthConfigDir(boundEnv)
+	claudeJSONPath := filepath.Join(filepath.Dir(configDir), ".claude.json")
+	return AuthDetectDeps{
+		ReadClaudeJSON: func() (map[string]any, bool, error) {
+			data, err := os.ReadFile(claudeJSONPath)
+			if errors.Is(err, os.ErrNotExist) {
+				return nil, false, nil
+			}
+			if err != nil {
+				return nil, false, err
+			}
+			var value map[string]any
+			if err := json.Unmarshal(data, &value); err != nil {
+				return nil, true, err
+			}
+			return value, true, nil
+		},
+		CredentialsFileExists: func() (bool, error) {
+			_, err := os.Stat(filepath.Join(configDir, ".credentials.json"))
+			if errors.Is(err, os.ErrNotExist) {
+				return false, nil
+			}
+			return err == nil, err
+		},
+		KeychainProbe: defaultKeychainProbe,
+		Env:           func() (map[string]string, error) { return cloneAuthEnv(boundEnv), nil },
+		OwnTokens:     append([]string(nil), ownTokens...),
+	}
+}
+
+func currentEnvironment() map[string]string {
+	env := make(map[string]string)
+	for _, entry := range os.Environ() {
+		key, value, ok := strings.Cut(entry, "=")
+		if ok {
+			env[key] = value
+		}
+	}
+	return env
+}
+
+func cloneAuthEnv(source map[string]string) map[string]string {
+	clone := make(map[string]string, len(source))
+	for key, value := range source {
+		clone[key] = value
+	}
+	return clone
+}
+
+type MarkerMode string
+type AuthModeOrigin string
+type AuthModeIntent string
+
+const (
+	MarkerProxy            MarkerMode     = "proxy"
+	MarkerSubscription     MarkerMode     = "subscription"
+	AuthOriginManual       AuthModeOrigin = "manual"
+	AuthOriginAutoPresent  AuthModeOrigin = "auto-present"
+	AuthOriginAutoAbsent   AuthModeOrigin = "auto-absent"
+	AuthOriginAutoUnknown  AuthModeOrigin = "auto-unknown"
+	AuthIntentAuto         AuthModeIntent = "auto"
+	AuthIntentProxy        AuthModeIntent = "proxy"
+	AuthIntentSubscription AuthModeIntent = "subscription"
+)
+
+type ResolvedAuthMode struct {
+	MarkerMode MarkerMode
+	Origin     AuthModeOrigin
+	FoundBy    AuthSourceID
+	Detection  AuthDetectResult
+}
+
+func ResolveAuthMode(stored string, detection AuthDetectResult) ResolvedAuthMode {
+	if stored == string(MarkerProxy) {
+		return ResolvedAuthMode{MarkerMode: MarkerProxy, Origin: AuthOriginManual, Detection: detection}
+	}
+	if stored == string(MarkerSubscription) {
+		return ResolvedAuthMode{MarkerMode: MarkerSubscription, Origin: AuthOriginManual, Detection: detection}
+	}
+	switch detection.Presence {
+	case AuthPresent:
+		return ResolvedAuthMode{MarkerMode: MarkerSubscription, Origin: AuthOriginAutoPresent, FoundBy: detection.FoundBy, Detection: detection}
+	case AuthAbsent:
+		return ResolvedAuthMode{MarkerMode: MarkerProxy, Origin: AuthOriginAutoAbsent, Detection: detection}
+	default:
+		return ResolvedAuthMode{MarkerMode: MarkerSubscription, Origin: AuthOriginAutoUnknown, Detection: detection}
+	}
+}
+
+func StoredAuthModeIntent(stored string) AuthModeIntent {
+	switch stored {
+	case string(MarkerProxy):
+		return AuthIntentProxy
+	case string(MarkerSubscription):
+		return AuthIntentSubscription
+	default:
+		return AuthIntentAuto
+	}
+}
diff --git a/go/internal/claude/auth_keychain.go b/go/internal/claude/auth_keychain.go
new file mode 100644
index 00000000..6c4088c8
--- /dev/null
+++ b/go/internal/claude/auth_keychain.go
@@ -0,0 +1,46 @@
+package claude
+
+import (
+	"context"
+	"io"
+	"os/exec"
+	"time"
+)
+
+const (
+	keychainService      = "Claude Code-credentials"
+	keychainItemNotFound = 44
+	keychainTimeout      = 1500 * time.Millisecond
+)
+
+type keychainCommand func(context.Context, string, []string, io.Reader, io.Writer, io.Writer) (int, error)
+
+func probeDarwinKeychain(run keychainCommand) AuthPresence {
+	ctx, cancel := context.WithTimeout(context.Background(), keychainTimeout)
+	defer cancel()
+	status, err := run(ctx, "security", []string{"find-generic-password", "-s", keychainService}, nil, io.Discard, io.Discard)
+	if err != nil || ctx.Err() != nil {
+		return AuthUnknown
+	}
+	switch status {
+	case 0:
+		return AuthPresent
+	case keychainItemNotFound:
+		return AuthAbsent
+	default:
+		return AuthUnknown
+	}
+}
+
+func runKeychainCommand(ctx context.Context, name string, args []string, stdin io.Reader, stdout, stderr io.Writer) (int, error) {
+	command := exec.CommandContext(ctx, name, args...)
+	command.Stdin, command.Stdout, command.Stderr = stdin, stdout, stderr
+	err := command.Run()
+	if err == nil {
+		return 0, nil
+	}
+	if exit, ok := err.(*exec.ExitError); ok {
+		return exit.ExitCode(), nil
+	}
+	return -1, err
+}
diff --git a/go/internal/claude/auth_keychain_darwin.go b/go/internal/claude/auth_keychain_darwin.go
new file mode 100644
index 00000000..6677f08a
--- /dev/null
+++ b/go/internal/claude/auth_keychain_darwin.go
@@ -0,0 +1,5 @@
+//go:build darwin
+
+package claude
+
+func defaultKeychainProbe() AuthPresence { return probeDarwinKeychain(runKeychainCommand) }
diff --git a/go/internal/claude/auth_keychain_other.go b/go/internal/claude/auth_keychain_other.go
new file mode 100644
index 00000000..d81af1c0
--- /dev/null
+++ b/go/internal/claude/auth_keychain_other.go
@@ -0,0 +1,5 @@
+//go:build !darwin
+
+package claude
+
+func defaultKeychainProbe() AuthPresence { return AuthAbsent }
diff --git a/go/internal/claude/auth_test.go b/go/internal/claude/auth_test.go
new file mode 100644
index 00000000..eb292a76
--- /dev/null
+++ b/go/internal/claude/auth_test.go
@@ -0,0 +1,165 @@
+package claude
+
+import (
+	"context"
+	"errors"
+	"io"
+	"os"
+	"path/filepath"
+	"reflect"
+	"strings"
+	"testing"
+	"time"
+)
+
+func authDeps() AuthDetectDeps {
+	return AuthDetectDeps{
+		ReadClaudeJSON:        func() (map[string]any, bool, error) { return nil, false, nil },
+		CredentialsFileExists: func() (bool, error) { return false, nil },
+		KeychainProbe:         func() AuthPresence { return AuthAbsent },
+		Env:                   func() (map[string]string, error) { return map[string]string{}, nil },
+	}
+}
+
+func TestDetectClaudeAuthSourceParityAndAggregation(t *testing.T) {
+	tests := []struct {
+		name   string
+		mutate func(*AuthDetectDeps)
+		want   AuthPresence
+		found  AuthSourceID
+	}{
+		{"oauth", func(d *AuthDetectDeps) {
+			d.ReadClaudeJSON = func() (map[string]any, bool, error) {
+				return map[string]any{"oauthAccount": map[string]any{"emailAddress": "secret@example.test"}}, true, nil
+			}
+		}, AuthPresent, AuthSourceClaudeJSON},
+		{"corrupt", func(d *AuthDetectDeps) {
+			d.ReadClaudeJSON = func() (map[string]any, bool, error) { return nil, true, errors.New("corrupt") }
+		}, AuthUnknown, ""},
+		{"credentials", func(d *AuthDetectDeps) { d.CredentialsFileExists = func() (bool, error) { return true, nil } }, AuthPresent, AuthSourceCredentialsFile},
+		{"credentials unreadable", func(d *AuthDetectDeps) {
+			d.CredentialsFileExists = func() (bool, error) { return false, os.ErrPermission }
+		}, AuthUnknown, ""},
+		{"keychain", func(d *AuthDetectDeps) { d.KeychainProbe = func() AuthPresence { return AuthPresent } }, AuthPresent, AuthSourceMacOSKeychain},
+		{"keychain unknown", func(d *AuthDetectDeps) { d.KeychainProbe = func() AuthPresence { return AuthUnknown } }, AuthUnknown, ""},
+		{"api env", func(d *AuthDetectDeps) {
+			d.Env = func() (map[string]string, error) { return map[string]string{"ANTHROPIC_API_KEY": "sk-ant-user"}, nil }
+		}, AuthPresent, AuthSourceExportedEnv},
+		{"token env", func(d *AuthDetectDeps) {
+			d.Env = func() (map[string]string, error) { return map[string]string{"ANTHROPIC_AUTH_TOKEN": "user-token"}, nil }
+		}, AuthPresent, AuthSourceExportedEnv},
+	}
+	for _, test := range tests {
+		t.Run(test.name, func(t *testing.T) {
+			deps := authDeps()
+			test.mutate(&deps)
+			got := DetectClaudeAuth(deps)
+			if got.Presence != test.want || got.FoundBy != test.found {
+				t.Fatalf("result=%#v", got)
+			}
+			if strings.Contains(strings.Join(sourceDetails(got.Sources), " "), "secret@example.test") {
+				t.Fatal("source details exposed account data")
+			}
+		})
+	}
+
+	deps := authDeps()
+	deps.ReadClaudeJSON = func() (map[string]any, bool, error) { return nil, true, errors.New("corrupt") }
+	deps.CredentialsFileExists = func() (bool, error) { return false, os.ErrPermission }
+	deps.KeychainProbe = func() AuthPresence { return AuthUnknown }
+	deps.Env = func() (map[string]string, error) { return nil, errors.New("unavailable") }
+	if got := DetectClaudeAuth(deps); got.Presence != AuthUnknown {
+		t.Fatalf("all unknown collapsed to %q", got.Presence)
+	}
+}
+
+func sourceDetails(sources []AuthSourceResult) []string {
+	values := make([]string, 0, len(sources))
+	for _, source := range sources {
+		values = append(values, source.Detail)
+	}
+	return values
+}
+
+func TestDetectClaudeAuthExcludesOwnedTokensAndReportsStaleMarker(t *testing.T) {
+	for _, key := range []string{"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"} {
+		deps := authDeps()
+		deps.OwnTokens = []string{"admission-key"}
+		deps.Env = func() (map[string]string, error) { return map[string]string{key: "admission-key"}, nil }
+		if got := DetectClaudeAuth(deps); got.Presence != AuthAbsent {
+			t.Fatalf("%s own token counted as auth: %#v", key, got)
+		}
+	}
+	deps := authDeps()
+	deps.Env = func() (map[string]string, error) { return map[string]string{"ANTHROPIC_AUTH_TOKEN": ProxyMarker}, nil }
+	got := DetectClaudeAuth(deps)
+	if got.Presence != AuthAbsent || !got.StaleProxyMarker {
+		t.Fatalf("stale marker result=%#v", got)
+	}
+}
+
+func TestResolveAuthModeConservativeAndManualIntent(t *testing.T) {
+	for _, test := range []struct {
+		stored   string
+		presence AuthPresence
+		mode     MarkerMode
+		origin   AuthModeOrigin
+		intent   AuthModeIntent
+	}{
+		{"", AuthPresent, MarkerSubscription, AuthOriginAutoPresent, AuthIntentAuto},
+		{"", AuthAbsent, MarkerProxy, AuthOriginAutoAbsent, AuthIntentAuto},
+		{"", AuthUnknown, MarkerSubscription, AuthOriginAutoUnknown, AuthIntentAuto},
+		{"proxy", AuthPresent, MarkerProxy, AuthOriginManual, AuthIntentProxy},
+		{"subscription", AuthAbsent, MarkerSubscription, AuthOriginManual, AuthIntentSubscription},
+	} {
+		resolved := ResolveAuthMode(test.stored, AuthDetectResult{Presence: test.presence, FoundBy: AuthSourceClaudeJSON})
+		if resolved.MarkerMode != test.mode || resolved.Origin != test.origin || StoredAuthModeIntent(test.stored) != test.intent {
+			t.Fatalf("case=%#v resolved=%#v intent=%q", test, resolved, StoredAuthModeIntent(test.stored))
+		}
+	}
+}
+
+func TestDefaultAuthDetectDepsUsesBoundProfileAndEnvironment(t *testing.T) {
+	home := t.TempDir()
+	if err := os.WriteFile(filepath.Join(home, ".claude.json"), []byte(`{"oauthAccount":{"emailAddress":"user@example.test"}}`), 0o600); err != nil {
+		t.Fatal(err)
+	}
+	env := map[string]string{"HOME": home, "ANTHROPIC_API_KEY": "sk-ant-user"}
+	deps := DefaultAuthDetectDeps(env, nil)
+	if got := DetectClaudeAuth(deps); got.Presence != AuthPresent || got.FoundBy != AuthSourceClaudeJSON {
+		t.Fatalf("default detection=%#v", got)
+	}
+	bound, _ := deps.Env()
+	bound["HOME"] = "changed"
+	again, _ := deps.Env()
+	if again["HOME"] != home || AuthConfigDir(map[string]string{"CLAUDE_CONFIG_DIR": "/tmp/profile"}) != "/tmp/profile" {
+		t.Fatalf("environment binding changed: %#v", again)
+	}
+}
+
+func TestDarwinKeychainProbeIsMetadataOnlyBoundedAndExitAware(t *testing.T) {
+	for _, test := range []struct {
+		status int
+		err    error
+		want   AuthPresence
+	}{{0, nil, AuthPresent}, {44, nil, AuthAbsent}, {1, nil, AuthUnknown}, {-1, errors.New("spawn"), AuthUnknown}} {
+		got := probeDarwinKeychain(func(ctx context.Context, name string, args []string, stdin io.Reader, stdout, stderr io.Writer) (int, error) {
+			deadline, ok := ctx.Deadline()
+			remaining := time.Until(deadline)
+			if !ok || remaining <= 0 || remaining > keychainTimeout || name != "security" || !reflect.DeepEqual(args, []string{"find-generic-password", "-s", keychainService}) || stdin != nil || stdout != io.Discard || stderr != io.Discard {
+				t.Fatalf("unsafe keychain command name=%q args=%#v deadline=%v remaining=%v", name, args, ok, remaining)
+			}
+			for _, forbidden := range []string{"-g", "-w"} {
+				for _, arg := range args {
+					if arg == forbidden {
+						t.Fatalf("secret-output flag %s present", forbidden)
+					}
+				}
+			}
+			return test.status, test.err
+		})
+		if got != test.want {
+			t.Fatalf("status=%d err=%v got=%q want=%q", test.status, test.err, got, test.want)
+		}
+	}
+}
diff --git a/go/internal/config/claude_auth_migration_test.go b/go/internal/config/claude_auth_migration_test.go
new file mode 100644
index 00000000..e661116a
--- /dev/null
+++ b/go/internal/config/claude_auth_migration_test.go
@@ -0,0 +1,73 @@
+package config
+
+import (
+	"encoding/json"
+	"os"
+	"path/filepath"
+	"testing"
+	"time"
+)
+
+func TestMigrateClaudeAuthModePinsLegacyAndIsIdempotent(t *testing.T) {
+	now := time.Date(2026, 7, 26, 1, 2, 3, 0, time.UTC)
+	enabled := true
+	cfg := Config{ClaudeCode: &ClaudeCodeConfig{Enabled: &enabled}}
+	migrated, changed := MigrateClaudeAuthMode(cfg, now)
+	if !changed || migrated.ClaudeCode.AuthMode != "subscription" || migrated.ClaudeCode.AuthModeMigratedAt != now.Format(time.RFC3339Nano) {
+		t.Fatalf("migrated=%#v changed=%v", migrated.ClaudeCode, changed)
+	}
+	if cfg.ClaudeCode.AuthMode != "" || cfg.ClaudeCode.AuthModeMigratedAt != "" {
+		t.Fatal("migration mutated input")
+	}
+	again, changed := MigrateClaudeAuthMode(migrated, now.Add(time.Hour))
+	if changed || again.ClaudeCode.AuthModeMigratedAt != migrated.ClaudeCode.AuthModeMigratedAt {
+		t.Fatalf("idempotence failed: %#v changed=%v", again.ClaudeCode, changed)
+	}
+}
+
+func TestMigrateClaudeAuthModePreservesManualAndLaterAuto(t *testing.T) {
+	now := time.Now()
+	manual, changed := MigrateClaudeAuthMode(Config{ClaudeCode: &ClaudeCodeConfig{AuthMode: "proxy"}}, now)
+	if !changed || manual.ClaudeCode.AuthMode != "proxy" || manual.ClaudeCode.AuthModeMigratedAt == "" {
+		t.Fatalf("manual=%#v changed=%v", manual.ClaudeCode, changed)
+	}
+	manual.ClaudeCode.AuthMode = ""
+	auto, changed := MigrateClaudeAuthMode(manual, now.Add(time.Hour))
+	if changed || auto.ClaudeCode.AuthMode != "" {
+		t.Fatalf("later auto resurrected: %#v changed=%v", auto.ClaudeCode, changed)
+	}
+	withoutBlock, changed := MigrateClaudeAuthMode(Config{}, now)
+	if changed || withoutBlock.ClaudeCode != nil {
+		t.Fatalf("empty config changed: %#v", withoutBlock.ClaudeCode)
+	}
+}
+
+func TestLoadMigratedPersistsClaudeSentinelAndRoundTrips(t *testing.T) {
+	dir := t.TempDir()
+	path := filepath.Join(dir, "config.json")
+	data := []byte(`{"port":10100,"providers":{},"defaultProvider":"openai","claudeCode":{"enabled":true}}`)
+	if err := os.WriteFile(path, data, 0o600); err != nil {
+		t.Fatal(err)
+	}
+	cfg, err := LoadMigrated(path)
+	if err != nil {
+		t.Fatal(err)
+	}
+	if cfg.ClaudeCode == nil || cfg.ClaudeCode.AuthMode != "subscription" || cfg.ClaudeCode.AuthModeMigratedAt == "" {
+		t.Fatalf("loaded=%#v", cfg.ClaudeCode)
+	}
+	var raw map[string]any
+	persisted, err := os.ReadFile(path)
+	if err != nil || json.Unmarshal(persisted, &raw) != nil {
+		t.Fatalf("persisted config invalid: %v", err)
+	}
+	claudeCode := raw["claudeCode"].(map[string]any)
+	if claudeCode["authMode"] != "subscription" || claudeCode["authModeMigratedAt"] == "" {
+		t.Fatalf("persisted claudeCode=%#v", claudeCode)
+	}
+	stamp := cfg.ClaudeCode.AuthModeMigratedAt
+	again, err := LoadMigrated(path)
+	if err != nil || again.ClaudeCode.AuthModeMigratedAt != stamp {
+		t.Fatalf("second load=%#v err=%v", again.ClaudeCode, err)
+	}
+}
diff --git a/go/internal/config/migration.go b/go/internal/config/migration.go
index 42f4d82a..5a8fe6ab 100644
--- a/go/internal/config/migration.go
+++ b/go/internal/config/migration.go
@@ -6,6 +6,8 @@ import (
 	"fmt"
 	"os"
 	"path/filepath"
+	"strings"
+	"time"
 
 	"github.com/lidge-jun/opencodex-go/internal/providers"
 )
@@ -65,19 +67,41 @@ func LoadMigrated(path string) (*Config, error) {
 	if err != nil {
 		return nil, err
 	}
-	migrated, changed, err := MigrateOpenAITiers(*cfg)
-	if err != nil || !changed {
+	migrated, tiersChanged, err := MigrateOpenAITiers(*cfg)
+	if err != nil {
 		return cfg, err
 	}
-	if err := backupBeforeOpenAITierMigration(path); err != nil {
-		return nil, err
+	migrated, claudeChanged := MigrateClaudeAuthMode(migrated, time.Now())
+	if !tiersChanged && !claudeChanged {
+		return cfg, nil
+	}
+	if tiersChanged {
+		if err := backupBeforeOpenAITierMigration(path); err != nil {
+			return nil, err
+		}
 	}
 	if err := Save(path, &migrated); err != nil {
-		return nil, fmt.Errorf("save OpenAI tier migration: %w", err)
+		return nil, fmt.Errorf("save startup migrations: %w", err)
 	}
 	return &migrated, nil
 }
 
+// MigrateClaudeAuthMode preserves the pre-auto effective behavior exactly once.
+// An existing claudeCode block with no stored mode meant subscription before auto.
+func MigrateClaudeAuthMode(cfg Config, now time.Time) (Config, bool) {
+	if cfg.ClaudeCode == nil || strings.TrimSpace(cfg.ClaudeCode.AuthModeMigratedAt) != "" {
+		return cfg, false
+	}
+	out := cfg
+	claudeCode := *cfg.ClaudeCode
+	if claudeCode.AuthMode == "" {
+		claudeCode.AuthMode = "subscription"
+	}
+	claudeCode.AuthModeMigratedAt = now.UTC().Format(time.RFC3339Nano)
+	out.ClaudeCode = &claudeCode
+	return out, true
+}
+
 func backupBeforeOpenAITierMigration(path string) error {
 	original, err := os.ReadFile(path)
 	if err != nil {
diff --git a/go/internal/config/schema_extended.go b/go/internal/config/schema_extended.go
index 9e20348f..8a02a0bf 100644
--- a/go/internal/config/schema_extended.go
+++ b/go/internal/config/schema_extended.go
@@ -13,6 +13,7 @@ type ClaudeCodeConfig struct {
 	ModelMap           map[string]string      `json:"modelMap,omitempty"`
 	SystemEnv          bool                   `json:"systemEnv,omitempty"`
 	AuthMode           string                 `json:"authMode,omitempty"`
+	AuthModeMigratedAt string                 `json:"authModeMigratedAt,omitempty"`
 	MaxContextTokens   int                    `json:"maxContextTokens,omitempty"`
 	AlwaysEnableEffort bool                   `json:"alwaysEnableEffort,omitempty"`
 	TierModels         *ClaudeTierModels      `json:"tierModels,omitempty"`
```

