package server

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/chat"
	"github.com/lidge-jun/opencodex-go/internal/codex"
	"github.com/lidge-jun/opencodex-go/internal/combos"
	appconfig "github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/management"
	"github.com/lidge-jun/opencodex-go/internal/types"
	"github.com/lidge-jun/opencodex-go/internal/usage"
)

type AdapterResolver func(model *types.ResolvedModel, transport *types.Transport, auth *types.AuthContext, incoming http.Header) (types.Adapter, error)

type Config struct {
	Registry           types.Registry
	Combos             *combos.Resolver
	Auth               types.AuthProvider
	ResolveAdapter     AdapterResolver
	Client             *http.Client
	Token              string
	AllowedOrigins     []string
	Logger             *slog.Logger
	Lifecycle          *Lifecycle
	Management         types.ManagementRouter
	ChatHandler        types.RouteHandler
	MessagesHandler    types.RouteHandler
	CountTokensHandler types.RouteHandler
	CompactHandler     types.RouteHandler
	UsageRecorder      types.UsageRecorder
	RequestLogs        *management.RequestLog
	ManagementConfig   *appconfig.Config
	ConfigPath         string
	DebugLog           *usage.DebugLog
	OAuthManagement    management.OAuthBackend
	StorageHome        string
	Stop               func()
	Version            string
	EffortCap          string
	SubagentEffortCap  string
	Hostname           string
	SidecarResolver    SidecarResolver
	ShadowCall         *ShadowCallIntercept
	LiveResolver       LiveRelayResolver
	ReadinessChecks    map[string]func(context.Context) error
	WebSockets         bool
	RefreshCatalog     func() error
	CodexQuota         *codex.QuotaStore
}

type Server struct {
	config    Config
	lifecycle *Lifecycle
	handler   http.Handler
	responses *ResponsesCore
	quota     *codex.QuotaStore
}

func New(config Config) *Server {
	if config.Client == nil {
		config.Client = NewProviderClient(FetchTimeouts{Overall: 10 * time.Minute})
	}
	if config.Lifecycle == nil {
		config.Lifecycle = NewLifecycle()
	}
	handlerConfig := chat.HandlerConfig{Registry: config.Registry, Auth: config.Auth, ResolveAdapter: chat.AdapterResolver(config.ResolveAdapter), Client: config.Client}
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
	s := &Server{config: config, lifecycle: config.Lifecycle, quota: quota}
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
	s.responses = NewResponsesCore(ResponsesCoreConfig{
		Registry: s.config.Registry, Combos: s.config.Combos, Auth: s.config.Auth,
		ResolveAdapter: s.config.ResolveAdapter, Client: s.config.Client, Recorder: recorder,
		Lifecycle: s.config.Lifecycle, Logger: s.config.Logger, EffortCap: s.config.EffortCap,
		SubagentEffortCap: s.config.SubagentEffortCap,
		ShadowCall:        s.config.ShadowCall,
		ConsumeQuotaHeaders: func(_ context.Context, accountID string, headers http.Header) {
			quota.ApplyUpstreamHeaders(accountID, headers)
		},
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
	mux.HandleFunc("POST /v1/images/generations", s.handleSidecar(SidecarImageGenerations))
	mux.HandleFunc("POST /v1/images/edits", s.handleSidecar(SidecarImageEdits))
	mux.HandleFunc("POST /v1/alpha/search", s.handleSidecar(SidecarSearch))
	liveness := NewLiveness(config.Version)
	health := NewHealthChecks(config.Version, config.ReadinessChecks)
	mux.Handle("GET /health", liveness)
	mux.Handle("GET /healthz", liveness)
	mux.HandleFunc("GET /ready", health.Ready)
	mux.HandleFunc("GET /health/startup", health.Startup)
	mux.Handle("GET /v1/responses/ws", WebSocketBridge(s.responses))
	managementRouter := config.Management
	admissionKeys := newAdmissionKeySnapshot(nil)
	if config.ManagementConfig != nil {
		admissionKeys.Set(config.ManagementConfig.APIKeys)
	}
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
		api, err := management.NewAPI(management.Options{Config: config.ManagementConfig, ConfigPath: config.ConfigPath, Registry: config.Registry, UsageLog: usageLog, DebugLog: config.DebugLog, RequestLogs: requestLogs, OAuth: config.OAuthManagement, StorageHome: config.StorageHome, Version: config.Version, Stop: config.Stop, RefreshCatalog: refreshCatalog, OnAPIKeysChanged: admissionKeys.Set})
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
	s.handler = Middleware(recoveryMiddleware(decompressionMiddleware(DrainAdmissionMiddleware(mux, s.lifecycle)), config.Logger), middlewareConfig)
	return s
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
	return &http.Server{Addr: address, Handler: s.handler, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 0, IdleTimeout: 2 * time.Minute, MaxHeaderBytes: 1 << 20}
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
			writeJSONError(w, http.StatusServiceUnavailable, "server_draining", "server is draining")
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

func managementStub(w http.ResponseWriter, _ *http.Request) {
	writeJSONError(w, http.StatusNotFound, "not_found", "management endpoint not found")
}
func writeJSONError(w http.ResponseWriter, status int, kind, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{"type": kind, "message": message}})
}
