package management

import (
	"net/http"
	"os"
	"runtime"
	"time"
)

var processStarted = time.Now()

func (a *API) handleSystem(w http.ResponseWriter, r *http.Request) bool {
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
		writeJSON(w, http.StatusOK, map[string]any{"pid": os.Getpid(), "goVersion": runtime.Version(), "platform": runtime.GOOS, "uptimeSeconds": time.Since(processStarted).Seconds(), "rss": stats.Sys, "heapUsed": stats.HeapAlloc, "heapTotal": stats.HeapSys, "goroutines": runtime.NumGoroutine(), "responseState": responseState, "streamMode": mode, "watchdog": watchdog})
		return true
	}
	return false
}
