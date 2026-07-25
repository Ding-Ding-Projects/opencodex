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
	defer file.Close()
	if err := file.Chmod(0o600); err != nil {
		return err
	}
	_, err = file.WriteString(entry)
	return err
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
