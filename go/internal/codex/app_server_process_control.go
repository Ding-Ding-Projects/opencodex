package codex

import (
	"os"
	"syscall"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/platform"
)

// The default IO seams for app-server termination. Split out so the pure matching and
// formatting logic in app_server_processes.go stays free of process control.

func platformProcessAlive(pid int) bool { return platform.ProcessAlive(pid) }

func signalProcess(pid int, signal syscall.Signal) error {
	process, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return process.Signal(signal)
}

// waitForProcessExit polls until the process is gone or the budget runs out, mirroring the
// oracle's 50ms poll. A non-positive budget still performs one liveness check.
func waitForProcessExit(pid int, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for {
		if !platformProcessAlive(pid) {
			return true
		}
		if !time.Now().Before(deadline) {
			return !platformProcessAlive(pid)
		}
		time.Sleep(50 * time.Millisecond)
	}
}
