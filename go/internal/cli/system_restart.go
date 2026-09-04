package cli

// The drain-and-restart backend behind POST /api/system/restart.
//
// This is a RECYCLE, not a teardown: the point is to reclaim memory while
// Codex stays pointed at a working proxy. So the ordinary stop cleanup, which
// restores native Codex and tears down the Grok fence, must not run on the
// success path — the replacement process inherits those.

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/management"
	"github.com/lidge-jun/opencodex-go/internal/server"
)

// recycling latches when a replacement process has actually been started.
//
// Exit cleanup reads it to decide whether to restore native Codex and tear
// down the Grok fence. On a recycle it must NOT: the replacement inherits
// them, and undoing them would point Codex at a port that is about to be
// served again.
var recycling atomic.Bool

// MarkRecycling records that a replacement is running.
func MarkRecycling() { recycling.Store(true) }

// IsRecycling reports whether exit cleanup should preserve injection.
func IsRecycling() bool { return recycling.Load() }

// restartControl is the process-level half, injected so the tests never spawn
// anything and never call os.Exit.
type restartControl struct {
	supervised         func() bool
	spawnStart         func(port int) error
	markRecycle        func()
	clearServiceMarker func()
	exit               func(int)
	warn               func(string)
}

// restartRequest is the signal handed back to the serve owner.
//
// The management handler cannot finish a restart on its own: the replacement
// must not be spawned until this process has released the port, and every
// cleanup in runServe is a deferred function that os.Exit would skip. So the
// backend only ASKS, and serveListener performs the shutdown and then the
// respawn on its way out.
type restartRequest struct {
	timeout time.Duration
}

func configuredRestart(lifecycle *server.Lifecycle, requests chan<- restartRequest) *management.RestartBackend {
	return &management.RestartBackend{
		BeginDrain:  lifecycle.BeginDrain,
		IsDraining:  lifecycle.IsDraining,
		ActiveTurns: lifecycle.Active,
		// Drain is a no-op here: the serve owner drains, because only it can
		// also close the listener. Draining twice would just make the first
		// wait pointless.
		Drain: func(time.Duration) {},
		Restart: func() {
			select {
			case requests <- restartRequest{timeout: MemoryDrainRestart}:
			default:
				// A restart is already in flight; a second signal would only
				// queue a redundant respawn.
			}
		},
	}
}

// MemoryDrainRestart is the drain window for this action, as a duration.
const MemoryDrainRestart = management.MemoryDrainRestartMS * time.Millisecond

func newRestartControl(streams IO) restartControl {
	return restartControl{
		supervised:         supervisedServiceChild,
		spawnStart:         spawnDetachedStart,
		markRecycle:        MarkRecycling,
		clearServiceMarker: func() { _ = os.Unsetenv("OCX_SERVICE") },
		exit:               os.Exit,
		warn:               func(message string) { fmt.Fprintln(streams.Err, message) },
	}
}

// run decides the restart outcome and returns the exit code the serve owner
// should use.
//
// It does NOT call exit itself: os.Exit skips every deferred cleanup in
// runServe, which is precisely the cleanup the failure path depends on.
// Returning lets the caller unwind normally.
func (c restartControl) run(port int) int {
	if c.supervised() {
		// Failure-only supervisors (systemd Restart=on-failure, WinSW
		// onfailure, the Task Scheduler ERRORLEVEL loop) ignore a clean exit,
		// so a deliberate non-zero code is what brings the proxy back.
		//
		// Deliberately NOT marked as a recycle, matching the oracle: a
		// supervisor starts a fresh configured child rather than inheriting
		// this process, and that child installs the system environment itself.
		// The Codex and Grok fences are already protected here by OCX_SERVICE,
		// which their cleanup checks independently.
		return 1
	}
	if err := c.spawnStart(port); err != nil {
		// The listen socket is already closed, so there is nothing to recover
		// to. Do NOT mark recycling: no child exists to inherit the fences, and
		// keeping them would leave Codex pointed at a dead port.
		//
		// ensure/tray children inherit OCX_SERVICE=1 without a real installed
		// service, so clear it and let the ordinary exit cleanup restore
		// Codex and Grok.
		c.clearServiceMarker()
		c.warn("⚠️  Drain-and-restart spawn failed (" + spawnFailureCode(err) + "); exiting without replacement")
		return 1
	}
	c.markRecycle()
	return 0
}

// spawnFailureCode returns a stable, path-free label.
//
// The raw message is deliberately never logged: an ENOENT from exec usually
// embeds the full binary path, which on most machines contains the OS username.
func spawnFailureCode(err error) string {
	var errno syscall.Errno
	if errors.As(err, &errno) {
		if name := errnoName(errno); name != "" {
			return name
		}
	}
	var pathErr *os.PathError
	if errors.As(err, &pathErr) {
		if inner, ok := pathErr.Err.(syscall.Errno); ok {
			if name := errnoName(inner); name != "" {
				return name
			}
		}
	}
	if errors.Is(err, exec.ErrNotFound) {
		return "ENOENT"
	}
	return "spawn_failed"
}

func errnoName(errno syscall.Errno) string {
	switch errno {
	case syscall.ENOENT:
		return "ENOENT"
	case syscall.EACCES:
		return "EACCES"
	case syscall.EPERM:
		return "EPERM"
	case syscall.ENOMEM:
		return "ENOMEM"
	case syscall.EAGAIN:
		return "EAGAIN"
	}
	return ""
}

// supervisedServiceChild reports whether a real installed service is watching
// this process.
//
// Three conditions, because getting this wrong is expensive in both
// directions: a false positive exits 1 with nothing to restart the proxy, and
// a false negative spawns a second proxy that races the supervisor's own
// restart for the port.
//
//   - the marker, which ensure and tray also set, so it is necessary but far
//     from sufficient;
//   - recorded install state, which is how this machine remembers a service
//     was installed;
//   - and that the state's baked-in homes MATCH the ones this process is
//     running under. A state file left behind by an uninstall, or one written
//     for a different CODEX_HOME, describes a supervisor that is not watching
//     this process.
//
// RECORDED DIVERGENCE, deliberately not closed here: the oracle asks the
// platform (diagnoseService().installed) rather than only the recorded state,
// so it also catches a service that was removed without clearing the file.
// Go's platform diagnostic is Windows-only today, and porting a cross-platform
// one is its own slice. The residual risk is narrow — a state file for THIS
// home surviving a removal — and its cost is an exit 1 with no replacement,
// which a supervisor-less user recovers from by starting the proxy again.
func supervisedServiceChild() bool {
	if os.Getenv("OCX_SERVICE") != "1" {
		return false
	}
	state := readServiceInstallState()
	if state == nil {
		return false
	}
	home, err := configDir()
	if err != nil {
		return false
	}
	return state.EnvironmentMatches(codexHomePath(), home)
}

// spawnDetachedStart launches the replacement on the SAME port.
//
// `start` rather than `ensure`, because ensure is gated on codexAutoStart and a
// recycle must not depend on a user preference that governs first launch.
func spawnDetachedStart(port int) error {
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	args := []string{"start"}
	if port > 0 && port <= 65535 {
		args = append(args, "--port", strconv.Itoa(port))
	}
	command := exec.Command(executable, args...)
	command.Env = append(os.Environ(), "OCX_SERVICE=1")
	command.Stdin, command.Stdout, command.Stderr = nil, io.Discard, io.Discard
	configureUpdateWorkerProcess(command)
	if err := command.Start(); err != nil {
		return err
	}
	// Released rather than waited on: the replacement outlives this process,
	// and reaping it here would tie the new proxy's lifetime to the old one.
	return command.Process.Release()
}
