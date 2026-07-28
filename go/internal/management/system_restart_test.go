package management

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/config"
)

type restartProbe struct {
	drainBegun  atomic.Bool
	drained     atomic.Int64
	restarted   atomic.Int32
	scheduled   func()
	scheduleGap time.Duration
	active      int
	draining    bool
}

func (p *restartProbe) backend() *RestartBackend {
	return &RestartBackend{
		BeginDrain:  func() { p.drainBegun.Store(true) },
		IsDraining:  func() bool { return p.draining },
		ActiveTurns: func() int { return p.active },
		Drain:       func(timeout time.Duration) { p.drained.Store(int64(timeout)) },
		Restart:     func() { p.restarted.Add(1) },
		Schedule: func(fn func(), delay time.Duration) {
			p.scheduled, p.scheduleGap = fn, delay
		},
	}
}

func postRestart(t *testing.T, api *API) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/system/restart", nil)
	if !api.handleSystem(recorder, request) {
		t.Fatal("the restart route was not handled")
	}
	var body map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("response body: %v", err)
	}
	return recorder, body
}

func restartAPI(t *testing.T, probe *restartProbe) *API {
	t.Helper()
	api, err := NewAPI(Options{
		Config:  &config.Config{Port: 10100, Providers: map[string]config.ProviderConfig{}},
		Restart: probe.backend(),
	})
	if err != nil {
		t.Fatal(err)
	}
	return api
}

// The whole point of the accept-then-schedule shape: the 202 has to reach the
// dashboard before the drain starts closing things underneath it.
func TestRestartIsAcceptedAndScheduledRatherThanRunInline(t *testing.T) {
	probe := &restartProbe{active: 3}
	recorder, body := postRestart(t, restartAPI(t, probe))

	if recorder.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202", recorder.Code)
	}
	if body["success"] != true || body["alreadyDraining"] != false {
		t.Fatalf("body = %#v", body)
	}
	if body["activeTurnCount"] != float64(3) || body["drainTimeoutMs"] != float64(MemoryDrainRestartMS) {
		t.Fatalf("body = %#v", body)
	}
	// Nothing has drained or restarted yet — only the rejection is armed.
	if probe.drained.Load() != 0 || probe.restarted.Load() != 0 {
		t.Fatalf("work ran inline: drained=%d restarted=%d", probe.drained.Load(), probe.restarted.Load())
	}
	if probe.scheduled == nil || probe.scheduleGap != responseFlushDelay {
		t.Fatalf("scheduled=%v gap=%v", probe.scheduled != nil, probe.scheduleGap)
	}
}

// New data-plane traffic must be refused BEFORE the flush delay. Waiting would
// accept turns the drain is about to abort, which is a worse experience than a
// clean 503 the client can retry.
func TestDrainingIsArmedBeforeTheFlushDelay(t *testing.T) {
	probe := &restartProbe{}
	postRestart(t, restartAPI(t, probe))
	if !probe.drainBegun.Load() {
		t.Fatal("the data plane was still accepting traffic after the request was accepted")
	}
}

// The scheduled half drains for the fixed window and then restarts.
func TestTheScheduledWorkDrainsThenRestarts(t *testing.T) {
	probe := &restartProbe{}
	postRestart(t, restartAPI(t, probe))
	probe.scheduled()
	if probe.drained.Load() != int64(MemoryDrainRestartMS*time.Millisecond) {
		t.Fatalf("drain timeout = %v, want %v", time.Duration(probe.drained.Load()), MemoryDrainRestartMS*time.Millisecond)
	}
	if probe.restarted.Load() != 1 {
		t.Fatalf("restarts = %d", probe.restarted.Load())
	}
}

// Two clicks a moment apart must not schedule two drains. IsDraining only
// becomes true once the drain runs, so the latch is what covers the gap.
func TestASecondRequestReportsTheDrainRatherThanSchedulingAnother(t *testing.T) {
	probe := &restartProbe{active: 1}
	api := restartAPI(t, probe)
	postRestart(t, api)
	first := probe.scheduled
	probe.scheduled = nil

	_, body := postRestart(t, api)
	if body["alreadyDraining"] != true {
		t.Fatalf("second response = %#v", body)
	}
	if body["message"] != "Drain already in progress." {
		t.Fatalf("message = %#v", body["message"])
	}
	if probe.scheduled != nil {
		t.Fatal("a second drain was scheduled")
	}
	// The first one still works.
	first()
	if probe.restarted.Load() != 1 {
		t.Fatalf("restarts = %d", probe.restarted.Load())
	}
}

// A drain already running for another reason is reported, not restarted over.
func TestAnExistingDrainIsReportedWithoutScheduling(t *testing.T) {
	probe := &restartProbe{draining: true, active: 2}
	_, body := postRestart(t, restartAPI(t, probe))
	if body["alreadyDraining"] != true || probe.scheduled != nil {
		t.Fatalf("body=%#v scheduled=%v", body, probe.scheduled != nil)
	}
	if probe.drainBegun.Load() {
		t.Fatal("an already-draining server was told to begin draining again")
	}
}

// Without a backend the route must refuse rather than accept a restart it
// cannot perform — a 202 that never restarts is worse than an honest error.
func TestWithoutABackendTheRouteRefuses(t *testing.T) {
	api, err := NewAPI(Options{Config: &config.Config{Port: 10100, Providers: map[string]config.ProviderConfig{}}})
	if err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	if !api.handleSystem(recorder, httptest.NewRequest(http.MethodPost, "/api/system/restart", nil)) {
		t.Fatal("the route was not handled")
	}
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", recorder.Code)
	}
}

// GET must not restart anything.
func TestOnlyPOSTRestarts(t *testing.T) {
	probe := &restartProbe{}
	api := restartAPI(t, probe)
	recorder := httptest.NewRecorder()
	api.handleSystem(recorder, httptest.NewRequest(http.MethodGet, "/api/system/restart", nil))
	if probe.drainBegun.Load() || probe.scheduled != nil {
		t.Fatal("a GET began a drain")
	}
}

// Two clicks landing together must not both schedule. A load-then-store gate
// lets both read false before either writes, and the user gets two drains and
// two respawns racing for one port.
func TestConcurrentRequestsScheduleExactlyOneRestart(t *testing.T) {
	var scheduled atomic.Int32
	probe := &restartProbe{}
	backend := probe.backend()
	backend.Schedule = func(fn func(), _ time.Duration) { scheduled.Add(1) }
	api, err := NewAPI(Options{
		Config:  &config.Config{Port: 10100, Providers: map[string]config.ProviderConfig{}},
		Restart: backend,
	})
	if err != nil {
		t.Fatal(err)
	}

	const callers = 32
	start := make(chan struct{})
	var done sync.WaitGroup
	done.Add(callers)
	for index := 0; index < callers; index++ {
		go func() {
			defer done.Done()
			<-start
			api.handleSystem(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/api/system/restart", nil))
		}()
	}
	close(start)
	done.Wait()

	if got := scheduled.Load(); got != 1 {
		t.Fatalf("%d restarts were scheduled by %d concurrent requests, want exactly 1", got, callers)
	}
}
