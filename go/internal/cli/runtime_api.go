package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// RuntimeAPIError mirrors the TypeScript RuntimeApiError: it carries the HTTP
// status and the decoded body so callers can react to the status, not the text.
type RuntimeAPIError struct {
	Message string
	Status  int
	Body    any
}

func (e *RuntimeAPIError) Error() string { return e.Message }

// runtimeAPI is the management-plane client shared by the headless CLI
// commands. The oracle equivalent is src/cli/runtime-api.ts: find the live
// proxy, send the request with the management headers, then translate a
// non-2xx response into a message the user can act on.
type runtimeAPI struct {
	// BaseURL short-circuits proxy discovery. Tests inject an httptest URL.
	BaseURL string
	Client  *http.Client
	Headers map[string]string
}

func (api runtimeAPI) client() *http.Client {
	if api.Client != nil {
		return api.Client
	}
	return http.DefaultClient
}

// runtimeBaseURL resolves the management base URL, preferring an explicit
// override and otherwise probing for a live proxy.
func (api runtimeAPI) runtimeBaseURL(ctx context.Context, cfg *managementTarget) (string, error) {
	if strings.TrimSpace(api.BaseURL) != "" {
		return strings.TrimRight(api.BaseURL, "/"), nil
	}
	if cfg == nil || cfg.Hostname == "" || cfg.Port == 0 {
		return "", &RuntimeAPIError{
			Message: "Proxy is not running. Start it with: ocx start",
			Status:  http.StatusServiceUnavailable,
		}
	}
	return fmt.Sprintf("http://%s:%d", cfg.Hostname, cfg.Port), nil
}

// managementTarget is the resolved live-proxy address.
type managementTarget struct {
	Hostname string
	Port     int
}

// responseMessage extracts the most specific human-readable error the body
// offers, matching the oracle's error/message/detail precedence.
func responseMessage(body any, status int) string {
	if record, ok := body.(map[string]any); ok {
		for _, key := range []string{"error", "message", "detail"} {
			if text, ok := record[key].(string); ok && text != "" {
				return text
			}
		}
	}
	if text, ok := body.(string); ok && strings.TrimSpace(text) != "" {
		trimmed := strings.TrimSpace(text)
		if len(trimmed) > 400 {
			trimmed = trimmed[:400]
		}
		return trimmed
	}
	return fmt.Sprintf("Management request failed (%d)", status)
}

// request performs a management call and decodes the JSON body.
//
// A body that is not JSON is preserved as a string rather than discarded, so an
// HTML error page or a plain-text proxy failure still reaches the user.
func (api runtimeAPI) request(ctx context.Context, target *managementTarget, method, path string, payload any) (any, error) {
	baseURL, err := api.runtimeBaseURL(ctx, target)
	if err != nil {
		return nil, err
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	var body io.Reader
	if payload != nil {
		encoded, marshalErr := json.Marshal(payload)
		if marshalErr != nil {
			return nil, marshalErr
		}
		body = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, baseURL+path, body)
	if err != nil {
		return nil, err
	}
	for key, value := range api.Headers {
		request.Header.Set(key, value)
	}
	if payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := api.client().Do(request)
	if err != nil {
		return nil, &RuntimeAPIError{
			Message: fmt.Sprintf("Management API is unreachable: %v", err),
			Status:  http.StatusServiceUnavailable,
		}
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, err
	}
	var decoded any
	if len(bytes.TrimSpace(raw)) > 0 {
		if json.Unmarshal(raw, &decoded) != nil {
			decoded = string(raw)
		}
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, &RuntimeAPIError{
			Message: responseMessage(decoded, response.StatusCode),
			Status:  response.StatusCode,
			Body:    decoded,
		}
	}
	return decoded, nil
}
