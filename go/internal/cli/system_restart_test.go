package cli

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/server"
	"github.com/lidge-jun/opencodex-go/internal/service"
)

type restartOutcome struct {
	spawned  int
	recycled int
	cleared  int
	warnings []string
}

func (o *restartOutcome) control(supervised bool, spawnErr error) restartControl {
	return restartControl{
		supervised:         func() bool { return supervised },
		spawnStart:         func(int) error { o.spawned++; return spawnErr },
		markRecycle:        func() { o.recycled++ },
		clearServiceMarker: func() { o.cleared++ },
		warn:               func(message string) { o.warnings = append(o.warnings, message) },
	}
}

// A failure-only supervisor ignores a clean exit, so the deliberate non-zero
// code is the only thing that brings the proxy back.
func TestASupervisedChildExitsNonZeroWithoutSpawning(t *testing.T) {
	outcome := &restartOutcome{}
	if code := outcome.control(true, nil).run(10100); code != 1 {
		t.Fatalf("exit code = %d, want 1", code)
	}
	if outcome.spawned != 0 {
		t.Fatal("a supervised child spawned its own replacement, so two proxies would race for the port")
	}
	// Matching the oracle: the supervisor starts a fresh configured child that
	// installs the system environment itself, so this process does not hold
	// the recycle latch. The Codex and Grok fences are protected separately by
	// OCX_SERVICE, which their cleanup checks on its own.
	if outcome.recycled != 0 {
		t.Fatal("a supervised restart marked recycling; the supervisor's child configures itself")
	}
}

// The ordinary case: spawn the replacement, keep the fences for it, exit clean.
func TestAnUnsupervisedRestartSpawnsThenMarksRecyclingBeforeExitingZero(t *testing.T) {
	outcome := &restartOutcome{}
	if code := outcome.control(false, nil).run(10100); code != 0 {
		t.Fatalf("exit code = %d, want 0", code)
	}
	if outcome.spawned != 1 {
		t.Fatalf("spawns = %d", outcome.spawned)
	}
	if outcome.recycled != 1 {
		t.Fatal("the replacement was started but recycling was not marked; exit cleanup would strip the injection it inherits")
	}
}

// The fail-closed branch, and the one that matters most: the listen socket is
// already closed, so if the replacement never started there is nothing to
// inherit the fences. Marking recycling here would leave Codex pointed at a
// dead port with no proxy behind it.
func TestAFailedSpawnDoesNotMarkRecyclingAndClearsTheServiceMarker(t *testing.T) {
	outcome := &restartOutcome{}
	if code := outcome.control(false, syscall.ENOENT).run(10100); code != 1 {
		t.Fatalf("exit code = %d, want 1", code)
	}
	if outcome.recycled != 0 {
		t.Fatal("a failed spawn marked recycling; Codex would be left pointed at a dead port")
	}
	// ensure/tray children carry OCX_SERVICE=1 without a real supervisor, so
	// it has to be cleared or exit cleanup skips restoring Codex and Grok.
	if outcome.cleared != 1 {
		t.Fatalf("service marker clears = %d", outcome.cleared)
	}
}

// Spawn failures are logged as a stable code and never as the raw message: an
// ENOENT from exec embeds the binary path, which on most machines contains the
// user's name.
func TestSpawnFailuresAreLoggedAsACodeNotAPath(t *testing.T) {
	outcome := &restartOutcome{}
	pathError := &os.PathError{Op: "fork/exec", Path: "/Users/somebody/.bun/bin/ocx", Err: syscall.ENOENT}
	outcome.control(false, pathError).run(10100)
	if len(outcome.warnings) != 1 {
		t.Fatalf("warnings = %v", outcome.warnings)
	}
	warning := outcome.warnings[0]
	if !strings.Contains(warning, "ENOENT") {
		t.Fatalf("warning did not carry the errno: %q", warning)
	}
	if strings.Contains(warning, "somebody") || strings.Contains(warning, "/Users/") {
		t.Fatalf("the warning leaked a path: %q", warning)
	}
}

// An error shape nobody anticipated must still produce a safe label rather than
// falling through to the raw text.
func TestAnUnrecognizedSpawnFailureGetsAGenericLabel(t *testing.T) {
	if code := spawnFailureCode(errors.New("/Users/somebody/bin/ocx: permission problem")); code != "spawn_failed" {
		t.Fatalf("code = %q, want the generic label", code)
	}
	for errno, want := range map[syscall.Errno]string{
		syscall.ENOENT: "ENOENT", syscall.EACCES: "EACCES", syscall.EPERM: "EPERM",
	} {
		if code := spawnFailureCode(errno); code != want {
			t.Fatalf("%v produced %q, want %q", errno, code, want)
		}
	}
}

// The marker alone is not proof of a supervisor: ensure and tray set it too,
// and exiting 1 under those would simply stop the proxy with nothing to
// restart it.
func TestTheServiceMarkerAloneIsNotTreatedAsSupervision(t *testing.T) {
	t.Setenv("OCX_SERVICE", "1")
	t.Setenv("OPENCODEX_HOME", t.TempDir())
	t.Setenv("HOME", t.TempDir())
	if supervisedServiceChild() {
		t.Fatal("the marker alone was treated as supervision; a recycle would exit 1 with nothing to restart it")
	}
}

// And without the marker at all.
func TestNoMarkerIsNotSupervision(t *testing.T) {
	t.Setenv("OCX_SERVICE", "")
	if supervisedServiceChild() {
		t.Fatal("an unmarked process was treated as supervised")
	}
}

// The recycle latch is what keeps exit cleanup from undoing the injection the
// replacement is about to use.
// A real recycle through serveListener: the restart signal has to drain, close
// the listener, spawn, and carry the exit code out. Driving restartControl
// directly cannot see any of that, which is why this exercises the actual
// serve loop.
func TestARecycleDrivenThroughServeListenerCarriesItsExitCode(t *testing.T) {
	for name, testCase := range map[string]struct {
		spawnErr error
		wantCode int
	}{
		"successful respawn": {wantCode: 0},
		"failed respawn":     {spawnErr: syscall.ENOENT, wantCode: 1},
	} {
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		port := listener.Addr().(*net.TCPAddr).Port
		httpServer := &http.Server{Handler: http.NotFoundHandler()}
		requests := make(chan restartRequest, 1)
		requests <- restartRequest{timeout: time.Second}

		outcome := &restartOutcome{}
		control := outcome.control(false, testCase.spawnErr)
		serveErr := serveListener(httpServer, server.NewLifecycle(), listener, nil, nil, nil, requests, control, port)

		if testCase.wantCode == 0 {
			if serveErr != nil {
				t.Fatalf("%s: serve returned %v, want a clean exit", name, serveErr)
			}
		} else {
			var restart *restartExitError
			if !errors.As(serveErr, &restart) || restart.code != testCase.wantCode {
				t.Fatalf("%s: serve returned %v, want exit code %d", name, serveErr, testCase.wantCode)
			}
		}
		if outcome.spawned != 1 {
			t.Fatalf("%s: spawns = %d", name, outcome.spawned)
		}
		// The port must be free: the replacement binds it, and a listener still
		// held here would make its startup fail.
		probe, err := net.Listen("tcp", listener.Addr().String())
		if err != nil {
			t.Fatalf("%s: the port was still bound after the drain: %v", name, err)
		}
		_ = probe.Close()
	}
}

func TestTheRecycleLatchIsOffUntilAReplacementStarts(t *testing.T) {
	recycling.Store(false)
	t.Cleanup(func() { recycling.Store(false) })
	if IsRecycling() {
		t.Fatal("the latch started set")
	}
	outcome := &restartOutcome{}
	control := outcome.control(false, syscall.ENOENT)
	control.markRecycle = MarkRecycling
	control.run(10100)
	if IsRecycling() {
		t.Fatal("a failed spawn set the recycle latch; exit cleanup would preserve injection with no proxy behind it")
	}
	control = outcome.control(false, nil)
	control.markRecycle = MarkRecycling
	control.run(10100)
	if !IsRecycling() {
		t.Fatal("a successful spawn did not set the latch; the replacement would lose its injection")
	}
}

// A recycle must preserve the fences the replacement inherits, and the source
// is the only place that ordering is visible: these deferred cleanups run at
// process exit, which a test cannot reach without ending its own process.
//
// Measured against the oracle (src/cli/index.ts:238): recycling skips
// revertSystemEnv and stripGrokConfig but STILL removes the pid/port files, so
// a stale runtime file cannot outlive the process that wrote it.
func TestRecycleAwareCleanupMatchesTheOracle(t *testing.T) {
	source, err := os.ReadFile("serve.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(source)

	for _, guarded := range []string{
		"if !IsRecycling() {\n\t\t\t\tteardownOwnedGrokFence(streams)",
		"if !IsRecycling() {\n\t\t\t\t_ = uninstallSystemEnv(context.Background())",
	} {
		if !strings.Contains(text, guarded) {
			t.Fatalf("a cleanup that must survive a recycle is no longer guarded:\n%s", guarded)
		}
	}

	// The runtime files are deliberately NOT guarded: the oracle removes them
	// even when recycling, and leaving a stale port file behind would point
	// clients at a process that has exited.
	index := strings.Index(text, "defer removeRuntimeFiles()")
	if index < 0 {
		t.Fatal("the runtime files are no longer removed on exit")
	}
	if strings.Contains(text[index:index+80], "IsRecycling") {
		t.Fatal("runtime file removal was made recycle-aware; the oracle removes them regardless")
	}
}

// The positive case, which the negative tests alone cannot pin: a guard stuck
// at false would pass them all while quietly spawning a second proxy that
// races the supervisor for the port.
func TestARecordedServiceForThisHomeIsSupervision(t *testing.T) {
	home := t.TempDir()
	codexHome := t.TempDir()
	t.Setenv("OCX_SERVICE", "1")
	t.Setenv("OPENCODEX_HOME", home)
	t.Setenv("CODEX_HOME", codexHome)

	state := service.InstallState{Version: 2, CodexHome: codexHome, OpenCodexHome: home, Backend: service.BackendNative}
	encoded, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "service-state.json"), encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	if !supervisedServiceChild() {
		t.Fatal("a recorded service for this exact home was not recognized as supervision; the recycle would spawn a rival proxy")
	}

	// And the same state written for a DIFFERENT home is not supervision here:
	// that service watches another process, so exiting 1 would leave this one
	// stopped with nothing to bring it back.
	foreign := service.InstallState{Version: 2, CodexHome: t.TempDir(), OpenCodexHome: t.TempDir(), Backend: service.BackendNative}
	encoded, err = json.Marshal(foreign)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "service-state.json"), encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	if supervisedServiceChild() {
		t.Fatal("a service installed for another home was treated as supervising this process")
	}
}

// The exit code a restart chooses has to actually reach the process exit.
//
// This test exists because my first attempt stored it in a package variable
// nothing read — the same "finished but unreachable" shape this port has
// shipped repeatedly. Routing it through the error return means Run must
// handle it, and this proves Run does.
func TestARestartExitCodeReachesTheProcessExit(t *testing.T) {
	for _, code := range []int{0, 1} {
		handler := func(context.Context, []string, IO) error {
			if code == 0 {
				return nil
			}
			return &restartExitError{code: code}
		}
		if got := runWithHandler(t, handler); got != code {
			t.Fatalf("a restart wanting exit %d produced %d", code, got)
		}
	}
}

// A restart exit must not be reported as a command failure: a recycle is the
// normal outcome of pressing the button, not an error the user should read.
func TestARestartExitIsNotReportedAsAnError(t *testing.T) {
	var errOutput strings.Builder
	streams := IO{Out: io.Discard, Err: &errOutput}
	if code := reportRestart(t, streams, &restartExitError{code: 1}); code != 1 {
		t.Fatalf("exit code = %d", code)
	}
	if strings.Contains(errOutput.String(), "Error:") {
		t.Fatalf("a recycle printed a failure line: %q", errOutput.String())
	}
}

func runWithHandler(t *testing.T, handler func(context.Context, []string, IO) error) int {
	t.Helper()
	return reportRestartWithHandler(t, IO{Out: io.Discard, Err: io.Discard}, handler)
}

func reportRestart(t *testing.T, streams IO, err error) int {
	t.Helper()
	return reportRestartWithHandler(t, streams, func(context.Context, []string, IO) error { return err })
}

// reportRestartWithHandler swaps one command's handler so the real Run path is
// exercised rather than a copy of its logic.
func reportRestartWithHandler(t *testing.T, streams IO, handler func(context.Context, []string, IO) error) int {
	t.Helper()
	position, ok := commandIndex["version"]
	if !ok {
		t.Fatal("the version command is missing")
	}
	original := commandSpecs[position].Handler
	commandSpecs[position].Handler = handler
	t.Cleanup(func() { commandSpecs[position].Handler = original })
	return Run(context.Background(), []string{"version"}, streams)
}
