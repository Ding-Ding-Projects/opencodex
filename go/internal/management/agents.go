package management

import (
	"net/http"
	"strings"
)

var allowedEfforts = map[string]bool{"low": true, "medium": true, "high": true, "xhigh": true, "max": true, "ultra": true}
var effortList = []string{"low", "medium", "high", "xhigh", "max", "ultra"}

func (a *API) handleAgents(w http.ResponseWriter, r *http.Request) bool {
	switch r.URL.Path {
	case "/api/subagent-models":
		if r.Method == http.MethodGet {
			a.mu.RLock()
			models := append([]string(nil), a.agents.Models...)
			a.mu.RUnlock()
			if models == nil {
				models = []string{}
			}
			// `available` is what the picker can offer. Without it the GUI selector
			// renders empty and silently offers nothing (oracle:
			// agent-settings-routes.ts:335).
			writeJSON(w, http.StatusOK, orderedJSONObject{
				{name: "chosen", value: models},
				{name: "available", value: a.availableModelsExcludingDisabled()},
			})
			return true
		}
		if r.Method == http.MethodPut {
			var body struct {
				Models []string `json:"models"`
			}
			if !decodeJSON(w, r, &body) {
				return true
			}
			body.Models = uniqueStrings(body.Models)
			if len(body.Models) > 5 {
				body.Models = body.Models[:5]
			}
			a.mu.Lock()
			previousAgents := cloneAgentSettings(a.agents)
			previousModels := append([]string(nil), a.config.SubagentModels...)
			a.agents.Models = append([]string(nil), body.Models...)
			a.config.SubagentModels = append([]string(nil), body.Models...)
			err := a.saveLocked()
			if err != nil {
				a.agents = previousAgents
				a.config.SubagentModels = previousModels
			}
			a.mu.Unlock()
			if err != nil {
				writeError(w, http.StatusInternalServerError, "save subagent models failed")
				return true
			}
			// The generated ~/.claude/agents/*.md files ARE the roster: leaving them stale
			// means the models the user just chose cannot be dispatched, while a removed one
			// still can (oracle: syncClaudeAgentDefsBestEffort, agent-settings-routes.ts:345).
			a.syncClaudeAgentDefinitions(r)
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "applied": body.Models})
			return true
		}
	case "/api/injection-model":
		if r.Method == http.MethodGet {
			a.mu.RLock()
			settings := a.agents
			a.mu.RUnlock()
			writeJSON(w, http.StatusOK, map[string]any{"multiAgentGuidanceEnabled": settings.GuidanceEnabled == nil || *settings.GuidanceEnabled, "model": nullable(settings.InjectionModel), "effort": nullable(settings.InjectionEffort), "prompt": nullable(settings.InjectionPrompt), "efforts": effortList, "available": a.availableModelsExcludingDisabled()})
			return true
		}
		if r.Method == http.MethodPut {
			var body struct {
				MultiAgentGuidanceEnabled *bool   `json:"multiAgentGuidanceEnabled,omitempty"`
				Model                     *string `json:"model,omitempty"`
				Effort                    *string `json:"effort,omitempty"`
				Prompt                    *string `json:"prompt,omitempty"`
			}
			if !decodeJSON(w, r, &body) {
				return true
			}
			a.mu.RLock()
			candidate := cloneAgentSettings(a.agents)
			a.mu.RUnlock()
			if body.Model != nil {
				candidate.InjectionModel = strings.TrimSpace(*body.Model)
				if candidate.InjectionModel == "" {
					candidate.InjectionEffort = ""
				}
			}
			if body.Effort != nil {
				value := strings.TrimSpace(*body.Effort)
				if value != "" && !allowedEfforts[value] {
					writeError(w, http.StatusBadRequest, "unknown reasoning effort")
					return true
				}
				if candidate.InjectionModel == "" && value != "" {
					writeError(w, http.StatusBadRequest, "effort requires a model")
					return true
				}
				candidate.InjectionEffort = value
			}
			if body.Prompt != nil {
				value := strings.TrimSpace(*body.Prompt)
				if len(value) > 16<<10 {
					writeError(w, http.StatusBadRequest, "prompt is too long")
					return true
				}
				candidate.InjectionPrompt = value
			}
			if body.MultiAgentGuidanceEnabled != nil {
				value := *body.MultiAgentGuidanceEnabled
				candidate.GuidanceEnabled = &value
			}
			a.mu.Lock()
			previous := cloneAgentSettings(a.agents)
			previousModel, previousEffort := a.config.InjectionModel, a.config.InjectionEffort
			previousPrompt, previousGuidance := a.config.InjectionPrompt, a.config.MultiAgentGuidanceEnabled
			a.agents = candidate
			a.config.InjectionModel = candidate.InjectionModel
			a.config.InjectionEffort = candidate.InjectionEffort
			a.config.InjectionPrompt = candidate.InjectionPrompt
			a.config.MultiAgentGuidanceEnabled = candidate.GuidanceEnabled
			err := a.saveLocked()
			if err != nil {
				a.agents = previous
				a.config.InjectionModel, a.config.InjectionEffort = previousModel, previousEffort
				a.config.InjectionPrompt, a.config.MultiAgentGuidanceEnabled = previousPrompt, previousGuidance
			}
			a.mu.Unlock()
			if err != nil {
				writeError(w, http.StatusInternalServerError, "save injection settings failed")
				return true
			}
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "multiAgentGuidanceEnabled": candidate.GuidanceEnabled == nil || *candidate.GuidanceEnabled, "model": nullable(candidate.InjectionModel), "effort": nullable(candidate.InjectionEffort), "prompt": nullable(candidate.InjectionPrompt)})
			return true
		}
	case "/api/effort-caps":
		if r.Method == http.MethodGet {
			a.mu.RLock()
			settings := a.agents
			a.mu.RUnlock()
			writeJSON(w, http.StatusOK, orderedJSONObject{{name: "effortCap", value: nullable(settings.EffortCap)}, {name: "subagentEffortCap", value: nullable(settings.SubagentEffortCap)}, {name: "efforts", value: effortList}})
			return true
		}
		if r.Method == http.MethodPut {
			var body struct {
				EffortCap         *string `json:"effortCap,omitempty"`
				SubagentEffortCap *string `json:"subagentEffortCap,omitempty"`
			}
			if !decodeJSON(w, r, &body) {
				return true
			}
			for _, value := range []*string{body.EffortCap, body.SubagentEffortCap} {
				if value != nil && *value != "" && !allowedEfforts[*value] {
					writeError(w, http.StatusBadRequest, "unknown reasoning effort")
					return true
				}
			}
			a.mu.Lock()
			previous := cloneAgentSettings(a.agents)
			previousEffortCap, previousSubagentEffortCap := a.config.EffortCap, a.config.SubagentEffortCap
			if body.EffortCap != nil {
				a.agents.EffortCap = *body.EffortCap
			}
			if body.SubagentEffortCap != nil {
				a.agents.SubagentEffortCap = *body.SubagentEffortCap
			}
			a.config.EffortCap = a.agents.EffortCap
			a.config.SubagentEffortCap = a.agents.SubagentEffortCap
			err := a.saveLocked()
			if err != nil {
				a.agents = previous
				a.config.EffortCap, a.config.SubagentEffortCap = previousEffortCap, previousSubagentEffortCap
			}
			settings := cloneAgentSettings(a.agents)
			a.mu.Unlock()
			if err != nil {
				writeError(w, http.StatusInternalServerError, "save effort caps failed")
				return true
			}
			writeJSON(w, http.StatusOK, orderedJSONObject{{name: "ok", value: true}, {name: "effortCap", value: nullable(settings.EffortCap)}, {name: "subagentEffortCap", value: nullable(settings.SubagentEffortCap)}})
			return true
		}
	case "/api/v2":
		if r.Method == http.MethodGet {
			a.mu.RLock()
			settings := a.agents
			a.mu.RUnlock()
			writeJSON(w, http.StatusOK, map[string]any{"enabled": settings.MultiAgentMode == "v2", "multiAgentMode": settings.MultiAgentMode, "maxConcurrentThreadsPerSession": settings.MaxConcurrency})
			return true
		}
		if r.Method == http.MethodPut {
			var body struct {
				Enabled        *bool   `json:"enabled,omitempty"`
				MultiAgentMode *string `json:"multiAgentMode,omitempty"`
				MaxConcurrency *int    `json:"maxConcurrentThreadsPerSession,omitempty"`
			}
			if !decodeJSON(w, r, &body) {
				return true
			}
			if body.MultiAgentMode != nil && *body.MultiAgentMode != "v1" && *body.MultiAgentMode != "v2" && *body.MultiAgentMode != "default" {
				writeError(w, http.StatusBadRequest, "multiAgentMode must be v1, default, or v2")
				return true
			}
			if body.MaxConcurrency != nil && *body.MaxConcurrency < 1 {
				writeError(w, http.StatusBadRequest, "max concurrency must be at least 1")
				return true
			}
			if body.Enabled != nil && body.MultiAgentMode != nil && ((*body.Enabled && *body.MultiAgentMode == "v1") || (!*body.Enabled && *body.MultiAgentMode == "v2")) {
				writeError(w, http.StatusBadRequest, "enabled conflicts with multiAgentMode")
				return true
			}
			a.mu.Lock()
			previous := cloneAgentSettings(a.agents)
			previousMode := a.config.MultiAgentMode
			if body.MultiAgentMode != nil {
				a.agents.MultiAgentMode = *body.MultiAgentMode
			} else if body.Enabled != nil {
				if *body.Enabled {
					a.agents.MultiAgentMode = "v2"
				} else {
					a.agents.MultiAgentMode = "v1"
				}
			}
			if body.MaxConcurrency != nil {
				a.agents.MaxConcurrency = *body.MaxConcurrency
			}
			if settingsMode := a.agents.MultiAgentMode; settingsMode == "default" {
				a.config.MultiAgentMode = ""
			} else {
				a.config.MultiAgentMode = settingsMode
			}
			err := a.saveLocked()
			if err != nil {
				a.agents = previous
				a.config.MultiAgentMode = previousMode
			}
			settings := cloneAgentSettings(a.agents)
			a.mu.Unlock()
			if err != nil {
				writeError(w, http.StatusInternalServerError, "save multi-agent settings failed")
				return true
			}
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "enabled": settings.MultiAgentMode == "v2", "multiAgentMode": settings.MultiAgentMode, "maxConcurrentThreadsPerSession": settings.MaxConcurrency})
			return true
		}
	}
	return false
}

func nullable(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func cloneAgentSettings(value AgentSettings) AgentSettings {
	value.Models = append([]string(nil), value.Models...)
	if value.GuidanceEnabled != nil {
		enabled := *value.GuidanceEnabled
		value.GuidanceEnabled = &enabled
	}
	return value
}

// syncClaudeAgentDefinitions regenerates the Claude Code agent files best-effort. The
// runtime is absent in tests and in servers assembled without it, so the nil check is load
// bearing rather than defensive.
func (a *API) syncClaudeAgentDefinitions(r *http.Request) {
	if a.claudeRuntime == nil {
		return
	}
	// Inside a serialized mutation the config lock is held for writing and the sync would
	// deadlock on its own snapshot, so defer to ServeHTTP, which runs it after the release.
	if pending, ok := r.Context().Value(claudeAgentSyncKey{}).(*bool); ok && pending != nil {
		*pending = true
		return
	}
	a.runClaudeAgentSync(r)
}

func (a *API) runClaudeAgentSync(r *http.Request) {
	if a.claudeRuntime == nil {
		return
	}
	// The sync deletes and rewrites a whole directory of files. Two of them interleaving --
	// which the deferred execution makes possible, since it runs outside the config lock --
	// can leave a mix of two rosters on disk.
	a.claudeAgentSyncMu.Lock()
	defer a.claudeAgentSyncMu.Unlock()
	_ = a.claudeRuntime.SyncClaudeAgentDefinitions(r.Context())
}
