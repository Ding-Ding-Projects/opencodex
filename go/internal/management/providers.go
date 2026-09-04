package management

import (
	"net/http"
	"sort"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/config"
	ocxlib "github.com/lidge-jun/opencodex-go/internal/lib"
	"github.com/lidge-jun/opencodex-go/internal/providers"
	"github.com/lidge-jun/opencodex-go/internal/registry"
)

func (a *API) handleProviders(w http.ResponseWriter, r *http.Request) bool {
	if r.URL.Path == "/api/provider-presets" && r.Method == http.MethodGet {
		presets := registry.DeriveProviderPresets(registry.Providers)
		writeJSON(w, http.StatusOK, map[string]any{"providers": presets})
		return true
	}
	if r.URL.Path == "/api/providers/test" && r.Method == http.MethodPost {
		return a.testProvider(w, r)
	}
	if r.URL.Path != "/api/providers" {
		return false
	}
	switch r.Method {
	case http.MethodGet:
		a.mu.RLock()
		names := make([]string, 0, len(a.config.Providers))
		for name := range a.config.Providers {
			names = append(names, name)
		}
		sort.Strings(names)
		rows := make([]any, 0, len(names))
		for _, name := range names {
			row := publicProvider(name, a.config.Providers[name])
			rows = append(rows, orderedFromMap(row, []string{"name", "adapter", "baseUrl", "defaultModel", "hasApiKey", "allowPrivateNetwork", "liveModels", "models", "authMode", "disabled", "codexAccountMode", "discovery"}))
		}
		a.mu.RUnlock()
		writeJSON(w, http.StatusOK, rows)
	case http.MethodPost:
		var body struct {
			Name       string                `json:"name"`
			Provider   config.ProviderConfig `json:"provider"`
			SetDefault bool                  `json:"setDefault,omitempty"`
		}
		if !decodeJSON(w, r, &body) {
			return true
		}
		body.Name = strings.TrimSpace(body.Name)
		if err := validateIdentifier(body.Name, "name"); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return true
		}
		if err := managementProviderShapeError(body.Name, body.Provider); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return true
		}
		a.mu.Lock()
		candidate := *a.config
		candidate.Providers = cloneProviders(a.config.Providers)
		candidate.Providers[body.Name] = body.Provider
		if body.SetDefault {
			candidate.DefaultProvider = body.Name
		}
		if err := candidate.Validate(); err != nil {
			a.mu.Unlock()
			writeError(w, http.StatusBadRequest, err.Error())
			return true
		}
		allowBenchmark := body.Name == "openai" && providers.IsCanonicalOpenAiForwardProvider(body.Provider.Adapter, body.Provider.AuthMode, body.Provider.BaseURL)
		if err := a.providerDestinationResolvedError(r.Context(), body.Name, body.Provider, allowBenchmark); err != nil {
			a.mu.Unlock()
			writeError(w, http.StatusBadRequest, "provider "+body.Name+" "+err.Error())
			return true
		}
		a.config.Providers = candidate.Providers
		a.config.DefaultProvider = candidate.DefaultProvider
		err := a.saveLocked()
		a.mu.Unlock()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "save provider failed")
			return true
		}
		writeJSON(w, http.StatusOK, orderedJSONObject{
			{name: "success", value: true},
			{name: "name", value: body.Name},
		})
	case http.MethodPatch:
		name, err := queryRequired(r.URL.Query(), "name")
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return true
		}
		var patch map[string]any
		if !decodeJSON(w, r, &patch) {
			return true
		}
		if _, found := patch["apiKey"]; found {
			writeError(w, http.StatusBadRequest, "apiKey cannot be patched here")
			return true
		}
		a.mu.Lock()
		provider, found := a.config.Providers[name]
		if !found {
			a.mu.Unlock()
			writeError(w, http.StatusNotFound, "unknown provider")
			return true
		}
		if disabled, exists := patch["disabled"].(bool); exists && disabled && name == a.config.DefaultProvider {
			a.mu.Unlock()
			writeError(w, http.StatusBadRequest, "cannot disable the default provider; set another default first")
			return true
		}
		original := provider
		editorTouched := false
		for key := range patch {
			editorTouched = editorTouched || key != "disabled"
		}
		enablingOpenAI := name == "openai" && original.Disabled && patch["disabled"] == false
		if err = applyProviderPatch(&provider, patch); err == nil {
			if enablingOpenAI && !editorTouched {
				if !providers.IsCanonicalOpenAiForwardProvider(provider.Adapter, provider.AuthMode, provider.BaseURL) {
					err = fieldError("provider openai", "must be the canonical built-in provider")
				} else {
					provider.BaseURL = "https://chatgpt.com/backend-api/codex"
					if provider.CodexAccountMode != "pool" && provider.CodexAccountMode != "direct" {
						provider.CodexAccountMode = "pool"
					}
					provider.AllowPrivateNetwork = false
				}
			}
			if err == nil && (editorTouched || enablingOpenAI) {
				err = managementProviderShapeError(name, provider)
			}
			candidate := *a.config
			candidate.Providers = cloneProviders(a.config.Providers)
			candidate.Providers[name] = provider
			if err == nil {
				err = candidate.Validate()
			}
			if err == nil && (editorTouched || enablingOpenAI) {
				err = a.providerDestinationResolvedError(r.Context(), name, provider, enablingOpenAI)
			}
			if err == nil {
				a.config.Providers = candidate.Providers
				err = a.saveLocked()
			}
		}
		a.mu.Unlock()
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return true
		}
		writeJSON(w, http.StatusOK, orderedJSONObject{
			{name: "success", value: true},
			{name: "name", value: name},
			{name: "disabled", value: provider.Disabled},
			{name: "hasApiKey", value: provider.APIKey != ""},
		})
	case http.MethodDelete:
		name, err := queryRequired(r.URL.Query(), "name")
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return true
		}
		a.mu.Lock()
		if _, found := a.config.Providers[name]; !found {
			a.mu.Unlock()
			writeError(w, http.StatusNotFound, "unknown provider")
			return true
		}
		if name == a.config.DefaultProvider {
			a.mu.Unlock()
			writeError(w, http.StatusConflict, "cannot delete the default provider")
			return true
		}
		dependent := make([]string, 0)
		for id, combo := range a.config.Combos {
			for _, target := range combo.Targets {
				if target.Provider == name {
					dependent = append(dependent, id)
					break
				}
			}
		}
		if len(dependent) > 0 {
			sort.Strings(dependent)
			a.mu.Unlock()
			writeJSON(w, http.StatusConflict, map[string]any{"error": "cannot delete provider while combos depend on it", "combos": dependent})
			return true
		}
		provider := a.config.Providers[name]
		previousCaps := cloneIntMap(a.config.ProviderContextCaps)
		delete(a.config.Providers, name)
		delete(a.config.ProviderContextCaps, name)
		err = a.saveLocked()
		if err != nil {
			a.config.Providers[name] = provider
			a.config.ProviderContextCaps = previousCaps
		}
		a.mu.Unlock()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "save provider removal failed")
			return true
		}
		writeJSON(w, http.StatusOK, map[string]any{"success": true})
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
	return true
}

func (a *API) testProvider(w http.ResponseWriter, r *http.Request) bool {
	name, err := queryRequired(r.URL.Query(), "name")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return true
	}
	a.mu.RLock()
	provider, found := a.config.Providers[name]
	a.mu.RUnlock()
	if !found {
		writeError(w, http.StatusNotFound, "unknown provider")
		return true
	}
	if provider.Disabled {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "Provider is disabled"})
		return true
	}
	if a.fetchModels == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]any{"ok": false, "error": "live model fetch is not configured"})
		return true
	}
	models, err := a.fetchModels(r, name, provider)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"ok": false, "error": ocxlib.RedactSecretString(err.Error())})
		return true
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "models": len(models)})
	return true
}

func cloneProviders(input map[string]config.ProviderConfig) map[string]config.ProviderConfig {
	out := make(map[string]config.ProviderConfig, len(input))
	for key, value := range input {
		out[key] = value
	}
	return out
}

func applyProviderPatch(provider *config.ProviderConfig, patch map[string]any) error {
	for key, value := range patch {
		switch key {
		case "disabled":
			v, ok := value.(bool)
			if !ok {
				return fieldError(key, "must be a boolean")
			}
			provider.Disabled = v
		case "adapter":
			v, ok := value.(string)
			if !ok || strings.TrimSpace(v) == "" {
				return fieldError(key, "must be a non-empty string")
			}
			provider.Adapter = strings.TrimSpace(v)
		case "baseUrl":
			v, ok := value.(string)
			if !ok || strings.TrimSpace(v) == "" {
				return fieldError(key, "must be a non-empty string")
			}
			provider.BaseURL = strings.TrimSpace(v)
		case "defaultModel":
			v, ok := value.(string)
			if !ok {
				return fieldError(key, "must be a string")
			}
			provider.DefaultModel = strings.TrimSpace(v)
		case "authMode":
			v, ok := value.(string)
			if !ok {
				return fieldError(key, "must be a string")
			}
			if v != "" && v != "key" && v != "forward" && v != "oauth" && v != "local" {
				return fieldError(key, "must be key, forward, oauth, or local")
			}
			provider.AuthMode = v
		case "allowPrivateNetwork":
			v, ok := value.(bool)
			if !ok {
				return fieldError(key, "must be a boolean")
			}
			provider.AllowPrivateNetwork = v
		case "liveModels":
			v, ok := value.(bool)
			if !ok {
				return fieldError(key, "must be a boolean")
			}
			provider.LiveModels = &v
		default:
			return fieldError(key, "is not patchable")
		}
	}
	return nil
}

type fieldValidationError struct{ field, message string }

func (e fieldValidationError) Error() string { return e.field + " " + e.message }
func fieldError(field, message string) error {
	return fieldValidationError{field: field, message: message}
}

func managementProviderShapeError(name string, provider config.ProviderConfig) error {
	switch name {
	case "chatgpt":
		return fieldError("provider chatgpt", "is reserved for internal credential compatibility")
	case "openai-multi":
		return fieldError("provider openai-multi", "is reserved for legacy config migration")
	case "openai":
		if !providers.IsCanonicalOpenAiForwardProvider(provider.Adapter, provider.AuthMode, provider.BaseURL) ||
			(provider.CodexAccountMode != "pool" && provider.CodexAccountMode != "direct") || provider.AllowPrivateNetwork {
			return fieldError("provider openai", "must equal the canonical built-in provider seed")
		}
	default:
		if provider.CodexAccountMode != "" {
			return fieldError("provider "+name, "must not include codexAccountMode")
		}
		if provider.AuthMode == "forward" {
			return fieldError("provider "+name, "uses reserved authMode forward")
		}
	}
	return nil
}
