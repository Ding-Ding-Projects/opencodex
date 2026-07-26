package platform

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	DefaultACLHardenTimeout = 5 * time.Second
	MinACLHardenTimeout     = time.Second
	MaxACLHardenTimeout     = time.Minute
)

var broadWindowsSIDs = []string{"*S-1-1-0", "*S-1-5-11", "*S-1-5-32-545"}

type ACLCommandResult struct {
	Success  bool
	ExitCode int
	TimedOut bool
	Stdout   string
	Err      error
}

type ACLRunner func(args []string, timeout time.Duration) ACLCommandResult

type HardenSecretOptions struct {
	Required  bool
	Directory bool
	Platform  string
	Username  string
	Domain    string
	Timeout   time.Duration
	Runner    ACLRunner
	Now       func() time.Time
}

type HardenSecretResult struct {
	OK          bool   `json:"ok"`
	Diagnostics string `json:"diagnostics,omitempty"`
}

var aclHardenState = struct {
	sync.Mutex
	hardened map[string]bool
	timedOut map[string]bool
}{hardened: map[string]bool{}, timedOut: map[string]bool{}}

// HardenSecretPath preserves the original fail-closed write-path contract.
// A genuine icacls timeout is the sole soft failure so credential writes do
// not hang indefinitely; all other Windows failures are returned.
func HardenSecretPath(path string, directory bool) error {
	_, err := HardenSecretPathWithOptions(path, HardenSecretOptions{Required: true, Directory: directory})
	return err
}

func HardenSecretPathWithOptions(path string, options HardenSecretOptions) (HardenSecretResult, error) {
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		return HardenSecretResult{OK: true}, nil
	} else if err != nil {
		return HardenSecretResult{}, errors.New("inspect secret path failed")
	}
	platform := options.Platform
	if platform == "" {
		platform = runtime.GOOS
	}
	if platform != "windows" {
		return HardenSecretResult{OK: true}, nil
	}
	key := path + "\x00" + strconv.FormatBool(options.Directory)
	aclHardenState.Lock()
	if aclHardenState.hardened[key] {
		aclHardenState.Unlock()
		return HardenSecretResult{OK: true}, nil
	}
	if aclHardenState.timedOut[key] {
		aclHardenState.Unlock()
		return HardenSecretResult{Diagnostics: "ACL hardening skipped — previous attempt timed out"}, nil
	}
	aclHardenState.Unlock()

	now := options.Now
	if now == nil {
		now = time.Now
	}
	timeout := options.Timeout
	if timeout <= 0 {
		timeout = resolveACLHardenTimeout(os.Getenv("OPENCODEX_ACL_TIMEOUT_MS"))
	}
	deadline := now().Add(timeout)
	runner := options.Runner
	if runner == nil {
		runner = runICACLS
	}
	username, domain, err := resolveWindowsIdentity(options.Username, options.Domain)
	if err != nil {
		return aclHardenFailure(options.Required, "ACL hardening failed — current Windows user is unavailable", err)
	}
	identity := username
	if domain != "" {
		identity = domain + `\` + username
	}

	var last ACLCommandResult
	for attempt := 0; attempt < 2; attempt++ {
		if now().Before(deadline) {
			last = executeACLHardening(path, identity, options.Directory, deadline, now, runner)
		} else {
			last = ACLCommandResult{TimedOut: true, Err: context.DeadlineExceeded}
		}
		if last.Success {
			aclHardenState.Lock()
			aclHardenState.hardened[key] = true
			aclHardenState.Unlock()
			return HardenSecretResult{OK: true}, nil
		}
		if !last.TimedOut {
			break
		}
	}
	diagnostic := sanitizeACLDiagnostic(last)
	if last.TimedOut {
		aclHardenState.Lock()
		aclHardenState.timedOut[key] = true
		aclHardenState.Unlock()
		state := describeACLAfterTimeout(path, deadline, now, runner)
		return HardenSecretResult{Diagnostics: diagnostic + "; " + state}, nil
	}
	return aclHardenFailure(options.Required, diagnostic, last.Err)
}

func executeACLHardening(path, identity string, directory bool, deadline time.Time, now func() time.Time, runner ACLRunner) ACLCommandResult {
	run := func(args ...string) ACLCommandResult {
		remaining := deadline.Sub(now())
		if remaining <= 0 {
			return ACLCommandResult{TimedOut: true, Err: context.DeadlineExceeded}
		}
		return runner(args, remaining)
	}
	if result := run(path, "/inheritance:r"); !result.Success {
		return result
	}
	removeArgs := append([]string{path, "/remove:g"}, broadWindowsSIDs...)
	if removal := run(removeArgs...); !removal.Success {
		if removal.TimedOut {
			return removal
		}
		for _, sid := range broadWindowsSIDs {
			found := run(path, "/findsid", sid)
			if !found.Success {
				return found
			}
			if strings.Contains(found.Stdout, path) {
				return removal
			}
		}
	}
	grant := identity + ":(F)"
	if directory {
		grant = identity + ":(OI)(CI)(F)"
	}
	return run(path, "/grant:r", grant)
}

func describeACLAfterTimeout(path string, deadline time.Time, now func() time.Time, runner ACLRunner) string {
	for _, sid := range broadWindowsSIDs {
		remaining := deadline.Sub(now())
		if remaining <= 0 {
			return "ACL state unverified (budget exhausted)"
		}
		found := runner([]string{path, "/findsid", sid}, remaining)
		if !found.Success {
			return "ACL state unverified (probe failed)"
		}
		if strings.Contains(found.Stdout, path) {
			return "broad ACL grants still present"
		}
	}
	return "no broad ACL grants detected (hardening still incomplete)"
}

func runICACLS(args []string, timeout time.Duration) ACLCommandResult {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	command := exec.CommandContext(ctx, "icacls.exe", args...)
	output, err := command.Output()
	if err == nil {
		return ACLCommandResult{Success: true, Stdout: string(output)}
	}
	result := ACLCommandResult{Stdout: string(output), Err: err, TimedOut: errors.Is(ctx.Err(), context.DeadlineExceeded)}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		result.ExitCode = exit.ExitCode()
		result.Stdout += string(exit.Stderr)
	}
	return result
}

func resolveWindowsIdentity(username, domain string) (string, string, error) {
	if username == "" {
		if current, err := user.Current(); err == nil {
			username = current.Username
		}
	}
	if username == "" {
		username = os.Getenv("USERNAME")
	}
	if domain == "" {
		domain = os.Getenv("USERDOMAIN")
	}
	if separator := strings.LastIndexAny(username, `\/`); separator >= 0 {
		if domain == "" {
			domain = username[:separator]
		}
		username = username[separator+1:]
	}
	if strings.TrimSpace(username) == "" {
		return "", "", errors.New("missing Windows username")
	}
	return username, domain, nil
}

func resolveACLHardenTimeout(raw string) time.Duration {
	milliseconds, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
	if err != nil {
		return DefaultACLHardenTimeout
	}
	timeout := time.Duration(milliseconds) * time.Millisecond
	if timeout < MinACLHardenTimeout {
		return MinACLHardenTimeout
	}
	if timeout > MaxACLHardenTimeout {
		return MaxACLHardenTimeout
	}
	return timeout
}

func sanitizeACLDiagnostic(result ACLCommandResult) string {
	switch {
	case result.TimedOut:
		return "ACL hardening timed out (ETIMEDOUT) — transient icacls stall; the volume may still support per-user NTFS ACLs"
	case errors.Is(result.Err, os.ErrPermission):
		return "ACL hardening failed (EACCES) — permission denied running icacls"
	default:
		return fmt.Sprintf("ACL hardening failed (EICACLS, exit=%d) — icacls command error; filesystem may not support per-user NTFS ACLs", result.ExitCode)
	}
}

func aclHardenFailure(required bool, diagnostic string, cause error) (HardenSecretResult, error) {
	result := HardenSecretResult{Diagnostics: diagnostic}
	if !required {
		return result, nil
	}
	if cause == nil {
		cause = errors.New("icacls failed")
	}
	return result, fmt.Errorf("%s: %w", diagnostic, cause)
}

func ResetACLHardenStateForTests() {
	aclHardenState.Lock()
	aclHardenState.hardened = map[string]bool{}
	aclHardenState.timedOut = map[string]bool{}
	aclHardenState.Unlock()
}
