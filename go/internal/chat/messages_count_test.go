package chat

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

func TestCountTokensHandlerMatchesAnthropicContract(t *testing.T) {
	handler := NewCountTokensHandler(HandlerConfig{})
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/v1/messages/count_tokens", strings.NewReader(`{"model":"claude-sonnet[1M]","system":"system","messages":[{"role":"user","content":"한국어 메시지입니다"}],"tools":[{"name":"run"}]}`))
	handler.Handle(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"input_tokens":`) || response.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("response=%d headers=%v body=%s", response.Code, response.Header(), response.Body.String())
	}

	missing := httptest.NewRecorder()
	handler.Handle(missing, httptest.NewRequest(http.MethodPost, "/v1/messages/count_tokens", strings.NewReader(`{"messages":[]}`)))
	if missing.Code != http.StatusBadRequest || !strings.Contains(missing.Body.String(), `"type":"invalid_request_error"`) || !strings.Contains(missing.Body.String(), "model is required") {
		t.Fatalf("missing model=%d %s", missing.Code, missing.Body.String())
	}
}

func TestCountTokensHandlerHonorsRouteDirective(t *testing.T) {
	handler := NewCountTokensHandler(HandlerConfig{})
	count := func(system string) int {
		response := httptest.NewRecorder()
		body := `{"model":"fallback","system":` + system + `,"messages":[{"role":"user","content":"12345678"}]}`
		handler.Handle(response, httptest.NewRequest(http.MethodPost, "/v1/messages/count_tokens", strings.NewReader(body)))
		var decoded map[string]int
		if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &decoded) != nil {
			t.Fatalf("response=%d %s", response.Code, response.Body.String())
		}
		return decoded["input_tokens"]
	}
	plain := count(`"<!-- no route -->"`)
	routed := count(`"<!-- ocx-route: claude-opus -->"`)
	if routed <= plain {
		t.Fatalf("route directive did not select the Claude estimator: plain=%d routed=%d", plain, routed)
	}
}

func TestClaudeDisabledRejectsMessagesAndCountTokens(t *testing.T) {
	disabled := false
	config := HandlerConfig{ClaudeEnabled: &disabled}
	for _, handler := range []types.RouteHandler{NewMessagesHandler(config), NewCountTokensHandler(config)} {
		response := httptest.NewRecorder()
		handler.Handle(response, httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(`{"model":"m","messages":[{"role":"user","content":"x"}]}`)))
		if response.Code != http.StatusForbidden || !strings.Contains(response.Body.String(), `"type":"permission_error"`) {
			t.Fatalf("disabled response=%d %s", response.Code, response.Body.String())
		}
	}
}
