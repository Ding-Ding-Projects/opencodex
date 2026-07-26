package management

import (
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

func (a *API) handleModels(w http.ResponseWriter, r *http.Request) bool {
	if r.URL.Path == "/api/models" && r.Method == http.MethodGet {
		models := []types.ModelEntry{}
		if a.registry != nil {
			models = a.registry.ListModels()
		}
		a.mu.RLock()
		custom := make([]CustomModel, 0, len(a.customModels))
		for _, model := range a.customModels {
			custom = append(custom, model)
		}
		a.mu.RUnlock()
		writeJSON(w, http.StatusOK, map[string]any{"models": models, "customModels": custom})
		return true
	}
	if r.URL.Path == "/api/disabled-models" && r.Method == http.MethodPut {
		var body struct {
			Models []string `json:"models"`
		}
		if !decodeJSON(w, r, &body) {
			return true
		}
		disabled := uniqueStrings(body.Models)
		for _, model := range disabled {
			if len(model) > 512 || strings.ContainsAny(model, "\x00\r\n") {
				writeError(w, http.StatusBadRequest, "invalid disabled model")
				return true
			}
		}
		a.mu.Lock()
		a.config.DisabledModels = disabled
		err := a.saveLocked()
		a.mu.Unlock()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "save disabled models failed")
			return true
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "disabled": disabled})
		return true
	}
	if r.URL.Path == "/api/model-visibility" && r.Method == http.MethodPut {
		return a.updateModelVisibility(w, r)
	}
	if r.URL.Path == "/api/selected-models" {
		return a.handleSelectedModels(w, r)
	}
	if strings.HasPrefix(r.URL.Path, "/api/custom-models") {
		return a.handleCustomModels(w, r)
	}
	if r.URL.Path == "/api/model-aliases" {
		if r.Method == http.MethodGet {
			a.mu.RLock()
			aliases := cloneStringMap(a.aliases)
			a.mu.RUnlock()
			writeJSON(w, http.StatusOK, aliases)
			return true
		}
		if r.Method == http.MethodPut {
			var body struct {
				Aliases map[string]string `json:"aliases"`
			}
			if !decodeJSON(w, r, &body) {
				return true
			}
			for alias, target := range body.Aliases {
				if validateIdentifier(alias, "alias") != nil || strings.TrimSpace(target) == "" {
					writeError(w, http.StatusBadRequest, "invalid model alias")
					return true
				}
			}
			a.mu.Lock()
			a.aliases = cloneStringMap(body.Aliases)
			a.mu.Unlock()
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "aliases": body.Aliases})
			return true
		}
	}
	if r.URL.Path == "/api/provider-context-caps" {
		if r.Method == http.MethodGet {
			a.mu.RLock()
			caps := cloneIntMap(a.config.ProviderContextCaps)
			value := globalContextCap(a.config.ContextCapValue)
			a.mu.RUnlock()
			writeJSON(w, http.StatusOK, map[string]any{"cap": defaultProviderContextCap, "value": value, "caps": caps})
			return true
		}
		if r.Method == http.MethodPut {
			var body struct {
				Provider *string `json:"provider,omitempty"`
				Enabled  *bool   `json:"enabled,omitempty"`
				Value    *int    `json:"value,omitempty"`
				SetAll   *bool   `json:"setAll,omitempty"`
			}
			if !decodeJSON(w, r, &body) {
				return true
			}
			branches := 0
			if body.Value != nil {
				branches++
			}
			if body.SetAll != nil {
				branches++
			}
			if body.Provider != nil || body.Enabled != nil {
				branches++
			}
			if branches != 1 {
				writeError(w, http.StatusBadRequest, "provide exactly one context-cap operation")
				return true
			}
			if body.Value != nil && *body.Value <= 0 {
				writeError(w, http.StatusBadRequest, "value must be a positive integer")
				return true
			}
			a.mu.Lock()
			previousCaps := cloneIntMap(a.config.ProviderContextCaps)
			previousValue := a.config.ContextCapValue
			if a.config.ProviderContextCaps == nil {
				a.config.ProviderContextCaps = map[string]int{}
			}
			if body.Value != nil {
				a.config.ContextCapValue = *body.Value
				for provider := range a.config.ProviderContextCaps {
					a.config.ProviderContextCaps[provider] = *body.Value
				}
			} else if body.SetAll != nil {
				if *body.SetAll {
					value := globalContextCap(a.config.ContextCapValue)
					for provider := range a.config.Providers {
						a.config.ProviderContextCaps[provider] = value
					}
				} else {
					a.config.ProviderContextCaps = map[string]int{}
				}
			} else {
				if body.Provider == nil || body.Enabled == nil {
					a.mu.Unlock()
					writeError(w, http.StatusBadRequest, "provider string and enabled boolean are required")
					return true
				}
				provider := strings.TrimSpace(*body.Provider)
				if validateIdentifier(provider, "provider") != nil {
					a.mu.Unlock()
					writeError(w, http.StatusBadRequest, "invalid provider")
					return true
				}
				if _, found := a.config.Providers[provider]; !found {
					a.mu.Unlock()
					writeError(w, http.StatusNotFound, "unknown provider")
					return true
				}
				if *body.Enabled {
					a.config.ProviderContextCaps[provider] = globalContextCap(a.config.ContextCapValue)
				} else {
					delete(a.config.ProviderContextCaps, provider)
				}
			}
			err := a.saveLocked()
			if err != nil {
				a.config.ProviderContextCaps, a.config.ContextCapValue = previousCaps, previousValue
			}
			caps := cloneIntMap(a.config.ProviderContextCaps)
			value := globalContextCap(a.config.ContextCapValue)
			a.mu.Unlock()
			if err != nil {
				writeError(w, http.StatusInternalServerError, "save provider context caps failed")
				return true
			}
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "cap": defaultProviderContextCap, "value": value, "caps": caps})
			return true
		}
	}
	return false
}

func (a *API) handleSelectedModels(w http.ResponseWriter, r *http.Request) bool {
	switch r.Method {
	case http.MethodGet:
		selected := map[string][]string{}
		a.mu.RLock()
		for name, provider := range a.config.Providers {
			if len(provider.SelectedModels) > 0 {
				selected[name] = append([]string(nil), provider.SelectedModels...)
			}
		}
		a.mu.RUnlock()
		available := map[string][]string{}
		if a.registry != nil {
			for _, model := range a.registry.ListModels() {
				available[model.Provider] = append(available[model.Provider], model.ID)
			}
		}
		for provider := range available {
			sort.Strings(available[provider])
			available[provider] = uniqueStrings(available[provider])
		}
		writeJSON(w, http.StatusOK, map[string]any{"selected": selected, "available": available, "liveModelCounts": map[string]int{}})
	case http.MethodPut:
		var body struct {
			Provider string   `json:"provider"`
			Models   []string `json:"models"`
		}
		if !decodeJSON(w, r, &body) {
			return true
		}
		body.Provider = strings.TrimSpace(body.Provider)
		if validateIdentifier(body.Provider, "provider") != nil {
			writeError(w, http.StatusBadRequest, "invalid provider")
			return true
		}
		models := uniqueStrings(body.Models)
		a.mu.Lock()
		provider, found := a.config.Providers[body.Provider]
		if !found {
			a.mu.Unlock()
			writeError(w, http.StatusNotFound, "unknown provider")
			return true
		}
		provider.SelectedModels = models
		a.config.Providers[body.Provider] = provider
		err := a.saveLocked()
		a.mu.Unlock()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "save selected models failed")
			return true
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "provider": body.Provider, "selected": models})
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
	return true
}

func (a *API) updateModelVisibility(w http.ResponseWriter, r *http.Request) bool {
	var body struct {
		Scope    string `json:"scope"`
		Provider string `json:"provider"`
		Enabled  *bool  `json:"enabled"`
		Targets  []struct {
			ID     string `json:"id"`
			Native bool   `json:"native,omitempty"`
		} `json:"targets"`
	}
	if !decodeJSON(w, r, &body) {
		return true
	}
	body.Provider = strings.TrimSpace(body.Provider)
	if (body.Scope != "models" && body.Scope != "provider") || validateIdentifier(body.Provider, "provider") != nil || body.Enabled == nil || len(body.Targets) == 0 {
		writeError(w, http.StatusBadRequest, "invalid model visibility request")
		return true
	}
	canonical := make([]string, 0, len(body.Targets))
	for _, target := range body.Targets {
		id := strings.TrimSpace(target.ID)
		if id == "" || len(id) > 512 || strings.ContainsAny(id, "\x00\r\n") {
			writeError(w, http.StatusBadRequest, "invalid model visibility target")
			return true
		}
		if target.Native {
			if body.Provider != "openai" {
				writeError(w, http.StatusBadRequest, "native model visibility requires openai provider")
				return true
			}
			canonical = append(canonical, id)
		} else {
			canonical = append(canonical, body.Provider+"/"+id)
		}
	}
	a.mu.Lock()
	provider, found := a.config.Providers[body.Provider]
	if !found && body.Provider != "openai" {
		a.mu.Unlock()
		writeError(w, http.StatusNotFound, "unknown model visibility provider")
		return true
	}
	disabled := append([]string(nil), a.config.DisabledModels...)
	if *body.Enabled {
		disabled = removeStrings(disabled, canonical)
		if body.Scope == "provider" && found {
			provider.SelectedModels = nil
			a.config.Providers[body.Provider] = provider
		}
	} else {
		disabled = uniqueStrings(append(disabled, canonical...))
	}
	a.config.DisabledModels = disabled
	err := a.saveLocked()
	a.mu.Unlock()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "save model visibility failed")
		return true
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "scope": body.Scope, "provider": body.Provider, "enabled": *body.Enabled, "disabled": disabled})
	return true
}

func removeStrings(values, removals []string) []string {
	remove := make(map[string]struct{}, len(removals))
	for _, value := range removals {
		remove[value] = struct{}{}
	}
	out := values[:0]
	for _, value := range values {
		if _, found := remove[value]; !found {
			out = append(out, value)
		}
	}
	return out
}

func (a *API) handleCustomModels(w http.ResponseWriter, r *http.Request) bool {
	if r.URL.Path == "/api/custom-models" {
		switch r.Method {
		case http.MethodGet:
			a.mu.RLock()
			models := make([]CustomModel, 0, len(a.customModels))
			for _, model := range a.customModels {
				models = append(models, model)
			}
			a.mu.RUnlock()
			sort.Slice(models, func(i, j int) bool { return models[i].AddedAt < models[j].AddedAt })
			writeJSON(w, http.StatusOK, models)
		case http.MethodPost:
			var body struct {
				Provider        string   `json:"provider"`
				ModelID         string   `json:"modelId"`
				DisplayName     string   `json:"displayName,omitempty"`
				ContextWindow   int      `json:"contextWindow,omitempty"`
				InputModalities []string `json:"inputModalities,omitempty"`
			}
			if !decodeJSON(w, r, &body) {
				return true
			}
			body.Provider = strings.TrimSpace(body.Provider)
			body.ModelID = strings.TrimSpace(body.ModelID)
			if validateIdentifier(body.Provider, "provider") != nil || validateIdentifier(body.ModelID, "modelId") != nil || strings.Contains(body.ModelID, "/") || body.ContextWindow < 0 || strings.Contains(body.DisplayName, "/") {
				writeError(w, http.StatusBadRequest, "invalid custom model")
				return true
			}
			model := CustomModel{ID: randomID(), Provider: body.Provider, ModelID: body.ModelID, DisplayName: strings.TrimSpace(body.DisplayName), ContextWindow: body.ContextWindow, InputModalities: uniqueStrings(body.InputModalities), AddedAt: time.Now().UTC().Format(time.RFC3339)}
			a.mu.Lock()
			if _, found := a.config.Providers[model.Provider]; !found {
				a.mu.Unlock()
				writeError(w, http.StatusNotFound, "provider not configured")
				return true
			}
			for _, current := range a.customModels {
				if current.Provider == model.Provider && current.ModelID == model.ModelID {
					a.mu.Unlock()
					writeError(w, http.StatusConflict, "duplicate model")
					return true
				}
			}
			a.customModels[model.ID] = model
			previous := append([]CustomModel(nil), a.config.CustomModels...)
			a.config.CustomModels = sortedCustomModels(a.customModels)
			err := a.saveLocked()
			if err != nil {
				delete(a.customModels, model.ID)
				a.config.CustomModels = previous
			}
			a.mu.Unlock()
			if err != nil {
				writeError(w, http.StatusInternalServerError, "save custom model failed")
				return true
			}
			writeJSON(w, http.StatusCreated, model)
		default:
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		}
		return true
	}
	id := r.PathValue("id")
	if id == "" {
		id = strings.TrimPrefix(r.URL.Path, "/api/custom-models/")
	}
	if validateIdentifier(id, "id") != nil {
		writeError(w, http.StatusBadRequest, "invalid model id")
		return true
	}
	switch r.Method {
	case http.MethodPut:
		var body struct {
			DisplayName     *string  `json:"displayName,omitempty"`
			ContextWindow   *int     `json:"contextWindow,omitempty"`
			InputModalities []string `json:"inputModalities,omitempty"`
			ModelID         *string  `json:"modelId,omitempty"`
		}
		if !decodeJSON(w, r, &body) {
			return true
		}
		a.mu.Lock()
		model, found := a.customModels[id]
		if !found {
			a.mu.Unlock()
			writeError(w, http.StatusNotFound, "not found")
			return true
		}
		if body.DisplayName != nil {
			model.DisplayName = strings.TrimSpace(*body.DisplayName)
			if strings.Contains(model.DisplayName, "/") {
				a.mu.Unlock()
				writeError(w, http.StatusBadRequest, "displayName must not contain /")
				return true
			}
		}
		if body.ModelID != nil {
			value := strings.TrimSpace(*body.ModelID)
			if validateIdentifier(value, "modelId") != nil || strings.Contains(value, "/") {
				a.mu.Unlock()
				writeError(w, http.StatusBadRequest, "invalid modelId")
				return true
			}
			model.ModelID = value
		}
		if body.ContextWindow != nil {
			if *body.ContextWindow < 0 {
				a.mu.Unlock()
				writeError(w, http.StatusBadRequest, "contextWindow must be non-negative")
				return true
			}
			model.ContextWindow = *body.ContextWindow
		}
		if body.InputModalities != nil {
			model.InputModalities = uniqueStrings(body.InputModalities)
		}
		for otherID, other := range a.customModels {
			if otherID != id && other.Provider == model.Provider && other.ModelID == model.ModelID {
				a.mu.Unlock()
				writeError(w, http.StatusConflict, "duplicate model")
				return true
			}
		}
		previous := a.customModels[id]
		previousConfig := append([]CustomModel(nil), a.config.CustomModels...)
		a.customModels[id] = model
		a.config.CustomModels = sortedCustomModels(a.customModels)
		err := a.saveLocked()
		if err != nil {
			a.customModels[id] = previous
			a.config.CustomModels = previousConfig
		}
		a.mu.Unlock()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "save custom model failed")
			return true
		}
		writeJSON(w, http.StatusOK, model)
	case http.MethodDelete:
		a.mu.Lock()
		if _, found := a.customModels[id]; !found {
			a.mu.Unlock()
			writeError(w, http.StatusNotFound, "not found")
			return true
		}
		model := a.customModels[id]
		previousConfig := append([]CustomModel(nil), a.config.CustomModels...)
		delete(a.customModels, id)
		a.config.CustomModels = sortedCustomModels(a.customModels)
		err := a.saveLocked()
		if err != nil {
			a.customModels[id] = model
			a.config.CustomModels = previousConfig
		}
		a.mu.Unlock()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "save custom model removal failed")
			return true
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
	return true
}

func randomID() string {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return time.Now().UTC().Format("20060102150405.000000000")
	}
	return hex.EncodeToString(value[:])
}
func uniqueStrings(values []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value != "" && !seen[value] {
			seen[value] = true
			out = append(out, value)
		}
	}
	return out
}
func cloneStringMap(input map[string]string) map[string]string {
	out := make(map[string]string, len(input))
	for key, value := range input {
		out[key] = value
	}
	return out
}
func cloneIntMap(input map[string]int) map[string]int {
	out := make(map[string]int, len(input))
	for key, value := range input {
		out[key] = value
	}
	return out
}

const defaultProviderContextCap = 350_000

func globalContextCap(value int) int {
	if value > 0 {
		return value
	}
	return defaultProviderContextCap
}

func sortedCustomModels(models map[string]CustomModel) []CustomModel {
	values := make([]CustomModel, 0, len(models))
	for _, model := range models {
		values = append(values, model)
	}
	sort.Slice(values, func(i, j int) bool { return values[i].AddedAt < values[j].AddedAt })
	if len(values) == 0 {
		return nil
	}
	return values
}
