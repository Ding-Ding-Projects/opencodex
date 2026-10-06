package lib

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime/debug"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/platform"
)

var diagnosticURLPattern = regexp.MustCompile(`https?://[^\s<>()]+`)

// CrashEntryOptions carries process activity that helps correlate a recovered
// panic with sidecar work without persisting request bodies or credentials.
type CrashEntryOptions struct {
	At       time.Time
	Promise  string
	Tracker  *SidecarTracker
	Activity *ActivityBreadcrumb
}

// FormatCrashEntry creates the secret-redacted crash.log record used by the
// long-running proxy safety net.
func FormatCrashEntry(kind string, recovered any, stack []byte, options CrashEntryOptions) string {
	at := options.At
	if at.IsZero() {
		at = time.Now()
	}
	detail := redactCrashText(fmt.Sprint(recovered))
	if err, ok := recovered.(error); ok {
		detail = fmt.Sprintf("%T: %s", err, redactCrashText(err.Error()))
	}
	var out strings.Builder
	fmt.Fprintf(&out, "\n[%s] %s\n%s", at.UTC().Format(time.RFC3339Nano), kind, detail)
	if len(stack) > 0 {
		fmt.Fprintf(&out, "\n%s", redactCrashText(string(stack)))
	}
	if promise := strings.TrimSpace(options.Promise); promise != "" {
		fmt.Fprintf(&out, "\n  promise: %s", redactCrashText(strings.Join(strings.Fields(promise), " ")))
	}
	tracker := options.Tracker
	if tracker == nil {
		tracker = DefaultSidecarTracker
	}
	if tracker != nil {
		crumb := tracker.Breadcrumb()
		if crumb.InFlight > 0 || crumb.LastLabel != "" {
			fmt.Fprintf(&out, "\n  sidecar: inFlight=%d last=%s sinceMs=%d", crumb.InFlight, emptyDash(crumb.LastLabel), crumb.SinceMS)
		}
		activity := tracker.Activity()
		if options.Activity != nil {
			activity = *options.Activity
		}
		if activity.Note != "" {
			fmt.Fprintf(&out, "\n  activity: %s sinceMs=%d", redactCrashText(activity.Note), activity.SinceMS)
		}
	}
	out.WriteByte('\n')
	return out.String()
}

func redactCrashText(value string) string {
	value = diagnosticURLPattern.ReplaceAllStringFunc(value, RedactURLForLog)
	return RedactSecretString(value)
}

func emptyDash(value string) string {
	if value == "" {
		return "-"
	}
	return RedactSecretString(value)
}

// AppendCrashEntry persists one crash record with private file permissions.
func AppendCrashEntry(logPath, entry string) error {
	if strings.TrimSpace(logPath) == "" {
		return errors.New("crash log path is empty")
	}
	if err := os.MkdirAll(filepath.Dir(logPath), 0o700); err != nil {
		return err
	}
	file, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if err := file.Chmod(0o600); err != nil {
		_ = file.Close()
		return err
	}
	if _, err := file.WriteString(entry); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	// Chmod(0o600) above is a POSIX-only promise: on Windows it only flips
	// the DOS read-only attribute, so a writable crash log always reports
	// back as 0666 regardless of the mode requested. FormatCrashEntry
	// redacts what it recognizes, but the whole point of this test
	// (TestCrashEntryRedactsAndIncludesBreadcrumbs) is that a crash entry
	// can still carry sensitive request context; leaving the log world-
	// readable on Windows defeats that. HardenSecretPath strips the broad
	// Everyone/Users/Authenticated-Users ACEs via icacls there and is a
	// no-op elsewhere -- memoized per path, so appending to the same log
	// repeatedly costs one real icacls call, not one per crash. Closed
	// first, matching the lesson from internal/codex's account store: an
	// icacls call is a separate process, not a same-handle op, but nothing
	// here depends on finding out the hard way which Windows operations
	// tolerate a still-open handle and which do not.
	return platform.HardenSecretPath(logPath, false)
}

// RecoverCrash returns a defer-friendly panic guard. Go cannot safely continue
// the panicking goroutine at the fault site, but the caller's containing server
// boundary can recover, log, and keep serving other requests.
func RecoverCrash(logPath, kind string, tracker *SidecarTracker) func() {
	return func() {
		recovered := recover()
		if recovered == nil {
			return
		}
		entry := FormatCrashEntry(kind, recovered, debug.Stack(), CrashEntryOptions{Tracker: tracker})
		_ = AppendCrashEntry(logPath, entry)
	}
}

// RunGuarded executes one process-root or goroutine-root function, records a
// redacted crash entry if it panics, and reports whether recovery occurred.
// Callers retain control over their exit/restart policy after recovery.
func RunGuarded(logPath, kind string, tracker *SidecarTracker, run func()) (crashed bool, err error) {
	if run == nil {
		return false, errors.New("guarded function is required")
	}
	defer func() {
		recovered := recover()
		if recovered == nil {
			return
		}
		crashed = true
		entry := FormatCrashEntry(kind, recovered, debug.Stack(), CrashEntryOptions{Tracker: tracker})
		err = AppendCrashEntry(logPath, entry)
	}()
	run()
	return false, nil
}
