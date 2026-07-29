package management

import (
	"net/http"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/codex"
	appconfig "github.com/lidge-jun/opencodex-go/internal/config"
)

func (a *API) handleConfig(w http.ResponseWriter, r *http.Request) bool {
	switch r.Method + " " + r.URL.Path {
	case "GET /api/config":
		a.mu.RLock()
		defer a.mu.RUnlock()
		writeJSON(w, http.StatusOK, safeConfig(a.config))
		return true
	case "PUT /api/config":
		writeError(w, http.StatusMethodNotAllowed, "Full config PUT is disabled. Use provider and settings routes.")
		return true
	case "GET /api/settings":
		a.mu.RLock()
		settings := orderedJSONObject{
			{name: "codexAutoStart", value: codexAutoStart(a.config.CodexAutoStart)},
			{name: "port", value: a.config.Port},
			{name: "hostname", value: a.config.Host},
			{name: "streamMode", value: defaultStreamMode(a.config.StreamMode)},
		}
		a.mu.RUnlock()
		// The dashboard seeds its startup badge from here before the dedicated probe answers,
		// so omitting it left the badge unseeded and the first paint wrong
		// (oracle: src/server/management/config-routes.ts:117).
		if a.runtimeControl != nil {
			if health, err := a.runtimeControl.StartupHealth(r.Context()); err == nil && health != nil {
				settings = append(settings, orderedJSONField{name: "startupHealth", value: health})
			}
		}
		writeJSON(w, http.StatusOK, settings)
		return true
	case "PUT /api/settings":
		var body struct {
			CodexAutoStart *bool   `json:"codexAutoStart,omitempty"`
			StreamMode     *string `json:"streamMode,omitempty"`
		}
		if !decodeJSON(w, r, &body) {
			return true
		}
		if body.StreamMode == nil && body.CodexAutoStart == nil {
			writeError(w, http.StatusBadRequest, "codexAutoStart and/or streamMode is required")
			return true
		}
		if body.StreamMode != nil && *body.StreamMode != "auto" && *body.StreamMode != "legacy-tee" && *body.StreamMode != "eager-relay" {
			writeError(w, http.StatusBadRequest, "streamMode must be auto, legacy-tee, or eager-relay")
			return true
		}
		a.mu.Lock()
		if body.StreamMode != nil {
			a.config.StreamMode = *body.StreamMode
		}
		if body.CodexAutoStart != nil {
			value := *body.CodexAutoStart
			a.config.CodexAutoStart = &value
		}
		err := a.saveLocked()
		a.mu.Unlock()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "save settings failed")
			return true
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "codexAutoStart": codexAutoStart(a.config.CodexAutoStart), "streamMode": defaultStreamMode(a.config.StreamMode)})
		return true
	case "GET /api/diagnostics/project-config":
		// This route reports PROJECT Codex configs that route around the proxy -- not ocx
		// config validation. The dashboard renders `grouped`; warnings carries the raw rows.
		warnings, grouped := codex.CachedProjectConfigDiagnostics()
		if warnings == nil {
			warnings = []codex.ProjectConfigWarning{}
		}
		if grouped == nil {
			grouped = []codex.ProjectConfigWarningGroup{}
		}
		writeJSON(w, http.StatusOK, map[string]any{"warnings": warnings, "grouped": grouped})
		return true
	case "GET /api/sidecar-settings":
		a.mu.RLock()
		response := sidecarSettingsDTO(a.config)
		a.mu.RUnlock()
		writeJSON(w, http.StatusOK, response)
		return true
	case "PUT /api/sidecar-settings":
		return a.updateSidecarSettings(w, r)
	}
	return false
}

func codexAutoStart(value *bool) bool { return value == nil || *value }
func defaultStreamMode(value string) string {
	if value == "" {
		return "auto"
	}
	return value
}

func sidecarSettingsDTO(config *appconfig.Config) orderedJSONObject {
	webModel, webBackend := "gpt-5.6-luna", ""
	if config.WebSearchSidecar != nil {
		if config.WebSearchSidecar.Model != "" {
			webModel = config.WebSearchSidecar.Model
		}
		webBackend = config.WebSearchSidecar.Backend
	}
	visionModel, visionBackend, maxDescriptions := "gpt-5.6-luna", "", 0
	if config.VisionSidecar != nil {
		if config.VisionSidecar.Model != "" {
			visionModel = config.VisionSidecar.Model
		}
		visionBackend, maxDescriptions = config.VisionSidecar.Backend, config.VisionSidecar.MaxDescriptionsPerTurn
	}
	webSearch := orderedJSONObject{{name: "model", value: webModel}}
	if webBackend != "" {
		webSearch = append(webSearch, orderedJSONField{name: "backend", value: webBackend})
	}
	vision := orderedJSONObject{{name: "model", value: visionModel}}
	if visionBackend != "" {
		vision = append(vision, orderedJSONField{name: "backend", value: visionBackend})
	}
	if maxDescriptions > 0 {
		vision = append(vision, orderedJSONField{name: "maxDescriptionsPerTurn", value: maxDescriptions})
	}
	return orderedJSONObject{
		{name: "webSearch", value: webSearch},
		{name: "vision", value: vision},
	}
}

func (a *API) updateSidecarSettings(w http.ResponseWriter, r *http.Request) bool {
	type webSearchPatch struct {
		Model     *string `json:"model,omitempty"`
		Backend   *string `json:"backend,omitempty"`
		Reasoning *string `json:"reasoning,omitempty"`
	}
	type visionPatch struct {
		Model                  *string `json:"model,omitempty"`
		Backend                *string `json:"backend,omitempty"`
		MaxDescriptionsPerTurn *int    `json:"maxDescriptionsPerTurn,omitempty"`
	}
	var body struct {
		WebSearch *webSearchPatch `json:"webSearch,omitempty"`
		Vision    *visionPatch    `json:"vision,omitempty"`
	}
	if !decodeJSON(w, r, &body) {
		return true
	}
	if body.WebSearch == nil && body.Vision == nil {
		writeError(w, http.StatusBadRequest, "webSearch and/or vision object is required")
		return true
	}
	validBackend := func(value string) bool { return value == "" || value == "openai" || value == "anthropic" }
	if body.WebSearch != nil {
		if body.WebSearch.Backend != nil && !validBackend(strings.TrimSpace(*body.WebSearch.Backend)) {
			writeError(w, http.StatusBadRequest, "webSearch.backend must be openai, anthropic, or empty")
			return true
		}
		if body.WebSearch.Model != nil && len(*body.WebSearch.Model) > 512 {
			writeError(w, http.StatusBadRequest, "webSearch.model is too long")
			return true
		}
	}
	if body.Vision != nil {
		if body.Vision.Backend != nil && !validBackend(strings.TrimSpace(*body.Vision.Backend)) {
			writeError(w, http.StatusBadRequest, "vision.backend must be openai, anthropic, or empty")
			return true
		}
		if body.Vision.MaxDescriptionsPerTurn != nil && *body.Vision.MaxDescriptionsPerTurn <= 0 {
			writeError(w, http.StatusBadRequest, "vision.maxDescriptionsPerTurn must be a positive integer")
			return true
		}
		if body.Vision.Model != nil && len(*body.Vision.Model) > 512 {
			writeError(w, http.StatusBadRequest, "vision.model is too long")
			return true
		}
	}
	a.mu.Lock()
	candidate := *a.config
	if body.WebSearch != nil {
		next := appconfig.WebSearchSidecarConfig{}
		if a.config.WebSearchSidecar != nil {
			next = *a.config.WebSearchSidecar
		}
		if body.WebSearch.Model != nil {
			next.Model = strings.TrimSpace(*body.WebSearch.Model)
		}
		if body.WebSearch.Backend != nil {
			next.Backend = strings.TrimSpace(*body.WebSearch.Backend)
		}
		if body.WebSearch.Reasoning != nil {
			next.Reasoning = strings.TrimSpace(*body.WebSearch.Reasoning)
		}
		candidate.WebSearchSidecar = &next
	}
	if body.Vision != nil {
		next := appconfig.VisionSidecarConfig{}
		if a.config.VisionSidecar != nil {
			next = *a.config.VisionSidecar
		}
		if body.Vision.Model != nil {
			next.Model = strings.TrimSpace(*body.Vision.Model)
		}
		if body.Vision.Backend != nil {
			next.Backend = strings.TrimSpace(*body.Vision.Backend)
		}
		if body.Vision.MaxDescriptionsPerTurn != nil {
			next.MaxDescriptionsPerTurn = *body.Vision.MaxDescriptionsPerTurn
		}
		candidate.VisionSidecar = &next
	}
	err := candidate.Validate()
	if err == nil {
		previous := *a.config
		*a.config = candidate
		err = a.saveLocked()
		if err != nil {
			*a.config = previous
		}
	}
	response := sidecarSettingsDTO(&candidate)
	a.mu.Unlock()
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return true
	}
	response = append(orderedJSONObject{{name: "ok", value: true}}, response...)
	writeJSON(w, http.StatusOK, response)
	return true
}
