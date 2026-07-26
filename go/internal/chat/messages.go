package chat

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/claude"
	ocxlib "github.com/lidge-jun/opencodex-go/internal/lib"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

type MessagesHandler struct{ config HandlerConfig }

var _ types.RouteHandler = (*MessagesHandler)(nil)

func NewMessagesHandler(config HandlerConfig) *MessagesHandler {
	return &MessagesHandler{config: withHandlerDefaults(config)}
}

func (h *MessagesHandler) Handle(w http.ResponseWriter, r *http.Request) {
	if h.config.ClaudeEnabled != nil && !*h.config.ClaudeEnabled {
		writeAnthropicJSON(w, http.StatusForbidden, anthropicErrorBody(http.StatusForbidden, "Claude inbound is disabled", "permission_error"))
		return
	}
	raw, err := readRequestBody(w, r, h.config.BodyLimit)
	if err != nil {
		writeAnthropicError(w, 400, err.Error())
		return
	}
	if h.config.ClaudeDebug != nil {
		var debugBody map[string]any
		if json.Unmarshal(raw, &debugBody) == nil {
			model, _ := debugBody["model"].(string)
			if route := claude.ExtractRouteDirective(debugBody); route != "" {
				model = route
			}
			resolved := claude.ResolveInboundModel(claude.StripOneMillionMarker(strings.TrimSpace(model)), h.config.claudeInboundConfig())
			h.config.ClaudeDebug.Capture("messages", debugBody, resolved, r.Header.Get("anthropic-beta"))
		}
	}
	if nativeBody, nativeModel, ok := h.nativeAnthropicRequest(r, raw); ok {
		h.nativePassthrough(w, r, nativeBody, nativeModel, "/v1/messages")
		return
	}
	translation, err := claude.TranslateAnthropicRequest(raw, h.config.claudeInboundConfig())
	if err != nil {
		writeAnthropicError(w, 400, err.Error())
		return
	}
	normalized, requestedModel := translation.Request, translation.RequestedModel
	clientStream := normalized.Stream
	desktop := translation.Surface == claude.InboundSurfaceClaudeDesktop
	if desktop {
		claude.RecordDesktopRequest()
	}
	recordDesktopError := func() {
		if desktop {
			claude.RecordDesktopError()
		}
	}
	incoming := r.Header.Clone()
	if sessionID, ok := claude.PromptCacheSessionID(normalized.Options.PromptCacheKey, translation.CacheKeySource); ok {
		incoming.Set("session_id", sessionID)
	}
	prepared, err := h.config.prepare(r.Context(), incoming, normalized)
	if err != nil {
		recordDesktopError()
		writeAnthropicErrorFor(w, err)
		return
	}
	internal := *normalized
	internal.Stream = true
	prepared.normalized = &internal
	h.config.applyReasoningSafety(prepared)
	if events, handled, err := h.config.runSearch(r.Context(), prepared); handled {
		if err != nil {
			recordDesktopError()
			writeAnthropicError(w, http.StatusBadGateway, err.Error())
			return
		}
		if clientStream {
			if err := writeAnthropicStream(r.Context(), w, requestedModel, adapterEventChannel(events)); err != nil {
				recordDesktopError()
			}
			return
		}
		message, err := buildAnthropicMessage(events, requestedModel)
		if err != nil {
			recordDesktopError()
			writeAnthropicErrorFor(w, err)
			return
		}
		writeJSON(w, http.StatusOK, message)
		return
	}
	var response *http.Response
	var streamEvents <-chan types.AdapterEvent
	var unaryEvents []types.AdapterEvent
	response, streamEvents, err = h.config.doStream(r.Context(), prepared)
	if err == nil && !clientStream && response != nil && response.StatusCode >= 200 && response.StatusCode < 300 {
		unaryEvents, err = collectAdapterEvents(r.Context(), streamEvents)
	}
	if err != nil {
		recordDesktopError()
		writeAnthropicErrorFor(w, err)
		return
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		recordDesktopError()
		defer response.Body.Close()
		payload, _ := readBounded(response.Body, min64(h.config.ResponseLimit, 1<<20))
		message := fmt.Sprintf("Provider error %d: %s", response.StatusCode, ocxlib.RedactSecretString(string(payload)))
		if len(message) > len(fmt.Sprintf("Provider error %d: ", response.StatusCode))+500 {
			message = message[:len(fmt.Sprintf("Provider error %d: ", response.StatusCode))+500]
		}
		status := response.StatusCode
		if ocxlib.IsTransientUpstreamStatus(status) {
			status = 529
			w.Header().Set("Retry-After", "2")
		}
		writeAnthropicError(w, status, message)
		return
	}
	if clientStream {
		if err := writeAnthropicStream(r.Context(), w, requestedModel, streamEvents); err != nil {
			recordDesktopError()
		}
		return
	}
	message, err := buildAnthropicMessage(unaryEvents, requestedModel)
	if err != nil {
		recordDesktopError()
		writeAnthropicErrorFor(w, err)
		return
	}
	writeJSON(w, 200, message)
}

func parseAnthropicInbound(raw []byte) (*types.NormalizedRequest, string, error) {
	translated, err := claude.TranslateAnthropicRequest(raw, nil)
	return translated.Request, translated.RequestedModel, err
}

func parseAnthropicInboundWithConfig(raw []byte, cfg *claude.InboundConfig) (*types.NormalizedRequest, string, claude.InboundSurface, error) {
	translated, err := claude.TranslateAnthropicRequest(raw, cfg)
	return translated.Request, translated.RequestedModel, translated.Surface, err
}
