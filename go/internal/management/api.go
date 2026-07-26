package management

import (
	"net/http"
	"net/url"
	"runtime"
	"sync"

	"github.com/lidge-jun/opencodex-go/internal/claude"
	"github.com/lidge-jun/opencodex-go/internal/config"
	ocxlib "github.com/lidge-jun/opencodex-go/internal/lib"
	"github.com/lidge-jun/opencodex-go/internal/types"
	"github.com/lidge-jun/opencodex-go/internal/usage"
)

type Options struct {
	Config              *config.Config
	ConfigPath          string
	Registry            types.Registry
	UsageLog            *usage.Log
	DebugLog            *usage.DebugLog
	RequestLogs         *RequestLog
	OAuth               OAuthBackend
	CodexAuth           CodexAuthBackend
	DebugLogs           *ocxlib.DebugLogBuffer
	InjectionLogs       *ocxlib.DebugLogBuffer
	ClaudeDebug         *claude.DebugRing
	ProviderQuotas      ProviderQuotaBackend
	ClaudeRuntime       ClaudeCodeRuntime
	RuntimeControl      RuntimeControlBackend
	FetchModels         ModelFetcher
	StorageHome         string
	Version             string
	Stop                func()
	RefreshCatalog      func() error
	OnAPIKeysChanged    func([]config.ProxyAPIKey)
	ModelCache          ModelCacheInvalidator
	AdvancedRequestLogs AdvancedRequestLogSource
	MemoryWatchdog      func() any
	ResponseState       func() any
	ProviderDNSLookup   ProviderDNSLookup
	// Authorize is an optional defense-in-depth admission hook for callers that
	// register the management router without the server's global middleware.
	Authorize func(*http.Request) bool
}

type AdvancedRequestLogSource interface {
	QueryRequestLogs(url.Values) any
	ClearRequestLogs()
}

type API struct {
	mu                  sync.RWMutex
	config              *config.Config
	configPath          string
	registry            types.Registry
	usageLog            *usage.Log
	debugLog            *usage.DebugLog
	requestLogs         *RequestLog
	advancedRequestLogs AdvancedRequestLogSource
	memoryWatchdog      func() any
	responseState       func() any
	providerDNSLookup   ProviderDNSLookup
	oauth               OAuthBackend
	codexAuth           CodexAuthBackend
	providerDebug       *ocxlib.DebugLogBuffer
	injectionDebug      *ocxlib.DebugLogBuffer
	claudeDebug         *claude.DebugRing
	providerQuotas      ProviderQuotaBackend
	claudeRuntime       ClaudeCodeRuntime
	runtimeControl      RuntimeControlBackend
	fetchModels         ModelFetcher
	storageHome         string
	version             string
	stop                func()
	refreshCatalog      func() error
	onAPIKeysChanged    func([]config.ProxyAPIKey)
	modelCache          ModelCacheInvalidator
	authorize           func(*http.Request) bool
	customModels        map[string]CustomModel
	aliases             map[string]string
	contextCaps         map[string]int
	combos              map[string]Combo
	agents              AgentSettings
	debugEnabled        bool
}

func New(options Options) (*API, error) {
	cfg := options.Config
	if cfg == nil && options.ConfigPath != "" {
		loaded, err := config.Load(options.ConfigPath)
		if err != nil {
			return nil, err
		}
		cfg = loaded
	}
	if cfg == nil {
		value := config.Default()
		cfg = &value
	}
	if options.RequestLogs == nil {
		options.RequestLogs = NewRequestLog(200)
	}
	options.RequestLogs.SetUsageLog(options.UsageLog)
	mode := cfg.MultiAgentMode
	if mode == "" {
		mode = "default"
	}
	agents := AgentSettings{Models: append([]string(nil), cfg.SubagentModels...), InjectionModel: cfg.InjectionModel, InjectionEffort: cfg.InjectionEffort, InjectionPrompt: cfg.InjectionPrompt, GuidanceEnabled: cfg.MultiAgentGuidanceEnabled, EffortCap: cfg.EffortCap, SubagentEffortCap: cfg.SubagentEffortCap, MaxConcurrency: 1, MultiAgentMode: mode}
	customModels := make(map[string]CustomModel, len(cfg.CustomModels))
	for _, model := range cfg.CustomModels {
		customModels[model.ID] = model
	}
	if options.DebugLogs == nil {
		options.DebugLogs = ocxlib.DefaultDebugLogBuffer
	}
	if options.InjectionLogs == nil {
		options.InjectionLogs = ocxlib.NewDebugLogBuffer()
	}
	return &API{config: cfg, configPath: options.ConfigPath, registry: options.Registry, usageLog: options.UsageLog, debugLog: options.DebugLog, requestLogs: options.RequestLogs, advancedRequestLogs: options.AdvancedRequestLogs, memoryWatchdog: options.MemoryWatchdog, responseState: options.ResponseState, providerDNSLookup: options.ProviderDNSLookup, oauth: options.OAuth, codexAuth: options.CodexAuth, providerDebug: options.DebugLogs, injectionDebug: options.InjectionLogs, claudeDebug: options.ClaudeDebug, providerQuotas: options.ProviderQuotas, claudeRuntime: options.ClaudeRuntime, runtimeControl: options.RuntimeControl, fetchModels: options.FetchModels, storageHome: options.StorageHome, version: options.Version, stop: options.Stop, refreshCatalog: options.RefreshCatalog, onAPIKeysChanged: options.OnAPIKeysChanged, modelCache: options.ModelCache, authorize: options.Authorize, customModels: customModels, aliases: map[string]string{}, contextCaps: cloneIntMap(cfg.ProviderContextCaps), combos: map[string]Combo{}, agents: agents}, nil
}

// NewAPI names the management composition point explicitly while preserving
// New for existing callers.
func NewAPI(options Options) (*API, error) { return New(options) }

var routes = []string{
	"GET /api/config", "PUT /api/config", "GET /api/settings", "PUT /api/settings", "GET /api/diagnostics/project-config", "GET /api/sidecar-settings", "PUT /api/sidecar-settings",
	"GET /api/providers", "POST /api/providers", "PATCH /api/providers", "DELETE /api/providers", "POST /api/providers/test", "GET /api/provider-presets",
	"GET /api/models", "PUT /api/disabled-models", "PUT /api/model-visibility", "GET /api/selected-models", "PUT /api/selected-models", "GET /api/custom-models", "POST /api/custom-models", "PUT /api/custom-models/{id}", "DELETE /api/custom-models/{id}", "GET /api/model-aliases", "PUT /api/model-aliases", "GET /api/provider-context-caps", "PUT /api/provider-context-caps",
	"GET /api/oauth/providers", "POST /api/oauth/login", "POST /api/oauth/login/cancel", "POST /api/oauth/login/code", "GET /api/oauth/status", "POST /api/oauth/logout", "GET /api/oauth/accounts", "PUT /api/oauth/accounts/active", "PUT /api/oauth/accounts/alias", "DELETE /api/oauth/accounts",
	"GET /api/codex-auth/accounts", "POST /api/codex-auth/accounts", "DELETE /api/codex-auth/accounts", "PUT /api/codex-auth/accounts/alias", "GET /api/codex-auth/active", "PUT /api/codex-auth/active", "PUT /api/codex-auth/auto-switch", "PUT /api/codex-auth/failover", "GET /api/codex-auth/reset-credits", "POST /api/codex-auth/reset-credits/consume", "POST /api/codex-auth/login", "POST /api/codex-auth/login/code", "POST /api/codex-auth/login/cancel", "GET /api/codex-auth/login-status",
	"GET /api/key-providers", "GET /api/providers/keys", "POST /api/providers/keys", "DELETE /api/providers/keys", "PUT /api/providers/keys/active", "PUT /api/providers/keys/alias", "GET /api/keys", "POST /api/keys", "DELETE /api/keys",
	"GET /api/combos", "PUT /api/combos", "DELETE /api/combos", "POST /api/combos/reset",
	"GET /api/logs", "GET /api/debug", "PUT /api/debug", "GET /api/debug/usage-logs", "GET /api/usage", "GET /api/storage",
	"GET /api/debug/logs", "GET /api/claude/inbound-debug", "GET /api/debug/injection-logs",
	"GET /api/system/memory", "GET /api/subagent-models", "PUT /api/subagent-models", "GET /api/injection-model", "PUT /api/injection-model", "GET /api/effort-caps", "PUT /api/effort-caps", "GET /api/v2", "PUT /api/v2", "POST /api/stop",
	"GET /api/subagent-model-fallback", "PUT /api/subagent-model-fallback", "GET /api/claude-code", "PUT /api/claude-code", "GET /api/shadow-call-settings", "PUT /api/shadow-call-settings", "GET /api/provider-quotas",
	"GET /api/claude-desktop", "PUT /api/claude-desktop", "POST /api/claude-desktop/apply", "GET /api/claude-desktop/status",
	"GET /api/startup-health", "POST /api/startup-action", "GET /api/windows-tray", "POST /api/windows-tray", "POST /api/sync", "GET /api/update/check", "POST /api/update/run", "GET /api/update/status",
}

func RegisteredRoutes() []string { return append([]string(nil), routes...) }
func (a *API) Register(mux *http.ServeMux) {
	for _, route := range routes {
		mux.Handle(route, a)
	}
}

func (a *API) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if a.authorize != nil && !a.authorize(r) {
		writeError(w, http.StatusUnauthorized, "opencodex API key required")
		return
	}
	if r.ContentLength > maxManagementBody {
		writeError(w, http.StatusRequestEntityTooLarge, "request body too large")
		return
	}
	for _, handler := range []func(http.ResponseWriter, *http.Request) bool{a.handleConfig, a.handleProviders, a.handleAPIKeys, a.handleOAuth, a.handleCodexAuth, a.handleClaudeDesktop, a.handleRuntimeSettings, a.handleRuntimeControl, a.handleModels, a.handleCombos, a.handleLogs, a.handleSystem, a.handleAgents} {
		if handler(w, r) {
			return
		}
	}
	if r.URL.Path == "/api/stop" && r.Method == http.MethodPost {
		writeJSON(w, http.StatusOK, map[string]any{"success": true, "message": "Proxy stopping."})
		if a.stop != nil {
			go a.stop()
		}
		return
	}
	writeError(w, http.StatusNotFound, "management route not found")
}

func (a *API) saveLocked() error {
	return a.saveWithModelCacheLocked("")
}

func (a *API) saveProviderLocked(provider string) error {
	return a.saveWithModelCacheLocked(provider)
}

func (a *API) saveWithModelCacheLocked(provider string) error {
	if a.configPath != "" {
		if err := config.Save(a.configPath, a.config); err != nil {
			return err
		}
	}
	if a.refreshCatalog != nil {
		_ = a.refreshCatalog()
	}
	if a.modelCache != nil {
		a.modelCache.Clear(provider)
	}
	if a.config.ClaudeCode != nil && a.config.ClaudeCode.DesktopProfile != nil {
		go a.autoApplyClaudeDesktopBestEffort()
	}
	return nil
}
func (a *API) runtimeInfo() map[string]any {
	return map[string]any{"version": a.version, "goVersion": runtime.Version(), "platform": runtime.GOOS, "architecture": runtime.GOARCH}
}

var _ types.ManagementRouter = (*API)(nil)
