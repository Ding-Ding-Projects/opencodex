package claude

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func authDeps() AuthDetectDeps {
	return AuthDetectDeps{
		ReadClaudeJSON:        func() (map[string]any, bool, error) { return nil, false, nil },
		CredentialsFileExists: func() (bool, error) { return false, nil },
		KeychainProbe:         func() AuthPresence { return AuthAbsent },
		Env:                   func() (map[string]string, error) { return map[string]string{}, nil },
	}
}

func TestDetectClaudeAuthSourceParityAndAggregation(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*AuthDetectDeps)
		want   AuthPresence
		found  AuthSourceID
	}{
		{"oauth", func(d *AuthDetectDeps) {
			d.ReadClaudeJSON = func() (map[string]any, bool, error) {
				return map[string]any{"oauthAccount": map[string]any{"emailAddress": "secret@example.test"}}, true, nil
			}
		}, AuthPresent, AuthSourceClaudeJSON},
		{"corrupt", func(d *AuthDetectDeps) {
			d.ReadClaudeJSON = func() (map[string]any, bool, error) { return nil, true, errors.New("corrupt") }
		}, AuthUnknown, ""},
		{"credentials", func(d *AuthDetectDeps) { d.CredentialsFileExists = func() (bool, error) { return true, nil } }, AuthPresent, AuthSourceCredentialsFile},
		{"credentials unreadable", func(d *AuthDetectDeps) {
			d.CredentialsFileExists = func() (bool, error) { return false, os.ErrPermission }
		}, AuthUnknown, ""},
		{"keychain", func(d *AuthDetectDeps) { d.KeychainProbe = func() AuthPresence { return AuthPresent } }, AuthPresent, AuthSourceMacOSKeychain},
		{"keychain unknown", func(d *AuthDetectDeps) { d.KeychainProbe = func() AuthPresence { return AuthUnknown } }, AuthUnknown, ""},
		{"api env", func(d *AuthDetectDeps) {
			d.Env = func() (map[string]string, error) { return map[string]string{"ANTHROPIC_API_KEY": "sk-ant-user"}, nil }
		}, AuthPresent, AuthSourceExportedEnv},
		{"token env", func(d *AuthDetectDeps) {
			d.Env = func() (map[string]string, error) { return map[string]string{"ANTHROPIC_AUTH_TOKEN": "user-token"}, nil }
		}, AuthPresent, AuthSourceExportedEnv},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			deps := authDeps()
			test.mutate(&deps)
			got := DetectClaudeAuth(deps)
			if got.Presence != test.want || got.FoundBy != test.found {
				t.Fatalf("result=%#v", got)
			}
			if strings.Contains(strings.Join(sourceDetails(got.Sources), " "), "secret@example.test") {
				t.Fatal("source details exposed account data")
			}
		})
	}

	deps := authDeps()
	deps.ReadClaudeJSON = func() (map[string]any, bool, error) { return nil, true, errors.New("corrupt") }
	deps.CredentialsFileExists = func() (bool, error) { return false, os.ErrPermission }
	deps.KeychainProbe = func() AuthPresence { return AuthUnknown }
	deps.Env = func() (map[string]string, error) { return nil, errors.New("unavailable") }
	if got := DetectClaudeAuth(deps); got.Presence != AuthUnknown {
		t.Fatalf("all unknown collapsed to %q", got.Presence)
	}
}

func sourceDetails(sources []AuthSourceResult) []string {
	values := make([]string, 0, len(sources))
	for _, source := range sources {
		values = append(values, source.Detail)
	}
	return values
}

func TestDetectClaudeAuthExcludesOwnedTokensAndReportsStaleMarker(t *testing.T) {
	for _, key := range []string{"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"} {
		deps := authDeps()
		deps.OwnTokens = []string{"admission-key"}
		deps.Env = func() (map[string]string, error) { return map[string]string{key: "admission-key"}, nil }
		if got := DetectClaudeAuth(deps); got.Presence != AuthAbsent {
			t.Fatalf("%s own token counted as auth: %#v", key, got)
		}
	}
	deps := authDeps()
	deps.Env = func() (map[string]string, error) { return map[string]string{"ANTHROPIC_AUTH_TOKEN": ProxyMarker}, nil }
	got := DetectClaudeAuth(deps)
	if got.Presence != AuthAbsent || !got.StaleProxyMarker {
		t.Fatalf("stale marker result=%#v", got)
	}
}

func TestResolveAuthModeConservativeAndManualIntent(t *testing.T) {
	for _, test := range []struct {
		stored   string
		presence AuthPresence
		mode     MarkerMode
		origin   AuthModeOrigin
		intent   AuthModeIntent
	}{
		{"", AuthPresent, MarkerSubscription, AuthOriginAutoPresent, AuthIntentAuto},
		{"", AuthAbsent, MarkerProxy, AuthOriginAutoAbsent, AuthIntentAuto},
		{"", AuthUnknown, MarkerSubscription, AuthOriginAutoUnknown, AuthIntentAuto},
		{"proxy", AuthPresent, MarkerProxy, AuthOriginManual, AuthIntentProxy},
		{"subscription", AuthAbsent, MarkerSubscription, AuthOriginManual, AuthIntentSubscription},
	} {
		resolved := ResolveAuthMode(test.stored, AuthDetectResult{Presence: test.presence, FoundBy: AuthSourceClaudeJSON})
		if resolved.MarkerMode != test.mode || resolved.Origin != test.origin || StoredAuthModeIntent(test.stored) != test.intent {
			t.Fatalf("case=%#v resolved=%#v intent=%q", test, resolved, StoredAuthModeIntent(test.stored))
		}
	}
}

func TestDefaultAuthDetectDepsUsesBoundProfileAndEnvironment(t *testing.T) {
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, ".claude.json"), []byte(`{"oauthAccount":{"emailAddress":"user@example.test"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	env := map[string]string{"HOME": home, "ANTHROPIC_API_KEY": "sk-ant-user"}
	deps := DefaultAuthDetectDeps(env, nil)
	if got := DetectClaudeAuth(deps); got.Presence != AuthPresent || got.FoundBy != AuthSourceClaudeJSON {
		t.Fatalf("default detection=%#v", got)
	}
	bound, _ := deps.Env()
	bound["HOME"] = "changed"
	again, _ := deps.Env()
	if again["HOME"] != home || AuthConfigDir(map[string]string{"CLAUDE_CONFIG_DIR": "/tmp/profile"}) != "/tmp/profile" {
		t.Fatalf("environment binding changed: %#v", again)
	}
}

func TestDarwinKeychainProbeIsMetadataOnlyBoundedAndExitAware(t *testing.T) {
	for _, test := range []struct {
		status int
		err    error
		want   AuthPresence
	}{{0, nil, AuthPresent}, {44, nil, AuthAbsent}, {1, nil, AuthUnknown}, {-1, errors.New("spawn"), AuthUnknown}} {
		got := probeDarwinKeychain(func(ctx context.Context, name string, args []string, stdin io.Reader, stdout, stderr io.Writer) (int, error) {
			deadline, ok := ctx.Deadline()
			remaining := time.Until(deadline)
			if !ok || remaining <= 0 || remaining > keychainTimeout || name != "security" || !reflect.DeepEqual(args, []string{"find-generic-password", "-s", keychainService}) || stdin != nil || stdout != io.Discard || stderr != io.Discard {
				t.Fatalf("unsafe keychain command name=%q args=%#v deadline=%v remaining=%v", name, args, ok, remaining)
			}
			for _, forbidden := range []string{"-g", "-w"} {
				for _, arg := range args {
					if arg == forbidden {
						t.Fatalf("secret-output flag %s present", forbidden)
					}
				}
			}
			return test.status, test.err
		})
		if got != test.want {
			t.Fatalf("status=%d err=%v got=%q want=%q", test.status, test.err, got, test.want)
		}
	}
}

func TestDarwinKeychainProbeTimeoutReturnsUnknown(t *testing.T) {
	started := time.Now()
	got := probeDarwinKeychain(func(ctx context.Context, _ string, _ []string, _ io.Reader, _, _ io.Writer) (int, error) {
		<-ctx.Done()
		return -1, ctx.Err()
	})
	elapsed := time.Since(started)
	if got != AuthUnknown {
		t.Fatalf("timeout result = %q", got)
	}
	if elapsed < keychainTimeout || elapsed > keychainTimeout+time.Second {
		t.Fatalf("timeout elapsed = %v, want %v..%v", elapsed, keychainTimeout, keychainTimeout+time.Second)
	}
}
