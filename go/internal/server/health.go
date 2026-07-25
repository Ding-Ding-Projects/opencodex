package server

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"time"
)

const readinessCheckTimeout = 2 * time.Second

// HealthChecks exposes readiness separately from process liveness. Dependency
// failures remove the process from service without triggering restart loops.
type HealthChecks struct {
	Started time.Time
	Version string
	Checks  map[string]func(context.Context) error
}

func NewHealthChecks(version string, checks map[string]func(context.Context) error) *HealthChecks {
	return &HealthChecks{Started: time.Now(), Version: version, Checks: checks}
}

func (h *HealthChecks) Ready(w http.ResponseWriter, r *http.Request) {
	names := make([]string, 0, len(h.Checks))
	for name := range h.Checks {
		names = append(names, name)
	}
	sort.Strings(names)
	results := make(map[string]string, len(names))
	status := http.StatusOK
	for _, name := range names {
		ctx, cancel := context.WithTimeout(r.Context(), readinessCheckTimeout)
		err := h.Checks[name](ctx)
		cancel()
		if err != nil {
			results[name] = "unavailable"
			status = http.StatusServiceUnavailable
		} else {
			results[name] = "ok"
		}
	}
	writeHealthJSON(w, status, map[string]any{"status": map[bool]string{true: "ready", false: "not_ready"}[status == http.StatusOK], "checks": results})
}

func (h *HealthChecks) Startup(w http.ResponseWriter, _ *http.Request) {
	writeHealthJSON(w, http.StatusOK, map[string]any{"status": "started", "version": h.Version, "uptime": time.Since(h.Started).Seconds()})
}

func writeHealthJSON(w http.ResponseWriter, status int, body map[string]any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
