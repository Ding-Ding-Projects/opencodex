package management

// Opt-in Anthropic account-pool routes, ported from
// src/server/management/oauth-account-routes.ts.
//
// These are the STRICT half of the config contract. Reading a hand-edited
// config normalizes an unrecognized value to the default, because refusing
// would hide every configured account behind one typo; a dashboard write is a
// deliberate act, so storing something other than what was asked for would be
// worse than an error.

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/config"
)

const anthropicPoolProvider = "anthropic"

func (a *API) handleOAuthAccountPool(w http.ResponseWriter, request *http.Request) {
	switch request.Method {
	case http.MethodGet:
		a.getOAuthAccountPool(w, request)
	case http.MethodPut, http.MethodPatch:
		a.putOAuthAccountPool(w, request)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (a *API) getOAuthAccountPool(w http.ResponseWriter, request *http.Request) {
	provider := strings.ToLower(strings.TrimSpace(request.URL.Query().Get("provider")))
	if provider != anthropicPoolProvider {
		writeError(w, http.StatusBadRequest, "pool config is only supported for anthropic")
		return
	}
	a.mu.RLock()
	pool := a.config.AnthropicAccountPool
	a.mu.RUnlock()
	writeJSON(w, http.StatusOK, anthropicPoolResponse(provider, pool))
}

// anthropicPoolResponse reports the RAW threshold when it is present rather
// than the normalized one, matching the oracle: the read surface is lenient
// everywhere else, but an out-of-range value the operator stored should be
// visible to them instead of silently displayed as 80.
func anthropicPoolResponse(provider string, pool *config.AnthropicAccountPoolConfig) orderedJSONObject {
	enabled := false
	threshold := 80
	strategy := ""
	var stickyLimit *int
	if pool != nil {
		enabled = pool.Enabled != nil && *pool.Enabled
		if pool.AutoSwitchThreshold != nil {
			threshold = *pool.AutoSwitchThreshold
		}
		strategy = pool.Strategy
		stickyLimit = pool.StickyLimit
	}
	return orderedJSONObject{
		{name: "provider", value: provider},
		{name: "enabled", value: enabled},
		{name: "autoSwitchThreshold", value: threshold},
		{name: "strategy", value: config.NormalizedAccountPoolStrategy(strategy)},
		{name: "stickyLimit", value: config.NormalizedAccountPoolStickyLimit(stickyLimit)},
		{name: "experimental", value: true},
	}
}

func (a *API) putOAuthAccountPool(w http.ResponseWriter, request *http.Request) {
	var raw map[string]json.RawMessage
	if !decodeJSON(w, request, &raw) {
		return
	}
	provider, ok := anthropicPoolProviderField(w, raw)
	if !ok {
		return
	}

	a.mu.RLock()
	current := a.config.AnthropicAccountPool
	a.mu.RUnlock()
	next := config.AnthropicAccountPoolConfig{}
	if current != nil {
		next = *current
	}

	// Every field is validated BEFORE anything is written. A partially applied
	// write would leave the pool in a state the operator never asked for and
	// could not see in the error.
	if body, present := raw["enabled"]; present {
		var enabled bool
		if json.Unmarshal(body, &enabled) != nil {
			writeError(w, http.StatusBadRequest, "enabled must be a boolean")
			return
		}
		next.Enabled = &enabled
	}
	if body, present := raw["autoSwitchThreshold"]; present {
		var threshold int
		if json.Unmarshal(body, &threshold) != nil || threshold < 0 || threshold > 100 {
			writeError(w, http.StatusBadRequest, "autoSwitchThreshold must be an integer 0-100")
			return
		}
		next.AutoSwitchThreshold = &threshold
	}
	if body, present := raw["strategy"]; present {
		var strategy string
		if json.Unmarshal(body, &strategy) != nil {
			writeError(w, http.StatusBadRequest, "strategy must be one of: quota, round-robin, fill-first")
			return
		}
		parsed, valid := config.ParseAccountPoolStrategy(strategy)
		if !valid {
			writeError(w, http.StatusBadRequest, "strategy must be one of: quota, round-robin, fill-first")
			return
		}
		next.Strategy = parsed
	}
	if body, present := raw["stickyLimit"]; present {
		var limit int
		if json.Unmarshal(body, &limit) != nil {
			writeError(w, http.StatusBadRequest, "stickyLimit must be an integer 1-100")
			return
		}
		parsed, valid := config.ParseAccountPoolStickyLimit(limit)
		if !valid {
			writeError(w, http.StatusBadRequest, "stickyLimit must be an integer 1-100")
			return
		}
		next.StickyLimit = &parsed
	}

	// The oracle always writes both enabled and threshold, so an omitted field
	// lands as its resolved value rather than staying absent.
	if next.Enabled == nil {
		disabled := false
		next.Enabled = &disabled
	}
	if next.AutoSwitchThreshold == nil {
		defaultThreshold := 80
		next.AutoSwitchThreshold = &defaultThreshold
	}

	if a.configPersistence != nil {
		if err := a.configPersistence.Update(func(live *config.Config) {
			live.AnthropicAccountPool = &next
		}); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to save pool config")
			return
		}
	} else {
		a.mu.Lock()
		a.config.AnthropicAccountPool = &next
		a.mu.Unlock()
	}
	writeJSON(w, http.StatusOK, append(orderedJSONObject{{name: "ok", value: true}},
		anthropicPoolResponse(provider, &next)...))
}

func anthropicPoolProviderField(w http.ResponseWriter, raw map[string]json.RawMessage) (string, bool) {
	provider := ""
	if body, present := raw["provider"]; present {
		_ = json.Unmarshal(body, &provider)
	}
	provider = strings.ToLower(strings.TrimSpace(provider))
	if provider != anthropicPoolProvider {
		writeError(w, http.StatusBadRequest, "pool config is only supported for anthropic")
		return "", false
	}
	return provider, true
}
