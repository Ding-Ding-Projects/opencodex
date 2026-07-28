package platform

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// The owner grant must come FIRST, before anything destructive.
//
// This test previously pinned the opposite order, which is the bug:
// `/inheritance:r` strips the inherited ACEs immediately, so failing or timing
// out after it leaves a DACL with no ACE at all -- the user owns the file but
// can neither read nor delete it, and a retry cannot repair it either. The
// oracle grants first for exactly this reason.
func TestACLHardeningGrantsTheOwnerBeforeAnythingDestructive(t *testing.T) {
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
	want := [][]string{
		{path, "/grant:r", `DEV\jun:(F)`},
		{path, "/inheritance:r"},
		{path, "/remove:g", "*S-1-1-0", "*S-1-5-11", "*S-1-5-32-545"},
	}
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

// The activation evidence for the step reorder: a partial failure must never
// leave the user locked out of their own file.
//
// The owner grant succeeds, inheritance removal succeeds, then /remove:g times
// out. The run correctly reports failure -- but the grant is already recorded,
// so the file still has an ACE the user can act on. Under the old order the
// same timeout left a DACL with nothing in it at all.
func TestACLHardeningLeavesTheOwnerGrantedWhenRemovalTimesOut(t *testing.T) {
	ResetACLHardenStateForTests()
	path := filepath.Join(t.TempDir(), "secret-token.json")
	if err := os.WriteFile(path, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	var calls [][]string
	runner := func(args []string, _ time.Duration) ACLCommandResult {
		calls = append(calls, append([]string(nil), args...))
		for _, arg := range args {
			if arg == "/remove:g" {
				return ACLCommandResult{TimedOut: true, Err: context.DeadlineExceeded}
			}
		}
		return ACLCommandResult{Success: true}
	}
	result, err := HardenSecretPathWithOptions(path, HardenSecretOptions{
		Required: false, Platform: "windows", Username: "jun", Domain: "DEV", Runner: runner,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.OK {
		t.Fatal("a timed-out removal must not report the path as hardened")
	}
	if !strings.Contains(result.Diagnostics, "ETIMEDOUT") {
		t.Fatalf("diagnostics = %q, want the timeout named", result.Diagnostics)
	}
	// The load-bearing assertion: the grant ran, and it ran FIRST.
	if len(calls) == 0 {
		t.Fatal("no icacls calls were made")
	}
	first := calls[0]
	if len(first) < 3 || first[1] != "/grant:r" || first[2] != `DEV\jun:(F)` {
		t.Fatalf("first call = %#v; the owner grant must precede any destructive step", first)
	}
	for _, call := range calls {
		for _, arg := range call {
			if arg == "/inheritance:r" {
				// Reaching inheritance removal at all means the grant already
				// succeeded, which is the guarantee being pinned.
				return
			}
		}
	}
	t.Fatal("inheritance removal never ran, so this did not exercise the partial-failure path")
}
