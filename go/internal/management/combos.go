package management

import (
	"net/http"
	"sort"
	"strings"

	comboapi "github.com/lidge-jun/opencodex-go/internal/combos"
)

func (a *API) handleCombos(w http.ResponseWriter, r *http.Request) bool {
	if r.URL.Path == "/api/combos/reset" && r.Method == http.MethodPost {
		a.mu.Lock()
		previous := a.config.Combos
		a.config.Combos = map[string]comboapi.Combo{}
		err := a.saveLocked()
		if err != nil {
			a.config.Combos = previous
		}
		a.mu.Unlock()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "save combo reset failed")
			return true
		}
		writeJSON(w, http.StatusOK, orderedJSONObject{{name: "success", value: true}})
		return true
	}
	if r.URL.Path != "/api/combos" {
		return false
	}
	switch r.Method {
	case http.MethodGet:
		a.mu.RLock()
		ids := make([]string, 0, len(a.config.Combos))
		for id := range a.config.Combos {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		values := make([]orderedJSONObject, 0, len(ids))
		for _, id := range ids {
			combo := a.config.Combos[id]
			values = append(values, append(orderedJSONObject{{name: "id", value: id}, {name: "model", value: comboPublicModelID(id, combo)}}, comboDTO(combo)...))
		}
		a.mu.RUnlock()
		writeJSON(w, http.StatusOK, orderedJSONObject{{name: "combos", value: values}})
	case http.MethodPut:
		var body struct {
			ID         string         `json:"id"`
			RenameFrom string         `json:"renameFrom,omitempty"`
			Combo      comboapi.Combo `json:"combo"`
		}
		if !decodeJSON(w, r, &body) {
			return true
		}
		body.ID = strings.TrimSpace(body.ID)
		body.RenameFrom = strings.TrimSpace(body.RenameFrom)
		if body.RenameFrom == body.ID && body.RenameFrom != "" {
			writeError(w, http.StatusBadRequest, "renameFrom must differ from id")
			return true
		}
		if err := comboapi.ValidateBasic(body.ID, body.Combo); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return true
		}
		a.mu.Lock()
		if body.RenameFrom != "" {
			if _, exists := a.config.Combos[body.RenameFrom]; !exists {
				a.mu.Unlock()
				writeError(w, http.StatusNotFound, "rename source not found")
				return true
			}
			if _, exists := a.config.Combos[body.ID]; exists {
				a.mu.Unlock()
				writeError(w, http.StatusConflict, "rename destination already exists")
				return true
			}
		}
		for _, target := range body.Combo.Targets {
			provider, exists := a.config.Providers[target.Provider]
			if !exists || provider.Disabled || strings.TrimSpace(target.Model) == "" {
				a.mu.Unlock()
				writeError(w, http.StatusBadRequest, "combo target requires an enabled configured provider and model")
				return true
			}
		}
		previousCombos := cloneComboConfig(a.config.Combos)
		previousDisabled := append([]string(nil), a.config.DisabledModels...)
		previousSubagents := append([]string(nil), a.config.SubagentModels...)
		previousInjection := a.config.InjectionModel
		if a.config.Combos == nil {
			a.config.Combos = map[string]comboapi.Combo{}
		}
		if body.RenameFrom != "" {
			old := a.config.Combos[body.RenameFrom]
			oldModel := comboPublicModelID(body.RenameFrom, old)
			delete(a.config.Combos, body.RenameFrom)
			newModel := comboPublicModelID(body.ID, body.Combo)
			a.config.DisabledModels = replaceModelReferences(a.config.DisabledModels, body.RenameFrom, oldModel, newModel)
			a.config.SubagentModels = replaceModelReferences(a.config.SubagentModels, body.RenameFrom, oldModel, newModel)
			if a.config.InjectionModel == oldModel || a.config.InjectionModel == comboapi.ModelID(body.RenameFrom) {
				a.config.InjectionModel = newModel
			}
		}
		body.Combo.ID = ""
		a.config.Combos[body.ID] = body.Combo
		err := a.saveLocked()
		if err != nil {
			a.config.Combos, a.config.DisabledModels, a.config.SubagentModels, a.config.InjectionModel = previousCombos, previousDisabled, previousSubagents, previousInjection
		}
		a.mu.Unlock()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "save combo failed")
			return true
		}
		writeJSON(w, http.StatusOK, orderedJSONObject{{name: "success", value: true}, {name: "id", value: body.ID}, {name: "model", value: comboPublicModelID(body.ID, body.Combo)}, {name: "combo", value: comboDTO(body.Combo)}})
	case http.MethodDelete:
		id, err := queryRequired(r.URL.Query(), "id")
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return true
		}
		a.mu.Lock()
		combo, exists := a.config.Combos[id]
		if !exists {
			a.mu.Unlock()
			writeError(w, http.StatusNotFound, "unknown combo")
			return true
		}
		delete(a.config.Combos, id)
		err = a.saveLocked()
		if err != nil {
			a.config.Combos[id] = combo
		}
		a.mu.Unlock()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "save combo removal failed")
			return true
		}
		writeJSON(w, http.StatusOK, orderedJSONObject{{name: "success", value: true}, {name: "id", value: id}})
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
	return true
}

func comboDTO(combo comboapi.Combo) orderedJSONObject {
	stickyLimit := combo.StickyLimit
	if stickyLimit == 0 {
		stickyLimit = 1
	}
	targets := make([]orderedJSONObject, 0, len(combo.Targets))
	for _, target := range combo.Targets {
		weight := target.Weight
		if weight == 0 {
			weight = 1
		}
		targets = append(targets, orderedJSONObject{
			{name: "provider", value: strings.TrimSpace(target.Provider)},
			{name: "model", value: strings.TrimSpace(target.Model)},
			{name: "weight", value: weight},
		})
	}
	return orderedJSONObject{
		{name: "strategy", value: defaultComboStrategy(combo.Strategy)},
		{name: "stickyLimit", value: stickyLimit},
		{name: "defaultEffort", value: nullable(strings.TrimSpace(combo.DefaultEffort))},
		{name: "alias", value: nullable(strings.TrimSpace(combo.Alias))},
		{name: "targets", value: targets},
	}
}

func defaultComboStrategy(value string) string {
	if value == "" {
		return comboapi.StrategyFailover
	}
	return value
}

func comboPublicModelID(id string, combo comboapi.Combo) string {
	if strings.TrimSpace(combo.Alias) != "" {
		return strings.TrimSpace(combo.Alias)
	}
	return comboapi.ModelID(id)
}

func cloneComboConfig(input map[string]comboapi.Combo) map[string]comboapi.Combo {
	out := make(map[string]comboapi.Combo, len(input))
	for id, combo := range input {
		combo.Targets = append([]comboapi.Target(nil), combo.Targets...)
		out[id] = combo
	}
	return out
}

func replaceModelReferences(values []string, oldID, oldPublic, replacement string) []string {
	oldInternal := comboapi.ModelID(oldID)
	out := make([]string, 0, len(values))
	seen := map[string]bool{}
	for _, value := range values {
		if value == oldInternal || value == oldPublic {
			value = replacement
		}
		if !seen[value] {
			seen[value] = true
			out = append(out, value)
		}
	}
	return out
}
