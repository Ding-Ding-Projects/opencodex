package management

import (
	"crypto/subtle"
	"net/http"
	"sort"
	"strings"
	"time"
	"unicode"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/providers"
)

func (a *API) handleAPIKeys(w http.ResponseWriter, request *http.Request) bool {
	switch request.URL.Path {
	case "/api/key-providers":
		if request.Method != http.MethodGet {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return true
		}
		a.handleKeyProviders(w)
		return true
	case "/api/providers/keys":
		a.handleProviderKeys(w, request)
		return true
	case "/api/providers/keys/active":
		a.handleProviderKeyActive(w, request)
		return true
	case "/api/providers/keys/alias":
		a.handleProviderKeyAlias(w, request)
		return true
	case "/api/keys":
		a.handleProxyAPIKeys(w, request)
		return true
	default:
		return false
	}
}

func (a *API) handleKeyProviders(w http.ResponseWriter) {
	derived, err := providers.DeriveKeyLoginMap()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "key provider catalog is unavailable")
		return
	}
	ids := make([]string, 0, len(derived))
	for id := range derived {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	result := make([]map[string]any, 0, len(ids))
	for _, id := range ids {
		entry := derived[id]
		result = append(result, map[string]any{
			"id": id, "label": entry.Label, "adapter": entry.Adapter,
			"baseUrl": publicProviderBaseURL(entry.BaseURL), "dashboardUrl": entry.DashboardURL,
			"defaultModel": entry.DefaultModel, "models": entry.Models,
			"keyOptional": entry.KeyOptional,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"providers": result})
}

func (a *API) handleProviderKeys(w http.ResponseWriter, request *http.Request) {
	switch request.Method {
	case http.MethodGet:
		name, err := queryRequired(request.URL.Query(), "name")
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		a.mu.Lock()
		provider, found := a.config.Providers[name]
		if !found || !config.IsKeyAuthProvider(provider) {
			a.mu.Unlock()
			writeError(w, http.StatusNotFound, "unknown provider")
			return
		}
		activeID, infos := config.ListAPIKeys(a.config, name)
		keys := safeProviderKeyInfos(infos)
		a.mu.Unlock()
		writeJSON(w, http.StatusOK, map[string]any{"activeId": activeID, "keys": keys})
	case http.MethodPost:
		var body struct {
			Name  string `json:"name"`
			Key   string `json:"key"`
			Label string `json:"label,omitempty"`
		}
		if !decodeJSON(w, request, &body) {
			return
		}
		body.Name, body.Label = strings.TrimSpace(body.Name), strings.TrimSpace(body.Label)
		if validateIdentifier(body.Name, "name") != nil {
			writeError(w, http.StatusNotFound, "unknown provider")
			return
		}
		if body.Label != "" && !printableName(body.Label, 80) {
			writeError(w, http.StatusBadRequest, "label must be at most 80 printable characters")
			return
		}
		a.mu.Lock()
		provider, found := a.config.Providers[body.Name]
		if !found || !config.IsKeyAuthProvider(provider) {
			a.mu.Unlock()
			writeError(w, http.StatusNotFound, "unknown provider")
			return
		}
		previous := cloneProviderKeyState(provider)
		id, err := config.AddAPIKey(a.config, body.Name, body.Key, body.Label, time.Now())
		if err == nil {
			err = a.saveLocked()
		}
		if err != nil {
			a.config.Providers[body.Name] = previous
		}
		a.mu.Unlock()
		if err != nil {
			writeError(w, http.StatusBadRequest, "provider key could not be saved")
			return
		}
		writeJSON(w, http.StatusCreated, map[string]any{"ok": true, "id": id})
	case http.MethodDelete:
		name, nameErr := queryRequired(request.URL.Query(), "name")
		id, idErr := queryRequired(request.URL.Query(), "id")
		if nameErr != nil || idErr != nil {
			writeError(w, http.StatusBadRequest, "name and id are required")
			return
		}
		a.mu.Lock()
		provider, found := a.config.Providers[name]
		if !found || !config.IsKeyAuthProvider(provider) {
			a.mu.Unlock()
			writeError(w, http.StatusNotFound, "unknown provider")
			return
		}
		previous := cloneProviderKeyState(provider)
		removed := config.RemoveAPIKey(a.config, name, id)
		var err error
		if removed {
			err = a.saveLocked()
		}
		if err != nil {
			a.config.Providers[name] = previous
		}
		a.mu.Unlock()
		if !removed {
			writeError(w, http.StatusNotFound, "key not found")
		} else if err != nil {
			writeError(w, http.StatusInternalServerError, "provider key removal failed")
		} else {
			writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		}
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (a *API) handleProviderKeyActive(w http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPut {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var body struct{ Name, ID string }
	if !decodeJSON(w, request, &body) {
		return
	}
	body.Name, body.ID = strings.TrimSpace(body.Name), strings.TrimSpace(body.ID)
	a.mu.Lock()
	provider, found := a.config.Providers[body.Name]
	if !found || !config.IsKeyAuthProvider(provider) {
		a.mu.Unlock()
		writeError(w, http.StatusNotFound, "unknown provider")
		return
	}
	previous := cloneProviderKeyState(provider)
	updated := config.SetActiveAPIKey(a.config, body.Name, body.ID)
	var err error
	if updated {
		err = a.saveLocked()
	}
	if err != nil {
		a.config.Providers[body.Name] = previous
	}
	a.mu.Unlock()
	if !updated {
		writeError(w, http.StatusNotFound, "key not found")
	} else if err != nil {
		writeError(w, http.StatusInternalServerError, "active provider key could not be saved")
	} else {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "name": body.Name, "activeId": body.ID})
	}
}

func (a *API) handleProviderKeyAlias(w http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPut {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var body struct{ Name, ID, Alias string }
	if !decodeJSON(w, request, &body) {
		return
	}
	body.Name, body.ID, body.Alias = strings.TrimSpace(body.Name), strings.TrimSpace(body.ID), strings.TrimSpace(body.Alias)
	if !printableName(body.Alias, 80) {
		writeError(w, http.StatusBadRequest, "alias must be at most 80 printable characters")
		return
	}
	a.mu.Lock()
	provider, found := a.config.Providers[body.Name]
	if !found || !config.IsKeyAuthProvider(provider) {
		a.mu.Unlock()
		writeError(w, http.StatusNotFound, "unknown provider")
		return
	}
	previous := cloneProviderKeyState(provider)
	updated := config.SetAPIKeyLabel(a.config, body.Name, body.ID, body.Alias)
	var err error
	if updated {
		err = a.saveLocked()
	}
	if err != nil {
		a.config.Providers[body.Name] = previous
	}
	a.mu.Unlock()
	if !updated {
		writeError(w, http.StatusNotFound, "key not found")
	} else if err != nil {
		writeError(w, http.StatusInternalServerError, "provider key alias could not be saved")
	} else {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "name": body.Name, "id": body.ID, "alias": nullable(body.Alias)})
	}
}

func (a *API) handleProxyAPIKeys(w http.ResponseWriter, request *http.Request) {
	switch request.Method {
	case http.MethodGet:
		a.mu.RLock()
		keys := safeProxyAPIKeys(a.config.APIKeys)
		endpoints := apiAccessEndpoints(a.config, request)
		a.mu.RUnlock()
		endpoints["keys"] = keys
		writeJSON(w, http.StatusOK, endpoints)
	case http.MethodPost:
		var body struct{ Name, Key string }
		if !decodeJSON(w, request, &body) {
			return
		}
		body.Name, body.Key = strings.TrimSpace(body.Name), strings.TrimSpace(body.Key)
		if body.Name == "" {
			body.Name = "default"
		}
		if !printableName(body.Name, 80) || len(body.Key) < 24 || len(body.Key) > 512 || strings.ContainsAny(body.Key, "\x00\r\n") {
			writeError(w, http.StatusBadRequest, "name or key is invalid")
			return
		}
		a.mu.Lock()
		if containsProxyKey(a.config.APIKeys, body.Key) {
			a.mu.Unlock()
			writeError(w, http.StatusConflict, "key already exists")
			return
		}
		previous := append([]config.ProxyAPIKey(nil), a.config.APIKeys...)
		entry := config.ProxyAPIKey{ID: randomID(), Name: body.Name, Key: body.Key, CreatedAt: time.Now().UTC().Format(time.RFC3339)}
		a.config.APIKeys = append(a.config.APIKeys, entry)
		err := a.saveLocked()
		if err != nil {
			a.config.APIKeys = previous
		} else {
			a.notifyAPIKeysLocked()
		}
		a.mu.Unlock()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "API key could not be saved")
			return
		}
		writeJSON(w, http.StatusCreated, map[string]any{"id": entry.ID, "name": entry.Name, "createdAt": entry.CreatedAt})
	case http.MethodDelete:
		var body struct {
			ID string `json:"id"`
		}
		if !decodeJSON(w, request, &body) {
			return
		}
		body.ID = strings.TrimSpace(body.ID)
		if body.ID == "" {
			writeError(w, http.StatusBadRequest, "id required")
			return
		}
		a.mu.Lock()
		previous := append([]config.ProxyAPIKey(nil), a.config.APIKeys...)
		removed := false
		for index, entry := range a.config.APIKeys {
			if entry.ID == body.ID {
				a.config.APIKeys = append(a.config.APIKeys[:index], a.config.APIKeys[index+1:]...)
				removed = true
				break
			}
		}
		var err error
		if removed {
			err = a.saveLocked()
		}
		if err != nil {
			a.config.APIKeys = previous
		} else if removed {
			a.notifyAPIKeysLocked()
		}
		a.mu.Unlock()
		if !removed {
			writeError(w, http.StatusNotFound, "key not found")
		} else if err != nil {
			writeError(w, http.StatusInternalServerError, "API key removal failed")
		} else {
			writeJSON(w, http.StatusOK, map[string]any{"success": true})
		}
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func safeProviderKeyInfos(infos []config.APIKeyInfo) []map[string]any {
	result := make([]map[string]any, 0, len(infos))
	for _, info := range infos {
		result = append(result, map[string]any{"id": info.ID, "label": info.Label, "active": info.Active, "addedAt": info.AddedAt})
	}
	return result
}

func safeProxyAPIKeys(keys []config.ProxyAPIKey) []map[string]any {
	result := make([]map[string]any, 0, len(keys))
	for _, key := range keys {
		result = append(result, map[string]any{"id": key.ID, "name": key.Name, "createdAt": key.CreatedAt})
	}
	return result
}

func cloneProviderKeyState(provider config.ProviderConfig) config.ProviderConfig {
	provider.APIKeyPool = append([]config.APIKeyEntry(nil), provider.APIKeyPool...)
	return provider
}

func containsProxyKey(keys []config.ProxyAPIKey, candidate string) bool {
	for _, key := range keys {
		if len(key.Key) == len(candidate) && subtle.ConstantTimeCompare([]byte(key.Key), []byte(candidate)) == 1 {
			return true
		}
	}
	return false
}

func printableName(value string, limit int) bool {
	if len(value) > limit {
		return false
	}
	for _, char := range value {
		if unicode.IsControl(char) {
			return false
		}
	}
	return true
}

func (a *API) notifyAPIKeysLocked() {
	if a.onAPIKeysChanged != nil {
		a.onAPIKeysChanged(append([]config.ProxyAPIKey(nil), a.config.APIKeys...))
	}
}
