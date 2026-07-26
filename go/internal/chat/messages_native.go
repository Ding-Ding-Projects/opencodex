package chat

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

func (h *MessagesHandler) shouldPassthrough(model *types.ResolvedModel) bool {
	if h.config.NativeAnthropic != nil {
		return h.config.NativeAnthropic(model)
	}
	provider := strings.ToLower(model.Provider)
	return provider == "anthropic" || provider == "claude"
}

func (h *MessagesHandler) nativePassthrough(w http.ResponseWriter, r *http.Request, raw []byte, prepared *preparedRequest) bool {
	var body map[string]any
	if json.Unmarshal(raw, &body) != nil {
		writeAnthropicError(w, 400, "invalid request body")
		return false
	}
	body["model"] = prepared.resolved.Model
	payload, _ := json.Marshal(body)
	endpoint, err := nativeMessagesURL(prepared.transport.BaseURL)
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
	for _, name := range []string{"anthropic-version", "anthropic-beta", "accept"} {
		if value := r.Header.Get(name); value != "" {
			request.Header.Set(name, value)
		}
	}
	for name, value := range prepared.transport.Headers {
		request.Header.Set(name, value)
	}
	if prepared.auth != nil {
		for name, value := range prepared.auth.Headers {
			request.Header.Set(name, value)
		}
		if prepared.auth.APIKey != "" {
			request.Header.Set("x-api-key", prepared.auth.APIKey)
		}
		if prepared.auth.AccessToken != "" {
			request.Header.Set("Authorization", "Bearer "+prepared.auth.AccessToken)
		}
	}
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
	if prepared.normalized.Stream && strings.Contains(contentType, "text/event-stream") {
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

func nativeMessagesURL(base string) (string, error) {
	base = strings.TrimRight(strings.TrimSpace(base), "/")
	parsed, err := url.Parse(base)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", fmt.Errorf("invalid Anthropic base URL %q", base)
	}
	if strings.HasSuffix(base, "/v1/messages") {
		return base, nil
	}
	base = strings.TrimSuffix(base, "/v1")
	return base + "/v1/messages", nil
}
