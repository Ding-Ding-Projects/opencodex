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
		writeJSON(w, http.StatusOK, map[string]any{"pid": os.Getpid(), "goVersion": runtime.Version(), "platform": runtime.GOOS, "uptimeSeconds": time.Since(processStarted).Seconds(), "rss": stats.Sys, "heapUsed": stats.HeapAlloc, "heapTotal": stats.HeapSys, "goroutines": runtime.NumGoroutine(), "streamMode": mode, "watchdog": watchdog})
		return true
	}
	return false
}
