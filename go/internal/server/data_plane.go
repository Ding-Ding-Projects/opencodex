package server

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/claude"
	"github.com/lidge-jun/opencodex-go/internal/codex"
	appconfig "github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

func (s *Server) handleModels(w http.ResponseWriter, request *http.Request) {
	if s.config.Registry == nil {
		writeJSONError(w, http.StatusServiceUnavailable, "server_not_configured", "model registry is not configured")
		return
	}
	models := s.config.Registry.ListModels()
	if s.config.ManagementConfig != nil {
		models = codex.FilterVisibleRuntimeModels(models, *s.config.ManagementConfig)
	}
	wantsAnthropic := request.Header.Get("anthropic-version") != "" || request.URL.Query().Get("flavor") == "anthropic"
	if wantsAnthropic && request.URL.Query().Get("client_version") == "" {
		if s.config.ManagementConfig != nil && s.config.ManagementConfig.ClaudeCode != nil && s.config.ManagementConfig.ClaudeCode.Enabled != nil && !*s.config.ManagementConfig.ClaudeCode.Enabled {
			writeModelsJSON(w, map[string]any{"data": []claude.ModelInfo{}})
			return
		}
		native, routed := claudeDiscoveryModels(models, s.config.ManagementConfig)
		auto := claude.AutoContextOff
		if s.config.ManagementConfig != nil && s.config.ManagementConfig.ClaudeCode != nil {
			auto = claude.ResolveAutoContext(&claude.ContextConfig{
				AutoContext: s.config.ManagementConfig.ClaudeCode.AutoContext, AutoCompactWindow: s.config.ManagementConfig.ClaudeCode.AutoCompactWindow,
				MaxContextTokens: s.config.ManagementConfig.ClaudeCode.MaxContextTokens,
			}, "")
		}
		style := claude.AnthropicIDDesktop3P
		switch request.URL.Query().Get("ids") {
		case "cli":
			style = claude.AnthropicIDReadable
		case "desktop":
		default:
			if strings.HasPrefix(strings.ToLower(request.Header.Get("User-Agent")), "claude-code/") {
				style = claude.AnthropicIDReadable
			}
		}
		data := claude.BuildModelInfosWithAlias(native, routed, auto, style, claude.ActiveDesktop3pAlias)
		writeModelsJSON(w, map[string]any{"data": data})
		return
	}
	data := make([]map[string]any, 0, len(models))
	seen := make(map[string]struct{}, len(models))
	for _, model := range models {
		id := model.ID
		if _, exists := seen[id]; exists {
			continue
		}
		seen[id] = struct{}{}
		data = append(data, map[string]any{"id": id, "object": "model", "created": 0, "owned_by": model.Provider})
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"object": "list", "data": data})
}

func writeModelsJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(value)
}

func claudeDiscoveryModels(models []types.ModelEntry, cfg *appconfig.Config) (native, routed []claude.DiscoveryModel) {
	for _, model := range models {
		id := strings.TrimPrefix(model.ID, model.Provider+"/")
		discovery := claude.DiscoveryModel{
			Provider: model.Provider, ID: id, DisplayName: model.DisplayName,
			ReasoningEfforts: append([]string(nil), model.ReasoningEfforts...), ContextWindow: model.ContextWindow,
		}
		if model.Provider == "openai" && !strings.Contains(model.ID, "/") {
			discovery.ID, discovery.ImageInput = model.ID, true
			native = append(native, discovery)
			continue
		}
		discovery.ImageInput = claudeModelImageInput(cfg, model.Provider, id)
		routed = append(routed, discovery)
	}
	return native, routed
}

func claudeModelImageInput(cfg *appconfig.Config, provider, model string) bool {
	if cfg == nil {
		return false
	}
	configured, ok := cfg.Providers[provider]
	if !ok || types.ModelInList(configured.NoVisionModels, model) {
		return false
	}
	for _, modality := range configured.ModelInputModalities[model] {
		if modality == "image" {
			return true
		}
	}
	return false
}

func unknownV1(w http.ResponseWriter, request *http.Request) {
	writeClassifiedJSONError(w, http.StatusNotFound, "not_found", "Unknown endpoint: "+request.Method+" "+request.URL.Path)
}
