package management

import (
	"net/http"
	"os"
	"runtime"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/platform"
)

var processStarted = time.Now()

func (a *API) handleSystem(w http.ResponseWriter, r *http.Request) bool {
	if r.URL.Path == "/api/system/restart" && r.Method == http.MethodPost {
		return a.handleSystemRestart(w, r)
	}
	if r.URL.Path == "/api/system/restart" && r.Method == http.MethodGet {
		active := 0
		if a.restart != nil && a.restart.ActiveTurns != nil {
			active = a.restart.ActiveTurns()
		}
		writeJSON(w, http.StatusOK, map[string]any{"available": a.restart != nil && a.restart.Restart != nil, "alreadyDraining": a.restart != nil && a.restart.IsDraining != nil && a.restart.IsDraining(), "activeTurnCount": active})
		return true
	}
	if r.Method != http.MethodGet {
		return false
	}
	switch r.URL.Path {
	case "/api/system/memory":
		var stats runtime.MemStats
		runtime.ReadMemStats(&stats)
		a.mu.RLock()
		mode := a.config.StreamMode
		a.mu.RUnlock()
		var watchdog any
		if a.memoryWatchdog != nil {
			watchdog = map[string]any{"samples": a.memoryWatchdog()}
		}
		var responseState any = map[string]any{"count": 0, "totalBytes": 0, "largestBytes": 0, "oldestAgeMs": 0}
		if a.responseState != nil {
			responseState = a.responseState()
		}
		// MemStats.Sys is reserved address space, not residency, so ask the OS and
		// keep Sys only for platforms without a probe.
		rss := stats.Sys
		if resident, ok := platform.ResidentSetSize(); ok {
			rss = resident
		}
		writeJSON(w, http.StatusOK, map[string]any{"pid": os.Getpid(), "goVersion": runtime.Version(), "platform": runtime.GOOS, "uptimeSeconds": time.Since(processStarted).Seconds(), "rss": rss, "heapUsed": stats.HeapAlloc, "heapTotal": stats.HeapSys, "goroutines": runtime.NumGoroutine(), "responseState": responseState, "streamMode": mode, "watchdog": watchdog})
		return true
	}
	return false
}
