package chat

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/claude"
	"github.com/lidge-jun/opencodex-go/internal/lib"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

// CountTokensHandler implements Anthropic's count_tokens compatibility route.
// Routed providers use the same deterministic approximation as the TypeScript
// server; native passthrough remains an adapter-level concern.
type CountTokensHandler struct{ config HandlerConfig }

var _ types.RouteHandler = (*CountTokensHandler)(nil)

func NewCountTokensHandler(config HandlerConfig) *CountTokensHandler {
	return &CountTokensHandler{config: withHandlerDefaults(config)}
}

func (h *CountTokensHandler) Handle(w http.ResponseWriter, request *http.Request) {
	if h.config.ClaudeEnabled != nil && !*h.config.ClaudeEnabled {
		writeAnthropicJSON(w, http.StatusForbidden, anthropicErrorBody(http.StatusForbidden, "Claude inbound is disabled", "permission_error"))
		return
	}
	raw, err := readRequestBody(w, request, h.config.BodyLimit)
	if err != nil {
		writeAnthropicError(w, http.StatusBadRequest, err.Error())
		return
	}
	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil || body == nil {
		writeAnthropicError(w, http.StatusBadRequest, "request body must be a JSON object")
		return
	}
	model, _ := body["model"].(string)
	model = claude.StripOneMillionMarker(strings.TrimSpace(model))
	if model == "" {
		writeAnthropicError(w, http.StatusBadRequest, "model is required")
		return
	}
	if routed := claude.ExtractRouteDirective(body); routed != "" {
		model = claude.StripOneMillionMarker(routed)
	}
	parts := make([]string, 0, 3)
	for _, field := range []string{"system", "messages", "tools"} {
		value, exists := body[field]
		if !exists {
			continue
		}
		if text, ok := value.(string); ok && field == "system" {
			parts = append(parts, text)
			continue
		}
		encoded, err := json.Marshal(value)
		if err == nil {
			parts = append(parts, string(encoded))
		}
	}
	inputTokens := lib.EstimateTokens(strings.Join(parts, "\n"), model)
	if inputTokens < 1 {
		inputTokens = 1
	}
	writeJSON(w, http.StatusOK, map[string]int{"input_tokens": inputTokens})
}
