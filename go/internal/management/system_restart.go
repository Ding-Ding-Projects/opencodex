package management

// Drain-and-restart for the dashboard's memory card.
//
// Longer than the ordinary stop drain and deliberately NOT a teardown: this is
// a recycle to reclaim memory, so Codex injection and the Grok fence must
// survive it. The management layer only accepts the request and schedules the
// work; the process control itself is injected, because a management handler
// that could spawn processes on its own is a much larger surface than one that
// calls a function the CLI handed it.

import (
	"net/http"
	"time"
)

// MemoryDrainRestartMS is the fixed drain window for this action. Not
// config-driven: it is a bound on how long the dashboard waits, not a tuning
// knob.
const MemoryDrainRestartMS = 60_000

// responseFlushDelay lets the 202 reach the client before the drain starts
// closing things underneath it.
const responseFlushDelay = 200 * time.Millisecond

// RestartBackend is the injected process control.
//
// Drain must not return until in-flight turns are done or the window expires.
// Restart owns the supervised/unsupervised decision and never returns on
// success, because it ends the process.
type RestartBackend struct {
	BeginDrain  func()
	IsDraining  func() bool
	ActiveTurns func() int
	Drain       func(timeout time.Duration)
	Restart     func()
	// Schedule is a test seam. Production passes nil and gets a real timer.
	Schedule func(func(), time.Duration)
}

func (a *API) handleSystemRestart(w http.ResponseWriter, _ *http.Request) bool {
	backend := a.restart
	if backend == nil || backend.Restart == nil {
		writeError(w, http.StatusServiceUnavailable, "restart control is not configured")
		return true
	}
	active := 0
	if backend.ActiveTurns != nil {
		active = backend.ActiveTurns()
	}
	// CompareAndSwap, not load-then-store: two requests arriving together can
	// both read false before either writes, and would then each schedule a
	// drain and a respawn.
	accepted := a.restartAccepted.CompareAndSwap(false, true)
	alreadyDraining := !accepted
	if accepted && backend.IsDraining != nil && backend.IsDraining() {
		// A drain was already running for some other reason; report it rather
		// than starting a second one.
		alreadyDraining = true
	}

	message := "Draining in-flight requests, then restarting."
	if alreadyDraining {
		message = "Drain already in progress."
	} else {
		// Reject new data-plane traffic IMMEDIATELY, before the flush delay.
		// Waiting would accept turns that the drain is about to abort.
		if backend.BeginDrain != nil {
			backend.BeginDrain()
		}
		schedule := backend.Schedule
		if schedule == nil {
			schedule = func(fn func(), delay time.Duration) { time.AfterFunc(delay, fn) }
		}
		schedule(func() {
			if backend.Drain != nil {
				backend.Drain(MemoryDrainRestartMS * time.Millisecond)
			}
			backend.Restart()
		}, responseFlushDelay)
	}

	writeJSON(w, http.StatusAccepted, map[string]any{
		"success": true, "message": message,
		"activeTurnCount": active, "drainTimeoutMs": MemoryDrainRestartMS,
		"alreadyDraining": alreadyDraining,
	})
	return true
}
