package server

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/chat"
	"github.com/lidge-jun/opencodex-go/internal/combos"
	appconfig "github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/management"
	"github.com/lidge-jun/opencodex-go/internal/types"
	"github.com/lidge-jun/opencodex-go/internal/usage"
)

type AdapterResolver func(model *types.ResolvedModel, transport *types.Transport, auth *types.AuthContext, incoming http.Header) (types.Adapter, error)

type Config struct {
	Registry          types.Registry
	Combos            *combos.Resolver
	Auth              types.AuthProvider
	ResolveAdapter    AdapterResolver
	Client            *http.Client
	Token             string
	AllowedOrigins    []string
	Logger            *slog.Logger
	Lifecycle         *Lifecycle
	Management        types.ManagementRouter
	ChatHandler       types.RouteHandler
	MessagesHandler   types.RouteHandler
	CompactHandler    types.RouteHandler
	UsageRecorder     types.UsageRecorder
	RequestLogs       *management.RequestLog
	ManagementConfig  *appconfig.Config
	ConfigPath        string
	DebugLog          *usage.DebugLog
	OAuthManagement   management.OAuthBackend
	StorageHome       string
	Stop              func()
	Version           string
	EffortCap         string
	SubagentEffortCap string
	Hostname          string
	SidecarResolver   SidecarResolver
	ShadowCall        *ShadowCallIntercept
	ReadinessChecks   map[string]func(context.Context) error
}

type Server struct {
	config    Config
	lifecycle *Lifecycle
	handler   http.Handler
	responses *ResponsesCore
}

func New(config Config) *Server {
	if config.Client == nil {
		config.Client = NewProviderClient(FetchTimeouts{Overall: 10 * time.Minute})
	}
	if config.Lifecycle == nil {
		config.Lifecycle = NewLifecycle()
	}
	handlerConfig := chat.HandlerConfig{Registry: config.Registry, Auth: config.Auth, ResolveAdapter: chat.AdapterResolver(config.ResolveAdapter), Client: config.Client}
	if config.ChatHandler == nil {
		config.ChatHandler = chat.NewHandler(handlerConfig)
	}
	if config.MessagesHandler == nil {
		config.MessagesHandler = chat.NewMessagesHandler(handlerConfig)
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
	s := &Server{config: config, lifecycle: config.Lifecycle}
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
	})
	mux := http.NewServeMux()
	mux.Handle("POST /v1/responses", s.responses)
	mux.HandleFunc("POST /v1/responses/compact", s.delegate(config.CompactHandler))
	mux.HandleFunc("POST /v1/chat/completions", s.delegate(config.ChatHandler))
	mux.HandleFunc("POST /v1/messages", s.delegate(config.MessagesHandler))
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
	if managementRouter == nil {
		usageLog, _ := config.UsageRecorder.(*usage.Log)
		api, err := management.NewAPI(management.Options{Config: config.ManagementConfig, ConfigPath: config.ConfigPath, Registry: config.Registry, UsageLog: usageLog, DebugLog: config.DebugLog, RequestLogs: requestLogs, OAuth: config.OAuthManagement, StorageHome: config.StorageHome, Version: config.Version, Stop: config.Stop})
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
	s.handler = Middleware(decompressionMiddleware(DrainAdmissionMiddleware(mux, s.lifecycle)), MiddlewareConfig{Token: config.Token, Hostname: s.config.Hostname, AllowedOrigins: config.AllowedOrigins, Logger: config.Logger})
	return s
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
