package platform

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestACLHardeningRemovesBroadSIDsBeforeGrant(t *testing.T) {
	ResetACLHardenStateForTests()
	path := filepath.Join(t.TempDir(), "secret-token.json")
	if err := os.WriteFile(path, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	var calls [][]string
	runner := func(args []string, _ time.Duration) ACLCommandResult {
		calls = append(calls, append([]string(nil), args...))
		return ACLCommandResult{Success: true}
	}
	result, err := HardenSecretPathWithOptions(path, HardenSecretOptions{Required: true, Platform: "windows", Username: "jun", Domain: "DEV", Runner: runner})
	if err != nil || !result.OK {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	want := [][]string{{path, "/inheritance:r"}, {path, "/remove:g", "*S-1-1-0", "*S-1-5-11", "*S-1-5-32-545"}, {path, "/grant:r", `DEV\jun:(F)`}}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("calls=%#v want=%#v", calls, want)
	}
	if _, err := HardenSecretPathWithOptions(path, HardenSecretOptions{Required: true, Platform: "windows", Username: "jun", Runner: func([]string, time.Duration) ACLCommandResult {
		t.Fatal("cached harden reran")
		return ACLCommandResult{}
	}}); err != nil {
		t.Fatal(err)
	}
}

func TestACLHardeningVerifiesFailedBroadSIDRemoval(t *testing.T) {
	ResetACLHardenStateForTests()
	path := filepath.Join(t.TempDir(), "secret.json")
	_ = os.WriteFile(path, []byte("secret"), 0o600)
	runner := func(args []string, _ time.Duration) ACLCommandResult {
		if len(args) > 1 && args[1] == "/remove:g" {
			return ACLCommandResult{Err: errors.New("exit"), ExitCode: 1}
		}
		if len(args) > 1 && args[1] == "/findsid" {
			return ACLCommandResult{Success: true, Stdout: path + " SID Found"}
		}
		return ACLCommandResult{Success: true}
	}
	result, err := HardenSecretPathWithOptions(path, HardenSecretOptions{Required: true, Platform: "windows", Username: "jun", Runner: runner})
	if err == nil || strings.Contains(err.Error(), path) || !strings.Contains(result.Diagnostics, "EICACLS") {
		t.Fatalf("result=%+v err=%v", result, err)
	}
}

func TestACLHardeningTimeoutSoftFailsAndMemoizes(t *testing.T) {
	ResetACLHardenStateForTests()
	path := filepath.Join(t.TempDir(), "secret.json")
	_ = os.WriteFile(path, []byte("secret"), 0o600)
	now := time.Unix(0, 0)
	calls := 0
	runner := func(_ []string, _ time.Duration) ACLCommandResult {
		calls++
		now = now.Add(time.Second)
		return ACLCommandResult{TimedOut: true, Err: errors.New("timeout")}
	}
	options := HardenSecretOptions{Required: true, Platform: "windows", Username: "jun", Timeout: 1500 * time.Millisecond, Runner: runner, Now: func() time.Time { return now }}
	result, err := HardenSecretPathWithOptions(path, options)
	if err != nil || result.OK || !strings.Contains(result.Diagnostics, "ETIMEDOUT") || calls != 2 {
		t.Fatalf("result=%+v err=%v calls=%d", result, err, calls)
	}
	result, err = HardenSecretPathWithOptions(path, options)
	if err != nil || !strings.Contains(result.Diagnostics, "previous attempt timed out") || calls != 2 {
		t.Fatalf("memoized result=%+v err=%v calls=%d", result, err, calls)
	}
}

func TestResolveACLHardenTimeoutClamps(t *testing.T) {
	if resolveACLHardenTimeout("bad") != DefaultACLHardenTimeout || resolveACLHardenTimeout("1") != MinACLHardenTimeout || resolveACLHardenTimeout("999999") != MaxACLHardenTimeout {
		t.Fatal("ACL timeout did not apply default/min/max bounds")
	}
}
