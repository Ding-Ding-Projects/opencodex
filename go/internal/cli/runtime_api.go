package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf16"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/platform"
	"github.com/lidge-jun/opencodex-go/internal/server"
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
	// Headers are applied OVER the defaults, so a caller can override
	// Content-Type without having to restate the management credential.
	// Applied through http.Header.Set, so the match is case-insensitive
	// exactly like the oracle's Headers object.
	Headers map[string]string
	// findProxy and loadCfg are seams so a test can drive the discovery and
	// credential paths without a live proxy or a real config file.
	findProxy func(context.Context, *config.Config) (hostname string, port int, ok bool)
	loadCfg   func() (*config.Config, error)
	// loadToken resolves the admission credential. Tests inject it to avoid
	// touching the real config directory.
	loadToken func(*config.Config) string
	// cached holds the resolved configuration for this client's lifetime.
	// Re-reading per request is not free of consequence: loadConfig falls
	// through to BackupInvalidConfig, which WRITES a backup file when the
	// config fails to parse, so a command issuing several requests against a
	// broken config would litter backups and repeat the warning each time.
	cached *config.Config
}

func (api runtimeAPI) client() *http.Client {
	if api.Client != nil {
		return api.Client
	}
	return http.DefaultClient
}

func (api *runtimeAPI) configuration() *config.Config {
	if api.cached != nil {
		return api.cached
	}
	load := api.loadCfg
	if load == nil {
		load = func() (*config.Config, error) {
			cfg, _, err := loadConfig()
			return cfg, err
		}
	}
	cfg, err := load()
	if err != nil || cfg == nil {
		cfg = &config.Config{}
	}
	api.cached = cfg
	return cfg
}

// managementToken resolves the admission credential the proxy expects.
//
// The order is the one the rest of this CLI already uses (status.go,
// service.go): environment variable, then the service token file, then the
// configured value. A managed service is started with its token in
// `service-api-token` and never in the config, so reading only the config
// makes every management command 401 against exactly the deployment most
// likely to be running.
func (api *runtimeAPI) managementToken(cfg *config.Config) string {
	if api.loadToken != nil {
		return strings.TrimSpace(api.loadToken(cfg))
	}
	tokenFile := ""
	if dir, err := configDir(); err == nil {
		tokenFile = filepath.Join(dir, "service-api-token")
	}
	if token, err := platform.LoadServiceToken(os.Getenv("OPENCODEX_API_AUTH_TOKEN"), tokenFile); err == nil && token != "" {
		return token
	}
	if cfg == nil {
		return ""
	}
	// The server resolves `$NAME` indirection before comparing, so a config
	// holding a reference must be dereferenced here too or the client sends
	// the literal text and is rejected.
	return strings.TrimSpace(resolveTokenReference(cfg.AuthToken))
}

// resolveTokenReference expands a leading `$` environment reference.
func resolveTokenReference(value string) string {
	trimmed := strings.TrimSpace(value)
	if name, found := strings.CutPrefix(trimmed, "$"); found && name != "" {
		return strings.TrimSpace(os.Getenv(name))
	}
	return trimmed
}

// managementHeaders builds the headers for a management request.
//
// The oracle's runningProxyUpdateHeaders always sets Content-Type and adds the
// admission credential when one is configured. Omitting the credential is not a
// harmless default: the proxy answers /api/* with 401, so every ported command
// would fail against a protected proxy.
//
// http.Header is used rather than a plain map so caller overrides match
// case-insensitively. With a map, a caller passing `content-type` would leave
// the default `Content-Type` entry in place and random map iteration would
// decide which one won.
func (api *runtimeAPI) managementHeaders(cfg *config.Config) http.Header {
	headers := http.Header{}
	headers.Set("Content-Type", "application/json")
	if token := api.managementToken(cfg); token != "" {
		headers.Set("X-OpenCodex-API-Key", token)
	}
	for key, value := range api.Headers {
		headers.Set(key, value)
	}
	return headers
}

// runtimeBaseURL resolves the management base URL, preferring an explicit
// override and otherwise locating the running proxy by identity-checked lookup.
func (api *runtimeAPI) runtimeBaseURL(ctx context.Context, cfg *config.Config) (string, error) {
	if strings.TrimSpace(api.BaseURL) != "" {
		return strings.TrimRight(api.BaseURL, "/"), nil
	}
	find := api.findProxy
	if find == nil {
		find = func(lookupCtx context.Context, configuration *config.Config) (string, int, bool) {
			live := findLiveProxy(lookupCtx, configuration)
			if live == nil {
				return "", 0, false
			}
			return live.Hostname, live.Port, true
		}
	}
	hostname, port, ok := find(ctx, cfg)
	if !ok || port <= 0 {
		return "", &RuntimeAPIError{
			Message: "Proxy is not running. Start it with: ocx start",
			Status:  http.StatusServiceUnavailable,
		}
	}
	return fmt.Sprintf("http://%s:%d", server.ProbeHostname(hostname), port), nil
}

// truncateLikeJS caps a string at 400 JavaScript string units.
//
// The oracle uses String.prototype.slice, which counts UTF-16 code units, so a
// byte-based cut would both truncate multi-byte text far earlier and risk
// splitting a rune into invalid UTF-8.
func truncateLikeJS(value string, limit int) string {
	units := utf16.Encode([]rune(value))
	if len(units) <= limit {
		return value
	}
	return string(utf16.Decode(units[:limit]))
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
		return truncateLikeJS(strings.TrimSpace(text), 400)
	}
	return fmt.Sprintf("Management request failed (%d)", status)
}

// decodeBody keeps a non-JSON payload as a string rather than discarding it, so
// an HTML error page or a plain-text proxy failure still reaches the user. Only
// a genuinely empty body decodes to nil; whitespace is content, exactly as
// JSON.parse(" ") throwing leaves the oracle holding " ".
func decodeBody(raw []byte) any {
	if len(raw) == 0 {
		return nil
	}
	var decoded any
	if json.Unmarshal(raw, &decoded) != nil {
		return string(raw)
	}
	return decoded
}

// request performs a management call and decodes the JSON body.
func (api *runtimeAPI) request(ctx context.Context, method, path string, payload any) (any, error) {
	cfg := api.configuration()
	baseURL, err := api.runtimeBaseURL(ctx, cfg)
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
	for key, values := range api.managementHeaders(cfg) {
		for _, value := range values {
			request.Header.Set(key, value)
		}
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
	decoded := decodeBody(raw)
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, &RuntimeAPIError{
			Message: responseMessage(decoded, response.StatusCode),
			Status:  response.StatusCode,
			Body:    decoded,
		}
	}
	return decoded, nil
}
