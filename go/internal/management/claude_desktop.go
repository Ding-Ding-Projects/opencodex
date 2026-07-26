package management

import (
	"net"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/claude"
	"github.com/lidge-jun/opencodex-go/internal/codex"
	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

type claudeDesktopModelDTO struct {
	Route           string                   `json:"route"`
	Label           string                   `json:"label"`
	Available       bool                     `json:"available"`
	ContextWindow   int                      `json:"contextWindow,omitempty"`
	EffortSupported bool                     `json:"effortSupported"`
	Supports1M      bool                     `json:"supports1m"`
	Assignment      claude.DesktopAssignment `json:"assignment"`
}

type claudeDesktopState struct {
	Profile     claude.DesktopProfile         `json:"profile"`
	Models      []claudeDesktopModelDTO       `json:"models"`
	Rendered    []claude.RenderedDesktopModel `json:"rendered"`
	Port        int                           `json:"port"`
	NativeSlugs []string                      `json:"-"`
	Routed      []claude.Desktop3pRoutedModel `json:"-"`
}

func (a *API) handleClaudeDesktop(w http.ResponseWriter, r *http.Request) bool {
	switch r.URL.Path {
	case "/api/claude-desktop":
		if r.Method == http.MethodGet {
			state, err := a.buildClaudeDesktopState(nil)
			if err != nil {
				writeError(w, http.StatusBadRequest, err.Error())
				return true
			}
			state.Port = requestPort(r, state.Port)
			writeJSON(w, http.StatusOK, state)
			return true
		}
		if r.Method == http.MethodPut {
			a.putClaudeDesktop(w, r)
			return true
		}
	case "/api/claude-desktop/apply":
		if r.Method == http.MethodPost {
			a.applyClaudeDesktop(w, r)
			return true
		}
	case "/api/claude-desktop/status":
		if r.Method == http.MethodGet {
			a.getClaudeDesktopStatus(w)
			return true
		}
	}
	return false
}

func (a *API) putClaudeDesktop(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Profile any `json:"profile"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	next, err := claude.ParseDesktopProfile(body.Profile)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	current, err := a.buildClaudeDesktopState(nil)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var unavailable []string
	for _, model := range current.Models {
		if !model.Available {
			unavailable = append(unavailable, model.Route)
		}
	}
	if err := claude.ValidateDesktopProfileAvailability(current.Profile, next, unavailable); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	state, err := a.buildClaudeDesktopState(&next)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	a.mu.Lock()
	previous := a.config.ClaudeCode
	if a.config.ClaudeCode == nil {
		a.config.ClaudeCode = &config.ClaudeCodeConfig{}
	}
	profile := state.Profile.Clone()
	a.config.ClaudeCode.DesktopProfile = &profile
	err = a.saveClaudeDesktopLocked()
	if err != nil {
		a.config.ClaudeCode = previous
	}
	a.mu.Unlock()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "save Claude Desktop profile failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "profile": state.Profile, "models": state.Models, "rendered": state.Rendered, "port": requestPort(r, state.Port)})
}

func (a *API) applyClaudeDesktop(w http.ResponseWriter, r *http.Request) {
	state, err := a.buildClaudeDesktopState(nil)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	libraryPath, err := claude.DefaultDesktop3pLibraryPath()
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	apiKey := ""
	a.mu.RLock()
	if len(a.config.APIKeys) > 0 {
		apiKey = a.config.APIKeys[0].Key
	}
	a.mu.RUnlock()
	port := requestPort(r, state.Port)
	result, err := claude.ApplyDesktop3pConfig(libraryPath, port, state.NativeSlugs, state.Routed, apiKey, claude.Desktop3pStatic, &state.Profile)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	a.mu.Lock()
	if a.config.ClaudeCode == nil {
		a.config.ClaudeCode = &config.ClaudeCodeConfig{}
	}
	profile := state.Profile.Clone()
	profile.AppliedFingerprint = result.Fingerprint
	profile.AppliedAt = time.Now().UTC().Format(time.RFC3339)
	a.config.ClaudeCode.DesktopProfile = &profile
	err = a.saveClaudeDesktopLocked()
	a.mu.Unlock()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "persist Claude Desktop applied state failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "saved": true, "applied": true, "path": result.Path, "fingerprint": result.Fingerprint})
}

func (a *API) getClaudeDesktopStatus(w http.ResponseWriter) {
	libraryPath, err := claude.DefaultDesktop3pLibraryPath()
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	a.mu.RLock()
	fingerprint, appliedAt := "", ""
	if a.config.ClaudeCode != nil && a.config.ClaudeCode.DesktopProfile != nil {
		fingerprint = a.config.ClaudeCode.DesktopProfile.AppliedFingerprint
		appliedAt = a.config.ClaudeCode.DesktopProfile.AppliedAt
	}
	a.mu.RUnlock()
	writeJSON(w, http.StatusOK, claude.ReadDesktop3pStatus(libraryPath, fingerprint, appliedAt))
}

func (a *API) saveClaudeDesktopLocked() error {
	if a.configPath == "" {
		return nil
	}
	return config.Save(a.configPath, a.config)
}

func (a *API) autoApplyClaudeDesktopBestEffort() {
	a.mu.RLock()
	if a.config.ClaudeCode == nil || a.config.ClaudeCode.DesktopProfile == nil || a.config.ClaudeCode.DesktopAutoApply != nil && !*a.config.ClaudeCode.DesktopAutoApply {
		a.mu.RUnlock()
		return
	}
	a.mu.RUnlock()
	state, err := a.buildClaudeDesktopState(nil)
	if err != nil {
		return
	}
	libraryPath, err := claude.DefaultDesktop3pLibraryPath()
	if err != nil {
		return
	}
	a.mu.RLock()
	apiKey := ""
	if len(a.config.APIKeys) > 0 {
		apiKey = a.config.APIKeys[0].Key
	}
	a.mu.RUnlock()
	result, err := claude.ApplyDesktop3pConfig(libraryPath, state.Port, state.NativeSlugs, state.Routed, apiKey, claude.Desktop3pStatic, &state.Profile)
	if err != nil || result.Fingerprint == "" {
		return
	}
	a.mu.Lock()
	if a.config.ClaudeCode != nil && a.config.ClaudeCode.DesktopProfile != nil {
		a.config.ClaudeCode.DesktopProfile.AppliedFingerprint = result.Fingerprint
		a.config.ClaudeCode.DesktopProfile.AppliedAt = time.Now().UTC().Format(time.RFC3339)
		if a.configPath != "" {
			_ = config.Save(a.configPath, a.config)
		}
	}
	a.mu.Unlock()
}

func (a *API) buildClaudeDesktopState(stored *claude.DesktopProfile) (claudeDesktopState, error) {
	a.mu.RLock()
	cfg := *a.config
	if stored == nil && cfg.ClaudeCode != nil && cfg.ClaudeCode.DesktopProfile != nil {
		profile := cfg.ClaudeCode.DesktopProfile.Clone()
		stored = &profile
	}
	a.mu.RUnlock()
	models := []types.ModelEntry{}
	if a.registry != nil {
		models = codex.FilterVisibleRuntimeModels(a.registry.ListModels(), cfg)
	}
	disabled := make(map[string]bool, len(cfg.DisabledModels))
	for _, id := range cfg.DisabledModels {
		disabled[strings.TrimSpace(id)] = true
	}
	profileModels := make([]claude.DesktopProfileModel, 0, len(models))
	modelByRoute := make(map[string]types.ModelEntry, len(models))
	available := make(map[string]bool, len(models))
	var native []string
	var routed []claude.Desktop3pRoutedModel
	for _, model := range models {
		route, provider, id, nativeModel := desktopModelRoute(model)
		if route == "" || disabled[route] || disabled[model.ID] {
			continue
		}
		profileModels = append(profileModels, claude.DesktopProfileModel{Route: route, Label: desktopModelLabel(model, route), ContextWindow: model.ContextWindow})
		modelByRoute[route], available[route] = model, true
		if nativeModel {
			native = append(native, id)
		} else {
			routed = append(routed, claude.Desktop3pRoutedModel{Provider: provider, ID: id, ContextWindow: model.ContextWindow})
		}
	}
	var storedValue any
	if stored != nil {
		storedValue = *stored
	}
	profile, err := claude.ReconcileDesktopProfile(storedValue, profileModels)
	if err != nil {
		return claudeDesktopState{}, err
	}
	rendered, err := claude.RenderDesktopProfile(profile, profileModels)
	if err != nil {
		return claudeDesktopState{}, err
	}
	routes := make([]string, 0, len(profile.Assignments))
	for route := range profile.Assignments {
		routes = append(routes, route)
	}
	sort.Strings(routes)
	dtos := make([]claudeDesktopModelDTO, 0, len(routes))
	for _, route := range routes {
		model := modelByRoute[route]
		label := route
		if available[route] {
			label = desktopModelLabel(model, route)
		}
		dtos = append(dtos, claudeDesktopModelDTO{Route: route, Label: label, Available: available[route], ContextWindow: model.ContextWindow, EffortSupported: strings.HasPrefix(route, "native/") || len(model.ReasoningEfforts) > 0, Supports1M: model.ContextWindow >= claude.OneMillion, Assignment: profile.Assignments[route]})
	}
	return claudeDesktopState{Profile: profile, Models: dtos, Rendered: rendered, Port: cfg.Port, NativeSlugs: native, Routed: routed}, nil
}

func desktopModelRoute(model types.ModelEntry) (route, provider, id string, native bool) {
	id = strings.TrimSpace(model.ID)
	provider = strings.TrimSpace(model.Provider)
	if provider == "openai" && !strings.Contains(id, "/") {
		return "native/" + id, provider, id, true
	}
	if slash := strings.IndexByte(id, '/'); slash > 0 {
		return id, id[:slash], id[slash+1:], false
	}
	if provider == "" || id == "" {
		return "", "", "", false
	}
	return provider + "/" + id, provider, id, false
}

func desktopModelLabel(model types.ModelEntry, route string) string {
	if strings.TrimSpace(model.DisplayName) != "" {
		return model.DisplayName
	}
	return route
}

func requestPort(r *http.Request, fallback int) int {
	if _, rawPort, err := net.SplitHostPort(r.Host); err == nil {
		if port, err := net.LookupPort("tcp", rawPort); err == nil && port > 0 {
			return port
		}
	}
	return fallback
}
