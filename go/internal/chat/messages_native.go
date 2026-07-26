package chat

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/adapter/anthropic"
	"github.com/lidge-jun/opencodex-go/internal/claude"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

var anthropicPassthroughStripHeaders = map[string]struct{}{
	"connection": {}, "keep-alive": {}, "transfer-encoding": {}, "upgrade": {}, "te": {}, "trailer": {},
	"proxy-authenticate": {}, "proxy-authorization": {}, "host": {}, "content-length": {},
	"accept-encoding": {}, "x-opencodex-api-key": {}, "origin": {},
}

func (h *MessagesHandler) nativeAnthropicRequest(request *http.Request, raw []byte) ([]byte, string, bool) {
	if request == nil || !hasAnthropicNativeCredential(request.Header) {
		return nil, "", false
	}
	var body map[string]any
	if json.Unmarshal(raw, &body) != nil {
		return nil, "", false
	}
	model, _ := body["model"].(string)
	model = claude.StripOneMillionMarker(strings.TrimSpace(model))
	if route := claude.ExtractRouteDirective(body); route != "" {
		model = claude.StripOneMillionMarker(route)
	}
	lower := strings.ToLower(model)
	if (!strings.HasPrefix(lower, "claude") && !strings.HasPrefix(lower, "anthropic")) ||
		claude.ResolveInboundModel(model, h.config.claudeInboundConfig()) != model {
		return nil, "", false
	}
	if h.config.NativeAnthropic != nil && !h.config.NativeAnthropic(&types.ResolvedModel{Provider: "anthropic", Model: model}) {
		return nil, "", false
	}
	body["model"] = model
	encoded, err := json.Marshal(body)
	if err != nil {
		return nil, "", false
	}
	return encoded, model, true
}

func hasAnthropicNativeCredential(header http.Header) bool {
	bearer := ""
	if fields := strings.Fields(header.Get("Authorization")); len(fields) == 2 && strings.EqualFold(fields[0], "bearer") {
		bearer = fields[1]
	}
	return strings.HasPrefix(bearer, "sk-ant-") || strings.HasPrefix(strings.TrimSpace(header.Get("x-api-key")), "sk-ant-")
}

func (h *MessagesHandler) nativePassthrough(w http.ResponseWriter, r *http.Request, raw []byte, model, pathname string) bool {
	var body map[string]any
	if json.Unmarshal(raw, &body) != nil {
		writeAnthropicError(w, 400, "invalid request body")
		return false
	}
	body["model"] = model
	if messages, ok := body["messages"].([]any); ok {
		if err := anthropic.NormalizeAnthropicImages(messages); err != nil {
			writeAnthropicError(w, http.StatusBadRequest, err.Error())
			return false
		}
		anthropic.EnforceAnthropicImageLimits(messages)
	}
	payload, _ := json.Marshal(body)
	endpoint, err := nativeAnthropicURL(h.config.NativeAnthropicBaseURL, pathname, r.URL.RawQuery)
	if err != nil {
		writeAnthropicError(w, 502, err.Error())
		return false
	}
	request, err := http.NewRequestWithContext(r.Context(), http.MethodPost, endpoint, strings.NewReader(string(payload)))
	if err != nil {
		writeAnthropicError(w, 500, err.Error())
		return false
	}
	request.Header.Set("Content-Type", "application/json")
	for name, values := range r.Header {
		if _, blocked := anthropicPassthroughStripHeaders[strings.ToLower(name)]; blocked {
			continue
		}
		for _, value := range values {
			request.Header.Add(name, value)
		}
	}
	request.Header.Set("Content-Type", "application/json")
	result := DoWithHeaderDeadline(r.Context(), h.config.Client, request, h.config.ConnectTimeout)
	if result.TimedOut {
		writeAnthropicError(w, http.StatusGatewayTimeout, "anthropic passthrough timed out waiting for response headers")
		return false
	}
	if result.Err != nil {
		status := http.StatusBadGateway
		if r.Context().Err() != nil {
			status = 499
		}
		writeAnthropicError(w, status, result.Err.Error())
		return false
	}
	response := result.Response
	defer response.Body.Close()
	for _, name := range []string{"content-type", "request-id", "retry-after"} {
		if value := response.Header.Get(name); value != "" {
			w.Header().Set(name, value)
		}
	}
	contentType := strings.ToLower(response.Header.Get("Content-Type"))
	stream, _ := body["stream"].(bool)
	if stream && strings.Contains(contentType, "text/event-stream") {
		w.WriteHeader(response.StatusCode)
		err := WriteAnthropicPassthroughStream(r.Context(), w, response.Body, h.config.BodyStall, h.config.ResponseLimit, nil)
		return err == nil && response.StatusCode >= 200 && response.StatusCode < 300
	}
	bodyResult := ReadBoundedPassthroughBody(r.Context(), response.Body, h.config.BodyStall, h.config.ResponseLimit)
	if bodyResult.Err != nil {
		switch bodyResult.CloseReason {
		case "client_cancel":
			writeAnthropicError(w, 499, "client closed request during anthropic passthrough")
		case "body_stall":
			writeAnthropicError(w, http.StatusGatewayTimeout, bodyResult.Err.Error())
		case "body_overflow":
			writeAnthropicError(w, http.StatusBadGateway, bodyResult.Err.Error())
		default:
			writeAnthropicError(w, http.StatusBadGateway, bodyResult.Err.Error())
		}
		return false
	}
	w.WriteHeader(response.StatusCode)
	_, _ = w.Write(bodyResult.Data)
	return response.StatusCode >= 200 && response.StatusCode < 300
}

func nativeAnthropicURL(base, pathname, rawQuery string) (string, error) {
	base = strings.TrimRight(strings.TrimSpace(base), "/")
	if base == "" {
		base = "https://api.anthropic.com"
	}
	parsed, err := url.Parse(base)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", fmt.Errorf("invalid Anthropic base URL %q", base)
	}
	if pathname == "" {
		pathname = "/v1/messages"
	}
	base = strings.TrimSuffix(base, "/v1")
	base = strings.TrimSuffix(base, "/v1/messages")
	endpoint := base + pathname
	if rawQuery != "" {
		endpoint += "?" + rawQuery
	}
	return endpoint, nil
}
