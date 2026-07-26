package server

import (
	"context"
	"encoding/json"
	"log/slog"
	"maps"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/bridge"
	"github.com/lidge-jun/opencodex-go/internal/chat"
	"github.com/lidge-jun/opencodex-go/internal/claude"
	"github.com/lidge-jun/opencodex-go/internal/codex"
	"github.com/lidge-jun/opencodex-go/internal/combos"
	appconfig "github.com/lidge-jun/opencodex-go/internal/config"
	ocxlib "github.com/lidge-jun/opencodex-go/internal/lib"
	"github.com/lidge-jun/opencodex-go/internal/management"
	"github.com/lidge-jun/opencodex-go/internal/providers"
	"github.com/lidge-jun/opencodex-go/internal/search"
	"github.com/lidge-jun/opencodex-go/internal/types"
	"github.com/lidge-jun/opencodex-go/internal/usage"
)

type AdapterResolver func(model *types.ResolvedModel, transport *types.Transport, auth *types.AuthContext, incoming http.Header) (types.Adapter, error)

type Config struct {
	Registry               types.Registry
	Combos                 *combos.Resolver
	Auth                   types.AuthProvider
	ResolveAdapter         AdapterResolver
	Client                 *http.Client
	Token                  string
	AllowedOrigins         []string
	Logger                 *slog.Logger
	Lifecycle              *Lifecycle
	Management             types.ManagementRouter
	ChatHandler            types.RouteHandler
	MessagesHandler        types.RouteHandler
	CountTokensHandler     types.RouteHandler
	CompactHandler         types.RouteHandler
	UsageRecorder          types.UsageRecorder
	RequestLogs            *management.RequestLog
	ManagementConfig       *appconfig.Config
	ConfigPath             string
	DebugLog               *usage.DebugLog
	OAuthManagement        management.OAuthBackend
	CodexAuthManagement    management.CodexAuthBackend
	StorageHome            string
	Stop                   func()
	Version                string
	EffortCap              string
	SubagentEffortCap      string
	StallTimeoutSec        *float64
	Hostname               string
	SidecarResolver        SidecarResolver
	ShadowCall             *ShadowCallIntercept
	LiveResolver           LiveRelayResolver
	ReadinessChecks        map[string]func(context.Context) error
	WebSockets             bool
	RefreshCatalog         func() error
	CodexQuota             *codex.QuotaStore
	ModelCache             management.ModelCacheInvalidator
	MemoryWatchdogInterval time.Duration
	MemoryWatchdogCapacity int
	MemorySample           func() MemorySample
	ClaudeDebug            *claude.DebugRing
	SearchLoop             *search.Loop
	OnUsage                func(*types.Usage)
	InjectionDebug         *ocxlib.DebugLogBuffer
	ProviderQuotas         management.ProviderQuotaBackend
	ClaudeRuntime          management.ClaudeCodeRuntime
	RuntimeControl         management.RuntimeControlBackend
	ResponseState          *ResponseStateStore
	SubagentFallbackState  *codex.SubagentFallbackState
	PrimeSubagentQuota     func(context.Context, string) error
}

type Server struct {
	config              Config
	lifecycle           *Lifecycle
	handler             http.Handler
	responses           *ResponsesCore
	quota               *codex.QuotaStore
	advancedRequestLogs *RequestLogStore
	watchdog            *MemoryWatchdog
	responseState       *ResponseStateStore
}

func New(config Config) *Server {
	if config.Client == nil {
		config.Client = NewProviderClient(FetchTimeouts{Overall: 10 * time.Minute})
	}
	if config.Lifecycle == nil {
		config.Lifecycle = NewLifecycle()
	}
	claudeDebug := config.ClaudeDebug
	if claudeDebug == nil {
		claudeDebug = claude.NewDebugRing(claude.DefaultDebugRingLimit, ocxlib.IsClaudeDebugEnabled())
	}
	injectionDebug := config.InjectionDebug
	if injectionDebug == nil {
		injectionDebug = ocxlib.NewDebugLogBuffer()
	}
	handlerConfig := baseChatHandlerConfig(config, claudeDebug)
	if config.ManagementConfig != nil && config.ManagementConfig.ClaudeCode != nil {
		claudeConfig := config.ManagementConfig.ClaudeCode
		handlerConfig.ClaudeEnabled = claudeConfig.Enabled
		if claudeConfig.BodyStallSec > 0 {
			handlerConfig.BodyStall = time.Duration(claudeConfig.BodyStallSec) * time.Second
		}
		if claudeConfig.BodyMaxBytes > 0 {
			handlerConfig.ResponseLimit = claudeConfig.BodyMaxBytes
		}
		if claudeConfig.NativePassthrough != nil {
			enabled := *claudeConfig.NativePassthrough
			handlerConfig.NativeAnthropic = func(model *types.ResolvedModel) bool {
				if !enabled || model == nil {
					return false
				}
				provider := strings.ToLower(model.Provider)
				return provider == "anthropic" || provider == "claude"
			}
		}
	}
	if config.ManagementConfig != nil {
		handlerConfig.NativeCompact = func(model *types.ResolvedModel) bool {
			if model == nil {
				return false
			}
			provider, ok := config.ManagementConfig.Providers[model.Provider]
			if !ok {
				return false
			}
			adapter := EffectiveWireAdapter(model.Provider, model.Model, provider)
			return providers.SupportsNativeResponsesCompactEndpoint(model.Provider, adapter, provider.BaseURL)
		}
	}
	if config.ChatHandler == nil {
		config.ChatHandler = chat.NewHandler(handlerConfig)
	}
	if config.MessagesHandler == nil {
		config.MessagesHandler = chat.NewMessagesHandler(handlerConfig)
	}
	if config.CountTokensHandler == nil {
		config.CountTokensHandler = chat.NewCountTokensHandler(handlerConfig)
	}
	if config.CompactHandler == nil {
		config.CompactHandler = chat.NewCompactHandler(handlerConfig)
	}
	requestLogs := config.RequestLogs
	if requestLogs == nil {
		requestLogs = management.NewRequestLog(200)
	}
	recorder := config.UsageRecorder
	if log, ok := recorder.(*usage.Log); ok {
		requestLogs.SetUsageLog(log)
		recorder = requestLogs
	} else if recorder == nil {
		recorder = requestLogs
	} else {
		recorder = fanoutRecorder{requestLog: requestLogs, recorder: recorder}
	}
	quota := config.CodexQuota
	if quota == nil {
		quota = codex.NewQuotaStore()
	}
	advancedRequestLogs := NewRequestLogStore(MaxRequestLogEntries, nil)
	watchdog := NewMemoryWatchdog(config.MemoryWatchdogInterval, config.MemoryWatchdogCapacity, config.MemorySample)
	responseState := config.ResponseState
	if responseState == nil {
		statePath := ""
		if strings.TrimSpace(config.ConfigPath) != "" {
			statePath = filepath.Join(filepath.Dir(config.ConfigPath), "responses-state.json")
		}
		responseState = NewResponseStateStore(statePath)
	}
	s := &Server{config: config, lifecycle: config.Lifecycle, quota: quota, advancedRequestLogs: advancedRequestLogs, watchdog: watchdog, responseState: responseState}
	admissionKeys := newAdmissionKeySnapshot(nil)
	if config.ManagementConfig != nil {
		admissionKeys.Set(config.ManagementConfig.APIKeys)
	}
	forwardAdmissionConfig := MiddlewareConfig{Token: config.Token, APIKeySource: admissionKeys.Get}
	if config.ManagementConfig != nil && forwardAdmissionConfig.Token == "" {
		forwardAdmissionConfig.Token = config.ManagementConfig.AuthToken
	}
	keyFailover := providers.NewKeyFailover()
	guidance := MultiAgentGuidanceOptions{}
	if config.ManagementConfig != nil {
		guidance = MultiAgentGuidanceOptions{
			Enabled: config.ManagementConfig.MultiAgentGuidanceEnabled, InjectionModel: config.ManagementConfig.InjectionModel,
			InjectionEffort: config.ManagementConfig.InjectionEffort, SubagentModels: append([]string(nil), config.ManagementConfig.SubagentModels...),
			InjectionPrompt:  config.ManagementConfig.InjectionPrompt,
			FallbackGuidance: codex.SubagentFallbackGuidanceText(config.ManagementConfig.SubagentModelFallback),
		}
	}
	if s.config.Hostname == "" && s.config.ManagementConfig != nil {
		s.config.Hostname = s.config.ManagementConfig.Host
	}
	if s.config.EffortCap == "" && s.config.ManagementConfig != nil {
		s.config.EffortCap = s.config.ManagementConfig.EffortCap
	}
	if s.config.SubagentEffortCap == "" && s.config.ManagementConfig != nil {
		s.config.SubagentEffortCap = s.config.ManagementConfig.SubagentEffortCap
	}
	if s.config.SidecarResolver == nil && s.config.Registry != nil {
		s.config.SidecarResolver = defaultSidecarResolver(s.config)
	}
	primeSubagentQuota := s.config.PrimeSubagentQuota
	if primeSubagentQuota == nil && s.config.ProviderQuotas != nil {
		primeSubagentQuota = func(ctx context.Context, _ string) error {
			_, err := s.config.ProviderQuotas.ProviderQuotas(ctx, true)
			return err
		}
	}
	codexHome := strings.TrimSpace(s.config.StorageHome)
	if codexHome == "" {
		codexHome = codex.ResolveCodexHome(codex.HomeOptions{})
	}
	subagentFallback := newResponseSubagentFallback(s.config.ManagementConfig, s.config.Registry, quota, codexHome, s.config.SubagentFallbackState, primeSubagentQuota)
	s.responses = NewResponsesCore(ResponsesCoreConfig{
		Registry: s.config.Registry, Combos: s.config.Combos, Auth: s.config.Auth,
		ResolveAdapter: s.config.ResolveAdapter, Client: s.config.Client, Recorder: recorder,
		Lifecycle: s.config.Lifecycle, Logger: s.config.Logger, EffortCap: s.config.EffortCap,
		SubagentEffortCap: s.config.SubagentEffortCap,
		StallTimeout:      s.config.StallTimeoutSec,
		ShadowCall:        s.config.ShadowCall,
		ConsumeQuotaHeaders: func(_ context.Context, accountID string, headers http.Header) {
			quota.ApplyUpstreamHeaders(accountID, headers)
		},
		Guidance: guidance,
		ProviderAdapter: func(provider string) string {
			if s.config.ManagementConfig == nil {
				return ""
			}
			return strings.ToLower(strings.TrimSpace(s.config.ManagementConfig.Providers[provider].Adapter))
		},
		RouteAdapter: func(provider, model string) string {
			if s.config.ManagementConfig == nil {
				return ""
			}
			return EffectiveWireAdapter(provider, model, s.config.ManagementConfig.Providers[provider])
		},
		PassthroughRoute: func(resolved *types.ResolvedModel) bool {
			if resolved == nil || s.config.ManagementConfig == nil {
				return false
			}
			return EffectiveWireAdapter(resolved.Provider, resolved.Model, s.config.ManagementConfig.Providers[resolved.Provider]) == "openai-responses"
		},
		ForwardRoute: func(resolved *types.ResolvedModel) bool {
			if resolved == nil || s.config.ManagementConfig == nil {
				return false
			}
			return s.config.ManagementConfig.Providers[resolved.Provider].AuthMode == "forward"
		},
		ValidateForwardAdmission: func(headers http.Header) error {
			return ValidateForwardAdmissionCredential(headers, forwardAdmissionConfig)
		},
		ItemIDRepair: func(provider string) *ResponsesItemIDRepairConfig {
			if s.config.ManagementConfig == nil {
				return nil
			}
			configured := s.config.ManagementConfig.Providers[provider].ResponsesItemIDRepair
			if configured == nil {
				return nil
			}
			return &ResponsesItemIDRepairConfig{Message: append([]string(nil), configured.Message...), Reasoning: append([]string(nil), configured.Reasoning...), RepairMissingTerminalIDs: configured.RepairMissingTerminalIDs}
		},
		RotateAPIKeyOn429: func(provider, attemptedKey, retryAfter string) (string, bool) {
			if s.config.ManagementConfig == nil {
				return "", false
			}
			configured, ok := s.config.ManagementConfig.Providers[provider]
			if !ok {
				return "", false
			}
			pool := make([]providers.APIKeyEntry, 0, len(configured.APIKeyPool))
			for _, entry := range configured.APIKeyPool {
				pool = append(pool, providers.APIKeyEntry{ID: entry.ID, Key: entry.Key, Label: entry.Label})
			}
			candidate := providers.ProviderConfig{AuthMode: configured.AuthMode, APIKey: configured.APIKey, APIKeyPool: pool}
			rotated, ok := keyFailover.RotateKeyOn429(provider, &candidate, retryAfter, time.Now(), attemptedKey)
			if !ok {
				return "", false
			}
			return rotated.APIKey, true
		},
		PrepareImageRetry: ApplyAnthropicImageTierRetry,
		RequestLogs:       advancedRequestLogs,
		StreamMode: func() string {
			if s.config.ManagementConfig != nil {
				return s.config.ManagementConfig.StreamMode
			}
			return ""
		}(),
		ResponseState:    responseState,
		SubagentFallback: subagentFallback,
	})
	mux := http.NewServeMux()
	websocketsEnabled := config.WebSockets
	if config.ManagementConfig != nil && config.ManagementConfig.WebSockets {
		websocketsEnabled = true
	}
	mux.Handle("/v1/responses", s.responsesEndpoint(websocketsEnabled))
	mux.HandleFunc("POST /v1/responses/compact", s.delegate(config.CompactHandler))
	mux.HandleFunc("POST /v1/chat/completions", s.delegate(config.ChatHandler))
	mux.HandleFunc("POST /v1/messages", s.delegate(config.MessagesHandler))
	mux.HandleFunc("POST /v1/messages/count_tokens", s.delegate(config.CountTokensHandler))
	if config.LiveResolver != nil {
		live := NewLiveHandler(config.LiveResolver, config.Client)
		sideband := NewLiveSidebandHandler(config.LiveResolver)
		mux.Handle("POST /v1/live", live)
		mux.Handle("POST /v1/realtime/calls", live)
		mux.Handle("GET /v1/live/{callId}", sideband)
		mux.Handle("GET /v1/realtime/calls/{callId}", sideband)
		mux.Handle("GET /v1/realtime", sideband)
	}
	mux.HandleFunc("GET /v1/models", s.handleModels)
	mux.HandleFunc("GET /api/codex-auth/quota", s.handleCodexQuota)
	mux.HandleFunc("POST /v1/images/generations", s.handleSidecar(SidecarImageGenerations))
	mux.HandleFunc("POST /v1/images/edits", s.handleSidecar(SidecarImageEdits))
	mux.HandleFunc("POST /v1/alpha/search", s.handleSidecar(SidecarSearch))
	liveness := NewLiveness(config.Version)
	health := NewHealthChecks(config.Version, config.ReadinessChecks)
	// TypeScript has no /health route. Reserve it before the SPA fallback so a
	// bundled dashboard does not accidentally turn this unknown endpoint into 200.
	mux.HandleFunc("GET /health", unknownV1)
	mux.Handle("GET /healthz", liveness)
	mux.HandleFunc("GET /health/startup", health.Startup)
	managementRouter := config.Management
	refreshCatalog := config.RefreshCatalog
	if refreshCatalog == nil {
		home := strings.TrimSpace(config.StorageHome)
		if home == "" {
			home = codex.ResolveCodexHome(codex.HomeOptions{})
		}
		refreshCatalog = func() error {
			return codex.InvalidateCodexModelsCache(filepath.Join(home, "opencodex-catalog.json"), filepath.Join(home, "models_cache.json"))
		}
	}
	if managementRouter == nil {
		usageLog, _ := config.UsageRecorder.(*usage.Log)
		api, err := management.NewAPI(management.Options{Config: config.ManagementConfig, ConfigPath: config.ConfigPath, Registry: config.Registry, UsageLog: usageLog, DebugLog: config.DebugLog, RequestLogs: requestLogs, AdvancedRequestLogs: advancedRequestLogs, MemoryWatchdog: func() any { return watchdog.Snapshot() }, ResponseState: func() any { return responseState.Metrics() }, OAuth: config.OAuthManagement, CodexAuth: config.CodexAuthManagement, DebugLogs: ocxlib.DefaultDebugLogBuffer, InjectionLogs: injectionDebug, ClaudeDebug: claudeDebug, ProviderQuotas: config.ProviderQuotas, ClaudeRuntime: config.ClaudeRuntime, RuntimeControl: config.RuntimeControl, StorageHome: config.StorageHome, Version: config.Version, Stop: config.Stop, RefreshCatalog: refreshCatalog, OnAPIKeysChanged: admissionKeys.Set, ModelCache: config.ModelCache})
		if err == nil {
			managementRouter = api
		} else if config.Logger != nil {
			config.Logger.Error("management_api", "error", err)
		}
	}
	if managementRouter != nil {
		managementRouter.Register(mux)
	}
	mux.HandleFunc("/api/", managementStub)
	mux.HandleFunc("/v1/", unknownV1)
	mux.Handle("/", StaticHandler())
	middlewareConfig := MiddlewareConfig{Token: config.Token, Hostname: s.config.Hostname, AllowedOrigins: config.AllowedOrigins, Logger: config.Logger}
	middlewareConfig.APIKeySource = admissionKeys.Get
	if config.ManagementConfig != nil {
		middlewareConfig.Port = config.ManagementConfig.Port
		if middlewareConfig.Token == "" {
			middlewareConfig.Token = config.ManagementConfig.AuthToken
		}
		if len(middlewareConfig.AllowedOrigins) == 0 {
			middlewareConfig.AllowedOrigins = config.ManagementConfig.CORSAllowOrigins
		}
	}
	s.handler = oversizedHeaderMiddleware(Middleware(recoveryMiddleware(decompressionMiddleware(DrainAdmissionMiddleware(mux, s.lifecycle)), config.Logger), middlewareConfig))
	return s
}

func baseChatHandlerConfig(config Config, debug *claude.DebugRing) chat.HandlerConfig {
	result := chat.HandlerConfig{
		Registry: config.Registry, Combos: config.Combos, Auth: config.Auth, ResolveAdapter: chat.AdapterResolver(config.ResolveAdapter), Client: config.Client,
		ClaudeDebug: debug, SearchLoop: config.SearchLoop, OnUsage: config.OnUsage,
	}
	if config.ManagementConfig != nil && config.ManagementConfig.ClaudeCode != nil {
		result.ClaudeModelMap = maps.Clone(config.ManagementConfig.ClaudeCode.ModelMap)
		result.ClaudeBlockedSkills = append([]string(nil), config.ManagementConfig.ClaudeCode.BlockedSkills...)
	}
	return result
}

// EffectiveWireAdapter mirrors src/server/adapter-resolve.ts. Keeping this at
// the server composition seam lets every protocol handler classify the final
// model wire consistently even while adapter construction remains CLI-owned.
func EffectiveWireAdapter(providerName, modelID string, provider appconfig.ProviderConfig) string {
	if pinned := types.PinnedWireAdapter(providerName, modelID); pinned != "" {
		return pinned
	}
	adapter := strings.ToLower(strings.TrimSpace(provider.Adapter))
	requested := strings.ToLower(strings.TrimSpace(provider.ModelAdapters[modelID]))
	if requested != "" && types.ModelAdapterOverrideAllowed[requested] && !types.IsWirePinnedModel(providerName, modelID) &&
		!providers.IsCanonicalOpenAiForwardProvider(provider.Adapter, provider.AuthMode, provider.BaseURL) {
		return requested
	}
	return adapter
}

// QuotaStore exposes the server-owned, concurrency-safe Codex quota snapshot
// store to management and routing composition without leaking account data over
// HTTP. Responses updates it as soon as upstream headers arrive.
func (s *Server) QuotaStore() *codex.QuotaStore {
	if s == nil {
		return nil
	}
	return s.quota
}

func (s *Server) MemoryWatchdog() *MemoryWatchdog {
	if s == nil {
		return nil
	}
	return s.watchdog
}

func (s *Server) Close() {
	if s != nil && s.watchdog != nil {
		s.watchdog.Stop()
	}
	if s != nil && s.responseState != nil {
		s.responseState.Flush()
	}
}

func (s *Server) handleCodexQuota(w http.ResponseWriter, _ *http.Request) {
	quotas := map[string]codex.StoredAccountQuota{}
	if s != nil && s.quota != nil {
		quotas = s.quota.List()
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"quotas": quotas})
}

type admissionKeySnapshot struct {
	mu   sync.RWMutex
	keys []string
}

func newAdmissionKeySnapshot(keys []appconfig.ProxyAPIKey) *admissionKeySnapshot {
	snapshot := &admissionKeySnapshot{}
	snapshot.Set(keys)
	return snapshot
}

func (snapshot *admissionKeySnapshot) Set(keys []appconfig.ProxyAPIKey) {
	values := make([]string, 0, len(keys))
	for _, key := range keys {
		if value := strings.TrimSpace(key.Key); value != "" {
			values = append(values, value)
		}
	}
	snapshot.mu.Lock()
	snapshot.keys = values
	snapshot.mu.Unlock()
}

func (snapshot *admissionKeySnapshot) Get() []string {
	snapshot.mu.RLock()
	defer snapshot.mu.RUnlock()
	return append([]string(nil), snapshot.keys...)
}

type fanoutRecorder struct {
	requestLog *management.RequestLog
	recorder   types.UsageRecorder
}

func (r fanoutRecorder) Record(ctx context.Context, record *types.UsageRecord) error {
	if err := r.requestLog.Record(ctx, record); err != nil {
		return err
	}
	return r.recorder.Record(ctx, record)
}

func (s *Server) Handler() http.Handler { return s.handler }
func (s *Server) Lifecycle() *Lifecycle { return s.lifecycle }

func (s *Server) HTTPServer(address string) *http.Server {
	// net/http's built-in oversized-header response includes a text body. Bun
	// closes the connection or emits a bodyless 431, so admit a bounded amount
	// here and enforce the TypeScript-compatible 1 MiB limit in the handler.
	server := &http.Server{Addr: address, Handler: s.handler, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 0, IdleTimeout: 2 * time.Minute, MaxHeaderBytes: 2 << 20}
	server.RegisterOnShutdown(s.Close)
	return server
}

const publicHeaderLimit = 1 << 20

func oversizedHeaderMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		size := len(request.Method) + len(request.URL.RequestURI()) + len(request.Proto) + 4
		for name, values := range request.Header {
			for _, value := range values {
				size += len(name) + len(value) + 4
			}
		}
		if size > publicHeaderLimit {
			w.Header().Set("Connection", "close")
			w.WriteHeader(http.StatusRequestHeaderFieldsTooLarge)
			return
		}
		next.ServeHTTP(w, request)
	})
}

func (s *Server) responsesEndpoint(websocketsEnabled bool) http.Handler {
	bridge := WebSocketBridge(s.responses)
	return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if isWebSocketUpgrade(request) {
			if !websocketsEnabled {
				writeJSONError(w, http.StatusUpgradeRequired, "upgrade_required", "Responses WebSocket transport is disabled; use HTTP")
				return
			}
			bridge.ServeHTTP(w, request)
			return
		}
		if request.Method != http.MethodPost {
			unknownV1(w, request)
			return
		}
		s.responses.ServeHTTP(w, request)
	})
}

func isWebSocketUpgrade(request *http.Request) bool {
	return request != nil && strings.EqualFold(strings.TrimSpace(request.Header.Get("Upgrade")), "websocket") && headerHasToken(request.Header.Get("Connection"), "upgrade")
}

func headerHasToken(value, target string) bool {
	for _, token := range strings.Split(value, ",") {
		if strings.EqualFold(strings.TrimSpace(token), target) {
			return true
		}
	}
	return false
}

func (s *Server) delegate(handler types.RouteHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if handler == nil {
			writeJSONError(w, http.StatusNotImplemented, "endpoint_not_configured", "endpoint handler is not configured")
			return
		}
		handler.Handle(w, r)
	}
}

func (s *Server) handleSidecar(kind SidecarKind) http.HandlerFunc {
	handler := sidecarHandler(kind, s.config.SidecarResolver)
	return func(w http.ResponseWriter, r *http.Request) {
		if s.lifecycle.IsDraining() {
			w.Header().Set("Retry-After", "5")
			writeClassifiedJSONError(w, http.StatusServiceUnavailable, "server_error", "Service shutting down")
			return
		}
		handler.ServeHTTP(w, r)
	}
}

func terminalUsage(events []types.AdapterEvent) *types.Usage {
	var found *types.Usage
	for _, event := range events {
		if event.Usage != nil {
			value := *event.Usage
			found = &value
		}
	}
	return found
}

func managementStub(w http.ResponseWriter, request *http.Request) {
	payload, err := bridge.FormatErrorResponse(http.StatusNotFound, "not_found", "Unknown endpoint: "+request.Method+" "+request.URL.Path)
	if err != nil {
		writeJSONError(w, http.StatusNotFound, "not_found", "Unknown endpoint")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusNotFound)
	_, _ = w.Write(payload)
}
func writeJSONError(w http.ResponseWriter, status int, kind, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{"type": kind, "message": message}})
}
