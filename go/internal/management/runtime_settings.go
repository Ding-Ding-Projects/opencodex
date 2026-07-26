package management

import (
	"context"
	"encoding/json"
	"net/http"
	"runtime"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/claude"
	"github.com/lidge-jun/opencodex-go/internal/codex"
	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

func (a *API) handleRuntimeSettings(w http.ResponseWriter, r *http.Request) bool {
	switch r.URL.Path {
	case "/api/subagent-model-fallback":
		if r.Method == http.MethodGet {
			a.getSubagentFallback(w)
			return true
		}
		if r.Method == http.MethodPut {
			a.putSubagentFallback(w, r)
			return true
		}
	case "/api/claude-code":
		if r.Method == http.MethodGet {
			a.getClaudeCode(w, r)
			return true
		}
		if r.Method == http.MethodPut {
			a.putClaudeCode(w, r)
			return true
		}
	case "/api/shadow-call-settings":
		if r.Method == http.MethodGet {
			a.getShadowCall(w)
			return true
		}
		if r.Method == http.MethodPut {
			a.putShadowCall(w, r)
			return true
		}
	case "/api/provider-quotas":
		if r.Method == http.MethodGet {
			a.getProviderQuotas(w, r)
			return true
		}
	}
	return false
}

func (a *API) availableModels() []string {
	seen := map[string]bool{}
	result := []string{}
	if a.registry != nil {
		for _, model := range a.registry.ListModels() {
			slug := model.ID
			if model.Provider != "" {
				slug = model.Provider + "/" + model.ID
			}
			if slug != "" && !seen[slug] {
				seen[slug] = true
				result = append(result, slug)
			}
		}
	}
	return result
}

func (a *API) getSubagentFallback(w http.ResponseWriter) {
	a.mu.RLock()
	models := append([]string(nil), a.config.SubagentModelFallback...)
	poll := a.config.SubagentModelFallbackPollMS
	a.mu.RUnlock()
	if models == nil {
		models = []string{}
	}
	if poll == 0 {
		poll = 60_000
	}
	writeJSON(w, http.StatusOK, orderedJSONObject{{name: "models", value: models}, {name: "pollMs", value: poll}, {name: "available", value: a.availableModels()}})
}

func (a *API) putSubagentFallback(w http.ResponseWriter, r *http.Request) {
	var body map[string]json.RawMessage
	if !decodeJSON(w, r, &body) {
		return
	}
	a.mu.RLock()
	models := append([]string(nil), a.config.SubagentModelFallback...)
	poll := a.config.SubagentModelFallbackPollMS
	a.mu.RUnlock()
	if raw, exists := body["models"]; exists {
		var values []any
		if json.Unmarshal(raw, &values) != nil {
			writeError(w, 400, "models must be an array")
			return
		}
		models = []string{}
		for i, value := range values {
			text, ok := value.(string)
			if !ok || strings.TrimSpace(text) == "" {
				writeJSON(w, 400, orderedJSONObject{{name: "error", value: "models[" + intStringManagement(i) + "] must be a non-empty string"}, {name: "index", value: i}, {name: "value", value: value}})
				return
			}
			models = append(models, strings.TrimSpace(text))
		}
	}
	if raw, exists := body["pollMs"]; exists {
		if string(raw) == "null" || string(raw) == `""` {
			poll = 0
		} else {
			var value int
			if json.Unmarshal(raw, &value) != nil || value < 5000 || value > 600000 {
				writeError(w, 400, "pollMs must be an integer between 5000 and 600000")
				return
			}
			poll = value
		}
	}
	a.mu.Lock()
	oldModels, oldPoll := a.config.SubagentModelFallback, a.config.SubagentModelFallbackPollMS
	a.config.SubagentModelFallback, a.config.SubagentModelFallbackPollMS = models, poll
	err := a.saveLocked()
	if err != nil {
		a.config.SubagentModelFallback, a.config.SubagentModelFallbackPollMS = oldModels, oldPoll
	}
	a.mu.Unlock()
	if err != nil {
		writeError(w, 500, "save subagent model fallback failed")
		return
	}
	if models == nil {
		models = []string{}
	}
	if poll == 0 {
		poll = 60000
	}
	writeJSON(w, 200, orderedJSONObject{{name: "ok", value: true}, {name: "models", value: models}, {name: "pollMs", value: poll}})
}

type claudeAlias struct {
	ID          string `json:"id"`
	DisplayName string `json:"display_name"`
}

func (a *API) getClaudeCode(w http.ResponseWriter, r *http.Request) {
	a.mu.RLock()
	fullConfig := *a.config
	cfg := cloneClaudeConfig(a.config.ClaudeCode)
	fastMode := a.config.FastMode
	port := a.config.Port
	a.mu.RUnlock()
	if cfg == nil {
		cfg = &config.ClaudeCodeConfig{}
	}
	available := a.availableModels()
	aliases := make([]claudeAlias, 0, len(available))
	windows, _ := claude.BoundedContextWindows(r.Context(), 3*time.Second, func(context.Context) (map[string]int, error) {
		return managementClaudeContextWindows(fullConfig, a.registry), nil
	})
	if a.registry != nil {
		for _, m := range a.registry.ListModels() {
			alias := m.ID
			if !(m.Provider == "anthropic" && strings.HasPrefix(m.ID, "claude-")) && m.Provider != "" && !strings.Contains(m.Provider, "--") && !strings.Contains(m.Provider, "/") && !strings.Contains(m.ID, "/") {
				alias = "claude-ocx-" + m.Provider + "--" + m.ID
			}
			aliases = append(aliases, claudeAlias{ID: alias, DisplayName: m.ID + " (" + m.Provider + ")"})
		}
	}
	tiers := claude.ClaudeTierModels{}
	if cfg.TierModels != nil {
		tiers = claude.ClaudeTierModels{Opus: cfg.TierModels.Opus, Sonnet: cfg.TierModels.Sonnet, Haiku: cfg.TierModels.Haiku, Fable: cfg.TierModels.Fable}
	}
	auto := claude.ResolveAutoContext(&claude.ContextConfig{AutoContext: cfg.AutoContext, AutoCompactWindow: cfg.AutoCompactWindow, MaxContextTokens: cfg.MaxContextTokens}, "")
	modelEnv := claude.EffectiveModelEnv(&claude.ModelEnvConfig{
		ContextConfig: claude.ContextConfig{AutoContext: cfg.AutoContext, AutoCompactWindow: cfg.AutoCompactWindow, MaxContextTokens: cfg.MaxContextTokens},
		Model:         cfg.Model, SmallFastModel: cfg.SmallFastModel, TierModels: tiers,
	}, windows, &auto)
	fields := orderedJSONObject{{name: "enabled", value: cfg.Enabled == nil || *cfg.Enabled}, {name: "authMode", value: func() string {
		if cfg.AuthMode == "proxy" {
			return "proxy"
		}
		return "subscription"
	}()}, {name: "model", value: cfg.Model}, {name: "smallFastModel", value: cfg.SmallFastModel}, {name: "tierModels", value: claudeTierMap(cfg.TierModels)}, {name: "modelMap", value: nonNilStringMap(cfg.ModelMap)}, {name: "systemEnv", value: cfg.SystemEnv}, {name: "autoConnectSupported", value: runtime.GOOS == "darwin"}, {name: "maxContextTokens", value: nullableInt(cfg.MaxContextTokens)}, {name: "alwaysEnableEffort", value: cfg.AlwaysEnableEffort}, {name: "autoContext", value: cfg.AutoContext == nil || *cfg.AutoContext}, {name: "autoCompactWindow", value: nullableInt(cfg.AutoCompactWindow)}, {name: "blockedSkills", value: nullableStrings(cfg.BlockedSkills)}, {name: "injectAgents", value: cfg.InjectAgents == nil || *cfg.InjectAgents}}
	if cfg.WebSearchSidecar != nil {
		fields = append(fields, orderedJSONField{name: "webSearchSidecar", value: cfg.WebSearchSidecar})
	}
	if cfg.VisionSidecar != nil {
		fields = append(fields, orderedJSONField{name: "visionSidecar", value: cfg.VisionSidecar})
	}
	if fastMode != nil {
		fields = append(fields, orderedJSONField{name: "fastMode", value: *fastMode})
	}
	fields = append(fields, orderedJSONField{name: "contextWindows", value: windows}, orderedJSONField{name: "effectiveModelEnv", value: modelEnv}, orderedJSONField{name: "available", value: available}, orderedJSONField{name: "aliases", value: aliases}, orderedJSONField{name: "port", value: port})
	writeJSON(w, 200, fields)
}

func managementClaudeContextWindows(cfg config.Config, registry types.Registry) map[string]int {
	var listed []types.ModelEntry
	if registry != nil {
		listed = registry.ListModels()
	}
	models := codex.FilterVisibleRuntimeModels(listed, cfg)
	native := make(map[string]int)
	routed := make([]claude.ContextModel, 0, len(models))
	for _, model := range models {
		id := strings.TrimPrefix(model.ID, model.Provider+"/")
		if model.Provider == "openai" && !strings.Contains(model.ID, "/") {
			native[model.ID] = model.ContextWindow
			continue
		}
		routed = append(routed, claude.ContextModel{Provider: model.Provider, ID: id, ContextWindow: model.ContextWindow})
	}
	return claude.BuildClaudeContextWindows(native, routed)
}

func (a *API) putClaudeCode(w http.ResponseWriter, r *http.Request) {
	var body map[string]json.RawMessage
	if !decodeJSON(w, r, &body) {
		return
	}
	a.mu.RLock()
	next := cloneClaudeConfig(a.config.ClaudeCode)
	oldFast := a.config.FastMode
	a.mu.RUnlock()
	if next == nil {
		next = &config.ClaudeCodeConfig{}
	}
	boolField := func(name string, target **bool, defaultOn bool) bool {
		raw, ok := body[name]
		if !ok {
			return true
		}
		var value bool
		if json.Unmarshal(raw, &value) != nil {
			writeError(w, 400, name+" must be a boolean")
			return false
		}
		if defaultOn && value {
			*target = nil
		} else {
			copy := value
			*target = &copy
		}
		return true
	}
	if !boolField("enabled", &next.Enabled, false) || !boolField("autoContext", &next.AutoContext, true) || !boolField("injectAgents", &next.InjectAgents, true) {
		return
	}
	for name, target := range map[string]*bool{"systemEnv": &next.SystemEnv, "alwaysEnableEffort": &next.AlwaysEnableEffort} {
		if raw, ok := body[name]; ok {
			var value bool
			if json.Unmarshal(raw, &value) != nil {
				writeError(w, 400, name+" must be a boolean")
				return
			}
			*target = value
		}
	}
	if raw, ok := body["authMode"]; ok {
		var value string
		if json.Unmarshal(raw, &value) != nil || (value != "proxy" && value != "subscription") {
			writeError(w, 400, "authMode must be \"proxy\" or \"subscription\"")
			return
		}
		if value == "proxy" {
			next.AuthMode = "proxy"
		} else {
			next.AuthMode = ""
		}
	}
	for name, target := range map[string]*string{"model": &next.Model, "smallFastModel": &next.SmallFastModel} {
		if raw, ok := body[name]; ok {
			var value string
			if json.Unmarshal(raw, &value) != nil {
				writeError(w, 400, name+" must be a string")
				return
			}
			*target = strings.TrimSpace(value)
		}
	}
	if raw, ok := body["maxContextTokens"]; ok {
		if string(raw) == "null" {
			next.MaxContextTokens = 0
		} else {
			var value int
			if json.Unmarshal(raw, &value) != nil || value <= 0 {
				writeError(w, 400, "maxContextTokens must be a positive integer or null")
				return
			}
			next.MaxContextTokens = value
		}
	}
	if raw, ok := body["autoCompactWindow"]; ok {
		if string(raw) == "null" {
			next.AutoCompactWindow = 0
		} else {
			var value int
			if json.Unmarshal(raw, &value) != nil || value < 100000 || value > 1000000 {
				writeError(w, 400, "autoCompactWindow must be an integer between 100000 and 1000000, or null")
				return
			}
			next.AutoCompactWindow = value
		}
	}
	if raw, ok := body["blockedSkills"]; ok {
		if string(raw) == "null" {
			next.BlockedSkills = nil
		} else {
			var values []string
			if json.Unmarshal(raw, &values) != nil {
				writeError(w, 400, "blockedSkills must be an array of non-empty strings, or null")
				return
			}
			for i := range values {
				values[i] = strings.TrimSpace(values[i])
				if values[i] == "" {
					writeError(w, 400, "blockedSkills must be an array of non-empty strings, or null")
					return
				}
			}
			next.BlockedSkills = values
		}
	}
	if raw, ok := body["modelMap"]; ok {
		if string(raw) == "null" {
			next.ModelMap = nil
		} else {
			var values map[string]string
			if json.Unmarshal(raw, &values) != nil {
				writeError(w, 400, "modelMap must be an object of string->string, or null")
				return
			}
			clean := map[string]string{}
			for k, v := range values {
				k, v = strings.TrimSpace(k), strings.TrimSpace(v)
				if k == "" || v == "" {
					writeError(w, 400, "modelMap entries must be non-empty strings")
					return
				}
				clean[k] = v
			}
			next.ModelMap = clean
		}
	}
	if raw, ok := body["fastMode"]; ok {
		if string(raw) == "null" {
			oldFast = nil
		} else {
			var value bool
			if json.Unmarshal(raw, &value) != nil {
				writeError(w, 400, "fastMode must be true, false, or null")
				return
			}
			oldFast = &value
		}
	}
	for name, target := range map[string]**config.ClaudeSidecarOverride{"webSearchSidecar": &next.WebSearchSidecar, "visionSidecar": &next.VisionSidecar} {
		if raw, ok := body[name]; ok {
			if string(raw) == "null" || string(raw) == "{}" {
				*target = nil
				continue
			}
			var value config.ClaudeSidecarOverride
			if json.Unmarshal(raw, &value) != nil || (value.Backend != "" && value.Backend != "openai" && value.Backend != "anthropic") {
				writeError(w, 400, name+".backend must be openai, anthropic, or null")
				return
			}
			*target = &value
		}
	}
	a.mu.Lock()
	previous, previousFast := a.config.ClaudeCode, a.config.FastMode
	a.config.ClaudeCode, a.config.FastMode = next, oldFast
	err := a.saveLocked()
	if err != nil {
		a.config.ClaudeCode, a.config.FastMode = previous, previousFast
	}
	a.mu.Unlock()
	if err != nil {
		writeError(w, 500, "save Claude Code settings failed")
		return
	}
	warnings := []string{}
	if a.claudeRuntime != nil {
		if _, ok := body["systemEnv"]; ok {
			if err := a.claudeRuntime.ApplyClaudeCodeSystemEnv(r.Context()); err != nil {
				warnings = append(warnings, "Failed to apply system environment setting: "+err.Error())
			}
		} else if _, ok := body["authMode"]; ok {
			if err := a.claudeRuntime.ApplyClaudeCodeSystemEnv(r.Context()); err != nil {
				warnings = append(warnings, "Failed to apply system environment setting: "+err.Error())
			}
		}
		_ = a.claudeRuntime.SyncClaudeAgentDefinitions(r.Context())
	}
	writeJSON(w, 200, orderedJSONObject{{name: "ok", value: true}, {name: "enabled", value: next.Enabled == nil || *next.Enabled}, {name: "warnings", value: warnings}})
}

func (a *API) getShadowCall(w http.ResponseWriter) {
	a.mu.RLock()
	cfg := a.config.ShadowCallIntercept
	a.mu.RUnlock()
	enabled, model := false, ""
	if cfg != nil {
		enabled, model = cfg.Enabled, cfg.Model
	}
	writeJSON(w, 200, orderedJSONObject{{name: "enabled", value: enabled}, {name: "model", value: model}})
}
func (a *API) putShadowCall(w http.ResponseWriter, r *http.Request) {
	var body map[string]json.RawMessage
	if !decodeJSON(w, r, &body) {
		return
	}
	a.mu.RLock()
	old := a.config.ShadowCallIntercept
	next := &config.ShadowCallInterceptConfig{}
	if old != nil {
		*next = *old
		next.SourceModels = append([]string(nil), old.SourceModels...)
	}
	a.mu.RUnlock()
	if raw, ok := body["enabled"]; ok {
		if json.Unmarshal(raw, &next.Enabled) != nil {
			writeError(w, 400, "enabled must be a boolean")
			return
		}
	}
	if raw, ok := body["model"]; ok {
		if json.Unmarshal(raw, &next.Model) != nil {
			writeError(w, 400, "model must be a string")
			return
		}
		if next.Model == "" {
			next.Model = ""
		}
	}
	a.mu.Lock()
	a.config.ShadowCallIntercept = next
	err := a.saveLocked()
	if err != nil {
		a.config.ShadowCallIntercept = old
	}
	a.mu.Unlock()
	if err != nil {
		writeError(w, 500, "save shadow call settings failed")
		return
	}
	writeJSON(w, 200, orderedJSONObject{{name: "ok", value: true}, {name: "enabled", value: next.Enabled}, {name: "model", value: next.Model}})
}
func (a *API) getProviderQuotas(w http.ResponseWriter, r *http.Request) {
	if a.providerQuotas == nil {
		writeJSON(w, 200, ProviderQuotaResponse{GeneratedAt: time.Now().UnixMilli(), Reports: []ProviderQuotaReport{}})
		return
	}
	refresh := r.URL.Query().Get("refresh")
	result, err := a.providerQuotas.ProviderQuotas(r.Context(), refresh == "1" || refresh == "true")
	if err != nil {
		writeBackendError(w, err, "Provider quotas could not be read")
		return
	}
	if result.Reports == nil {
		result.Reports = []ProviderQuotaReport{}
	}
	writeJSON(w, 200, result)
}

func cloneClaudeConfig(value *config.ClaudeCodeConfig) *config.ClaudeCodeConfig {
	if value == nil {
		return nil
	}
	copy := *value
	copy.ModelMap = cloneStringMap(value.ModelMap)
	copy.BlockedSkills = append([]string(nil), value.BlockedSkills...)
	if value.TierModels != nil {
		tier := *value.TierModels
		copy.TierModels = &tier
	}
	if value.WebSearchSidecar != nil {
		side := *value.WebSearchSidecar
		copy.WebSearchSidecar = &side
	}
	if value.VisionSidecar != nil {
		side := *value.VisionSidecar
		copy.VisionSidecar = &side
	}
	return &copy
}
func claudeTierMap(value *config.ClaudeTierModels) map[string]string {
	result := map[string]string{}
	if value != nil {
		if value.Opus != "" {
			result["opus"] = value.Opus
		}
		if value.Sonnet != "" {
			result["sonnet"] = value.Sonnet
		}
		if value.Haiku != "" {
			result["haiku"] = value.Haiku
		}
		if value.Fable != "" {
			result["fable"] = value.Fable
		}
	}
	return result
}
func nonNilStringMap(value map[string]string) map[string]string {
	if value == nil {
		return map[string]string{}
	}
	return value
}
func nullableInt(value int) any {
	if value == 0 {
		return nil
	}
	return value
}
func nullableStrings(value []string) any {
	if value == nil {
		return nil
	}
	return value
}
func intStringManagement(value int) string {
	if value == 0 {
		return "0"
	}
	digits := ""
	for value > 0 {
		digits = string(rune('0'+value%10)) + digits
		value /= 10
	}
	return digits
}
