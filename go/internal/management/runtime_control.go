package management

import (
	"context"
	"net/http"
	"runtime"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/config"
)

type RuntimeControlBackend interface {
	StartupHealth(context.Context) (map[string]any, error)
	RunStartupAction(context.Context, string) (string, error)
	WindowsTray(context.Context, string) (map[string]any, error)
	SyncModels(context.Context) (map[string]any, error)
	CheckUpdate(context.Context, string) (map[string]any, error)
	StartUpdate(context.Context, string, bool) (map[string]any, error)
	UpdateStatus(context.Context, string) (map[string]any, bool, error)
}

func (a *API) handleRuntimeControl(w http.ResponseWriter, r *http.Request) bool {
	switch r.Method + " " + r.URL.Path {
	case "GET /api/windows-tray":
		if runtime.GOOS != "windows" {
			writeJSON(w, 200, orderedJSONObject{{name: "supported", value: false}, {name: "installed", value: false}, {name: "running", value: false}, {name: "stale", value: false}, {name: "summary", value: "unsupported on " + runtime.GOOS}})
			return true
		}
		if a.runtimeControl == nil {
			writeError(w, 501, "Runtime control is not configured")
			return true
		}
		status, err := a.runtimeControl.WindowsTray(r.Context(), "status")
		if err != nil {
			writeBackendError(w, err, "Windows tray status failed")
			return true
		}
		writeJSON(w, 200, safeRuntimeValue(status))
		return true
	case "POST /api/windows-tray":
		var body struct {
			Action string `json:"action"`
		}
		if !decodeJSON(w, r, &body) {
			return true
		}
		if body.Action != "install" && body.Action != "start" && body.Action != "stop" && body.Action != "uninstall" {
			writeError(w, 400, "action must be install, start, stop, or uninstall")
			return true
		}
		if runtime.GOOS != "windows" {
			writeError(w, 400, "Windows tray is only supported on Windows")
			return true
		}
		if a.runtimeControl == nil {
			writeError(w, 501, "Runtime control is not configured")
			return true
		}
		status, err := a.runtimeControl.WindowsTray(r.Context(), body.Action)
		if err != nil {
			writeBackendError(w, err, "Windows tray action failed")
			return true
		}
		writeJSON(w, 200, orderedJSONObject{{name: "ok", value: true}, {name: "status", value: safeRuntimeValue(status)}})
		return true
	}
	if a.runtimeControl == nil {
		for _, prefix := range []string{"/api/startup-health", "/api/startup-action", "/api/sync", "/api/update/"} {
			if strings.HasPrefix(r.URL.Path, prefix) {
				writeError(w, 501, "Runtime control is not configured")
				return true
			}
		}
		return false
	}
	switch r.Method + " " + r.URL.Path {
	case "GET /api/startup-health":
		result, err := a.runtimeControl.StartupHealth(r.Context())
		if err != nil {
			writeBackendError(w, err, "Startup health failed")
			return true
		}
		writeJSON(w, 200, safeRuntimeValue(result))
	case "POST /api/startup-action":
		var body struct {
			Action string `json:"action"`
		}
		if !decodeJSON(w, r, &body) {
			return true
		}
		if body.Action != "install-service" && body.Action != "install-shim" {
			writeError(w, 400, "action must be install-service or install-shim")
			return true
		}
		message, err := a.runtimeControl.RunStartupAction(r.Context(), body.Action)
		if err != nil {
			writeBackendError(w, err, "Startup action failed")
			return true
		}
		writeJSON(w, 200, orderedJSONObject{{name: "ok", value: true}, {name: "action", value: body.Action}, {name: "message", value: message}})
	case "POST /api/sync":
		result, err := a.runtimeControl.SyncModels(r.Context())
		if err != nil {
			writeBackendError(w, err, "Model sync failed")
			return true
		}
		result = safeRuntimeValue(result).(map[string]any)
		result["staleAppServerHint"] = "If Codex App still shows an older model list, restart its long-lived app-server process after sync."
		status := 200
		if ok, exists := result["ok"].(bool); exists && !ok {
			status = 500
		}
		writeJSON(w, status, result)
	case "GET /api/update/check":
		channel, ok := updateChannel(w, r.URL.Query().Get("tag"))
		if !ok {
			return true
		}
		result, err := a.runtimeControl.CheckUpdate(r.Context(), channel)
		if err != nil {
			writeBackendError(w, err, "Update check failed")
			return true
		}
		writeJSON(w, 200, safeRuntimeValue(result))
	case "POST /api/update/run":
		var body struct {
			Tag     string `json:"tag,omitempty"`
			Restart *bool  `json:"restart,omitempty"`
		}
		if !decodeJSON(w, r, &body) {
			return true
		}
		channel, ok := updateChannel(w, body.Tag)
		if !ok {
			return true
		}
		restart := true
		if body.Restart != nil {
			restart = *body.Restart
		}
		job, err := a.runtimeControl.StartUpdate(r.Context(), channel, restart)
		if err != nil {
			writeBackendError(w, err, "Update could not start")
			return true
		}
		writeJSON(w, 200, orderedJSONObject{{name: "ok", value: true}, {name: "job", value: safeRuntimeValue(job)}})
	case "GET /api/update/status":
		job, found, err := a.runtimeControl.UpdateStatus(r.Context(), r.URL.Query().Get("jobId"))
		if err != nil {
			writeBackendError(w, err, "Update status failed")
			return true
		}
		if !found {
			writeError(w, 404, "update job not found")
			return true
		}
		writeJSON(w, 200, orderedJSONObject{{name: "ok", value: true}, {name: "job", value: safeRuntimeValue(job)}})
	default:
		return false
	}
	return true
}

func updateChannel(w http.ResponseWriter, value string) (string, bool) {
	if value != "" && value != "latest" && value != "preview" {
		writeError(w, 400, "tag must be latest or preview")
		return "", false
	}
	if value == "" {
		value = "latest"
	}
	return value, true
}

func safeRuntimeValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		result := make(map[string]any, len(typed))
		for key, item := range typed {
			lower := strings.ToLower(key)
			if strings.Contains(lower, "token") || strings.Contains(lower, "apikey") || strings.Contains(lower, "api_key") || strings.Contains(lower, "secret") || strings.Contains(lower, "accountid") || strings.Contains(lower, "account_id") {
				continue
			}
			result[key] = safeRuntimeValue(item)
		}
		return result
	case []any:
		result := make([]any, len(typed))
		for i := range typed {
			result[i] = safeRuntimeValue(typed[i])
		}
		return result
	case string:
		return redactRuntimeString(typed)
	default:
		return value
	}
}

func redactRuntimeString(value string) string { return config.RedactString(value) }
