package cli

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/adapter/anthropic"
	cursoradapter "github.com/lidge-jun/opencodex-go/internal/adapter/cursor"
	"github.com/lidge-jun/opencodex-go/internal/adapter/google"
	"github.com/lidge-jun/opencodex-go/internal/adapter/kiro"
	openaiadapter "github.com/lidge-jun/opencodex-go/internal/adapter/openai"
	"github.com/lidge-jun/opencodex-go/internal/codex"
	"github.com/lidge-jun/opencodex-go/internal/combos"
	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/management"
	"github.com/lidge-jun/opencodex-go/internal/oauth"
	"github.com/lidge-jun/opencodex-go/internal/platform"
	providerpolicy "github.com/lidge-jun/opencodex-go/internal/providers"
	"github.com/lidge-jun/opencodex-go/internal/registry"
	"github.com/lidge-jun/opencodex-go/internal/server"
	"github.com/lidge-jun/opencodex-go/internal/types"
	"github.com/lidge-jun/opencodex-go/internal/usage"
	"github.com/lidge-jun/opencodex-go/internal/vision"
)

func runServe(ctx context.Context, args []string, streams IO) error {
	flags := flag.NewFlagSet("serve", flag.ContinueOnError)
	flags.SetOutput(streams.Err)
	hostOverride := flags.String("host", "", "listen host")
	portOverride := flags.Int("port", -1, "listen port")
	configFile := flags.String("config", "", "configuration file")
	tokenFile := flags.String("token-file", "", "service token file")
	codexHome := flags.String("codex-home", "", "Codex home for service mode")
	serviceMode := flags.Bool("service", false, "run under a service manager")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return fmt.Errorf("unexpected serve arguments: %v", flags.Args())
	}
	if *configFile != "" {
		_ = os.Setenv("OPENCODEX_HOME", filepath.Dir(*configFile))
	}
	if *codexHome != "" {
		_ = os.Setenv("CODEX_HOME", *codexHome)
	}
	if *serviceMode {
		_ = os.Setenv("OCX_SERVICE", "1")
	}
	var cfg *config.Config
	var loadedConfigPath string
	var err error
	if *configFile != "" {
		cfg, err = loadConfigFile(*configFile, streams.Err)
		loadedConfigPath, _ = filepath.Abs(*configFile)
	} else {
		cfg, loadedConfigPath, err = loadConfig()
	}
	if err != nil {
		return err
	}
	configuredPort := cfg.Port
	if *hostOverride != "" {
		cfg.Host = *hostOverride
	}
	if *portOverride >= 0 {
		cfg.Port = *portOverride
	}
	if err := cfg.Validate(); err != nil {
		return err
	}
	config.ApplyProxyEnv(*cfg)
	runtimeCfg, err := config.ResolveEnvironment(*cfg)
	if err != nil {
		return fmt.Errorf("resolve configuration environment: %w", err)
	}
	serviceTokenFile := *tokenFile
	if serviceTokenFile == "" {
		serviceTokenFile = os.Getenv("OCX_API_TOKEN_FILE")
	}
	token, err := platform.LoadServiceToken(os.Getenv("OPENCODEX_API_AUTH_TOKEN"), serviceTokenFile)
	if err != nil {
		return err
	}
	if token == "" {
		token = runtimeCfg.AuthToken
	}
	if err := validateServeAuth(runtimeCfg, token); err != nil {
		return err
	}
	configHome, err := configDir()
	if err != nil {
		return err
	}
	credentialStore := oauth.NewCredentialStore(filepath.Join(configHome, "auth.json"))
	oauthManagement := newOAuthManagement(credentialStore)
	providerClient := newAdapterAwareClient(server.NewProviderClient(providerFetchTimeouts(runtimeCfg)))
	sharedModelCache := codex.NewModelCache()
	sharedQuotaStore := codex.NewQuotaStore()
	runtimeCfg = discoverConfiguredProviderModels(ctx, runtimeCfg, credentialStore, sharedModelCache, providerClient)
	cursorModels, discoveryErr := discoverConfiguredCursorModels(ctx, runtimeCfg, credentialStore, nil)
	if discoveryErr != nil && streams.Err != nil {
		fmt.Fprintf(streams.Err, "Warning: Cursor model discovery failed; using configured catalog: %v\n", discoveryErr)
	}
	reg := configuredRegistryWithCursorModels(runtimeCfg, cursorModels)
	liveRegistry := &configBackedRegistry{config: cfg, cursorModels: cursorModels}
	comboResolver, err := combos.New(runtimeCfg.Combos, configuredComboProviders(reg, runtimeCfg))
	if err != nil {
		return err
	}
	auth, err := configuredAuthWithStore(runtimeCfg, credentialStore)
	if err != nil {
		return err
	}
	usageLog := usage.NewLog(filepath.Join(configHome, "usage.jsonl"))
	debugLog := usage.NewDebugLog(filepath.Join(configHome, "usage-debug.jsonl"))
	requestLogs := management.NewRequestLog(200)
	stop := &stopRouter{channel: make(chan struct{})}
	liveAuth := &configBackedAuth{config: cfg, store: credentialStore, resolver: auth}
	codexAuthManagement := newCodexAuthManagement(cfg, loadedConfigPath, credentialStore, sharedQuotaStore, providerClient)
	providerQuotas := &cliProviderQuotas{config: cfg, quota: sharedQuotaStore, codexAuth: codexAuthManagement, now: time.Now}
	claudeRuntime := newClaudeRuntime(cfg, configHome, liveRegistry, providerClient)
	runtimeControl := newRuntimeControl(cfg)
	apiStop := func() {
		teardownOwnedGrokFence(streams)
		stop.Stop()
	}
	proxy := server.New(server.Config{Registry: liveRegistry, Combos: comboResolver, Auth: liveAuth, ResolveAdapter: configBackedAdapterResolver(cfg, cursorModels, providerClient), Client: providerClient, Token: token, Version: Version, UsageRecorder: usageLog, RequestLogs: requestLogs, ManagementConfig: cfg, ConfigPath: loadedConfigPath, DebugLog: debugLog, OAuthManagement: oauthManagement, CodexAuthManagement: codexAuthManagement, ProviderQuotas: providerQuotas, ClaudeRuntime: claudeRuntime, RuntimeControl: runtimeControl, CodexQuota: sharedQuotaStore, ModelCache: sharedModelCache, LiveResolver: configuredLiveResolver(cfg, credentialStore), StallTimeoutSec: configuredStallTimeout(runtimeCfg), SearchLoop: configuredSearchLoop(runtimeCfg, liveRegistry, liveAuth, providerClient), StorageHome: os.Getenv("CODEX_HOME"), Stop: apiStop})
	selectedPort := cfg.Port
	if cfg.Port > 0 {
		selectedPort, err = server.FindAvailablePortWithOptions(cfg.Host, cfg.Port, server.FindAvailablePortOptions{PreferRetry: time.Second, PreferRetryInterval: 25 * time.Millisecond})
		if err != nil {
			return err
		}
	}
	if server.ShouldPersistSelectedPort(configuredPort, selectedPort, cfg.Port) {
		cfg.Port = selectedPort
		if err := config.Save(loadedConfigPath, cfg); err != nil {
			return fmt.Errorf("persist selected port: %w", err)
		}
	}
	httpServer := proxy.HTTPServer(net.JoinHostPort(cfg.Host, strconv.Itoa(selectedPort)))
	listener, listenErr := net.Listen("tcp", httpServer.Addr)
	if listenErr != nil {
		return listenErr
	}
	actualPort := listener.Addr().(*net.TCPAddr).Port
	if err := writeRuntimeFiles(actualPort); err != nil {
		_ = listener.Close()
		return err
	}
	defer removeRuntimeFiles()
	fmt.Fprintf(streams.Out, "OpenCodex proxy listening on %s\n", listener.Addr())
	if os.Getenv("OCX_SERVICE") == "" {
		defer teardownOwnedGrokFence(streams)
	}
	afterStart := func() {
		go func() { _ = applyGrokFence(ctx, cfg, actualPort, cfg.Host, false, streams) }()
	}
	return serveListener(httpServer, proxy.Lifecycle(), listener, stop.channel, afterStart)
}

func validateServeAuth(cfg config.Config, token string) error {
	keys := make([]string, 0, len(cfg.APIKeys))
	for _, key := range cfg.APIKeys {
		keys = append(keys, key.Key)
	}
	return server.AssertServerAuthConfig(server.MiddlewareConfig{Hostname: cfg.Host, Token: token, APIKeys: keys})
}

func configuredComboProviders(reg *registry.ProviderRegistry, cfg config.Config) map[string]combos.Provider {
	providers := make(map[string]combos.Provider)
	for _, entry := range reg.Entries() {
		provider := combos.Provider{}
		if configured, ok := cfg.Providers[entry.ID]; ok {
			provider.Disabled = configured.Disabled
		}
		providers[entry.ID] = provider
	}
	return providers
}

type stopRouter struct {
	once    sync.Once
	channel chan struct{}
}

func (s *stopRouter) Stop() { s.once.Do(func() { close(s.channel) }) }

func (s *stopRouter) Register(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/stop", func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"ok":true,"status":"stopping"}`))
		s.Stop()
	})
}

func serveListener(httpServer *http.Server, lifecycle *server.Lifecycle, listener net.Listener, stop <-chan struct{}, afterStart func()) error {
	errCh := make(chan error, 1)
	go func() { errCh <- httpServer.Serve(listener) }()
	if afterStart != nil {
		afterStart()
	}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(signals)
	select {
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-signals:
	case <-stop:
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	_ = lifecycle.Drain(ctx)
	return httpServer.Shutdown(ctx)
}

func configuredRegistry(cfg config.Config) *registry.ProviderRegistry {
	base := registry.New().Entries()
	index := make(map[string]int, len(base))
	for position, entry := range base {
		index[entry.ID] = position
	}
	for name, provider := range cfg.Providers {
		entry := registry.Provider{ID: name, Label: name, Adapter: provider.Adapter, BaseURL: provider.BaseURL, DefaultModel: provider.DefaultModel, StaticHeaders: provider.Headers}
		for _, model := range provider.Models {
			entry.Models = append(entry.Models, registry.ModelDefinition{ID: model})
		}
		if position, ok := index[name]; ok {
			preset := base[position]
			preset.Adapter, preset.BaseURL, preset.StaticHeaders = entry.Adapter, entry.BaseURL, entry.StaticHeaders
			if entry.DefaultModel != "" {
				preset.DefaultModel = entry.DefaultModel
			}
			if len(entry.Models) > 0 {
				preset.Models = entry.Models
			}
			base[position] = preset
		} else {
			base = append(base, entry)
		}
	}
	configured := registry.New(base...)
	_ = configured.SetDefaultProvider(cfg.DefaultProvider)
	return configured
}

func configuredAuth(cfg config.Config) (*oauth.AuthResolver, error) {
	dir, err := configDir()
	if err != nil {
		return nil, err
	}
	return configuredAuthWithStore(cfg, oauth.NewCredentialStore(filepath.Join(dir, "auth.json")))
}

func configuredAuthWithStore(cfg config.Config, store *oauth.CredentialStore) (*oauth.AuthResolver, error) {
	configs := map[string]oauth.ProviderAuthConfig{"openai": {Mode: oauth.AuthModeForward}}
	for name, provider := range cfg.Providers {
		resolved, err := configuredProviderAuth(name, provider, store)
		if err != nil {
			return nil, err
		}
		configs[name] = resolved
	}
	resolver := oauth.NewAuthResolver(store, configs, nil)
	resolver.Pool = oauth.NewAccountPool(store, "openai")
	return resolver, nil
}

func configuredProviderAuth(name string, provider config.ProviderConfig, store *oauth.CredentialStore) (oauth.ProviderAuthConfig, error) {
	mode := oauth.AuthModeOAuth
	keyOptional := provider.KeyOptional != nil && *provider.KeyOptional
	preset, registered := registry.New().Lookup(name)
	if registered {
		keyOptional = keyOptional || preset.KeyOptional
	}
	if provider.APIKey != "" || provider.AuthMode == "key" || provider.AuthMode == "api-key" {
		mode = oauth.AuthModeAPIKey
	} else if registered {
		switch preset.AuthKind {
		case registry.AuthForward:
			mode = oauth.AuthModeForward
		case registry.AuthKey, registry.AuthLocal:
			mode = oauth.AuthModeAPIKey
		}
	}
	usePool := false
	if name == "openai" && provider.CodexAccountMode != "direct" {
		if set, found, err := store.GetAccountSet("openai"); err != nil {
			return oauth.ProviderAuthConfig{}, err
		} else if found && len(set.Accounts) > 0 {
			mode, usePool = oauth.AuthModeOAuth, true
		}
	}
	return oauth.ProviderAuthConfig{Mode: mode, APIKey: provider.APIKey, KeyOptional: keyOptional, UsePool: usePool}, nil
}

func providerFetchTimeouts(cfg config.Config) server.FetchTimeouts {
	timeouts := server.FetchTimeouts{Overall: 10 * time.Minute}
	if cfg.ConnectTimeoutMS > 0 {
		configured := time.Duration(cfg.ConnectTimeoutMS) * time.Millisecond
		timeouts.Connect, timeouts.TLSHandshake, timeouts.ResponseHeader = configured, configured, configured
	}
	return timeouts
}

func configuredStallTimeout(cfg config.Config) *float64 {
	if cfg.StallTimeoutSec <= 0 {
		return nil
	}
	seconds := float64(cfg.StallTimeoutSec)
	return &seconds
}

func adapterResolver(reg *registry.ProviderRegistry, cfg config.Config) server.AdapterResolver {
	return adapterResolverWithVisionClient(reg, cfg, http.DefaultClient)
}

func adapterResolverWithVisionClient(reg *registry.ProviderRegistry, cfg config.Config, client *http.Client) server.AdapterResolver {
	base := baseAdapterResolver(reg, cfg)
	preprocessor := configuredVisionPreprocessor(cfg, client)
	return func(model *types.ResolvedModel, transport *types.Transport, auth *types.AuthContext, incoming http.Header) (types.Adapter, error) {
		adapter, err := base(model, transport, auth, incoming)
		if err != nil || preprocessor == nil {
			return adapter, err
		}
		provider := cfg.Providers[model.Provider]
		return bindAdapterVision(adapter, preprocessor, !modelInList(provider.NoVisionModels, model.Model)), nil
	}
}

func configuredVisionPreprocessor(cfg config.Config, client *http.Client) *vision.VisionPreprocessor {
	sidecar := cfg.VisionSidecar
	if sidecar == nil || (sidecar.Enabled != nil && !*sidecar.Enabled) {
		return nil
	}
	preprocessor := vision.PreprocessorConfig{
		Backend:                   vision.Backend(sidecar.Backend),
		MaxDescriptionsPerTurn:    sidecar.MaxDescriptionsPerTurn,
		MaxDescriptionsPerTurnSet: sidecar.MaxDescriptionsPerTurnSet || sidecar.MaxDescriptionsPerTurn != 0,
	}
	timeout := time.Duration(sidecar.TimeoutMS) * time.Millisecond
	for _, provider := range cfg.Providers {
		if provider.Disabled {
			continue
		}
		switch provider.Adapter {
		case "anthropic":
			if preprocessor.Anthropic == nil {
				preprocessor.Anthropic = &vision.AnthropicConfig{BaseURL: provider.BaseURL, Model: sidecar.Model, AccessToken: provider.APIKey, Headers: provider.Headers, Client: client, Timeout: timeout}
			}
		case "openai-responses":
			if preprocessor.OpenAI == nil {
				preprocessor.OpenAI = &vision.OpenAIConfig{BaseURL: provider.BaseURL, Model: sidecar.Model, AccessToken: provider.APIKey, Headers: provider.Headers, Client: client, Timeout: timeout}
			}
		}
	}
	return vision.NewVisionPreprocessor(preprocessor)
}

func modelInList(models []string, model string) bool {
	for _, candidate := range models {
		if strings.EqualFold(strings.TrimSpace(candidate), strings.TrimSpace(model)) {
			return true
		}
	}
	return false
}

func baseAdapterResolver(reg *registry.ProviderRegistry, cfg config.Config) server.AdapterResolver {
	cursorExecutors := make(map[string]*cursoradapter.NativeExecutor)
	cursorExecutorErrors := make(map[string]error)
	for name, provider := range cfg.Providers {
		if provider.Adapter != "cursor" {
			continue
		}
		cursorExecutors[name], cursorExecutorErrors[name] = newCursorNativeExecutor(provider)
	}
	return func(model *types.ResolvedModel, transport *types.Transport, auth *types.AuthContext, incoming http.Header) (types.Adapter, error) {
		entry, ok := reg.Lookup(model.Provider)
		if !ok {
			return nil, fmt.Errorf("unknown provider %q", model.Provider)
		}
		provider := cfg.Providers[model.Provider]
		adapterKind := configuredModelAdapter(model.Provider, model.Model, entry.Adapter, provider)
		secret := provider.APIKey
		if auth != nil {
			if auth.APIKey != "" {
				secret = auth.APIKey
			} else if auth.AccessToken != "" {
				secret = auth.AccessToken
			}
		}
		headers := transport.Headers
		provider.BaseURL = transport.BaseURL
		switch adapterKind {
		case "openai-chat":
			adapter := openaiadapter.NewChatAdapter(provider, secret, headers)
			adapter.OpenRouterRouting = provider.OpenRouterRouting
			adapter.ModelOpenRouterRouting = provider.ModelOpenRouterRouting
			if model.Provider == "xai" {
				return bindXAIRequestID(adapter, provider.Headers), nil
			}
			return adapter, nil
		case "mimo-free":
			adapter := openaiadapter.NewMimoAdapter()
			adapter.Chat = *openaiadapter.NewChatAdapter(provider, secret, headers)
			return bindAdapterFetch(adapter, adapter.Do), nil
		case "cursor":
			executor := cursorExecutors[model.Provider]
			if err := cursorExecutorErrors[model.Provider]; err != nil {
				return nil, fmt.Errorf("configure Cursor native executor: %w", err)
			}
			if executor == nil {
				executor, _ = newCursorNativeExecutor(provider)
			}
			return cursoradapter.NewAdapter(cursoradapter.AdapterConfig{
				BaseURL:        transport.BaseURL,
				Token:          secret,
				Headers:        headers,
				NativeExecutor: executor,
			})
		case "openai-responses":
			if entry.AuthKind == registry.AuthForward {
				provider.AuthMode = "forward"
			}
			adapter := openaiadapter.NewResponsesAdapter(provider, secret, headers)
			adapter.IncomingHeaders = incoming
			return adapter, nil
		case "anthropic":
			return anthropic.NewAdapter(provider, secret, headers, cfg.CacheRetention), nil
		case "azure-openai":
			return &openaiadapter.AzureAdapter{BaseURL: transport.BaseURL, APIKey: secret, Headers: headers}, nil
		case "google":
			mode := google.ModeAIStudio
			if model.Provider == "google-vertex" || provider.GoogleMode == string(google.ModeVertex) {
				mode = google.ModeVertex
			}
			if model.Provider == "google-antigravity" || provider.GoogleMode == string(google.ModeCloudCodeAssist) {
				mode = google.ModeCloudCodeAssist
			}
			adapter := google.NewAdapter(mode, transport, auth)
			adapter.Project = provider.Project
			adapter.Location = provider.Location
			return bindAdapterFetch(adapter, func(ctx context.Context, request *http.Request) (*http.Response, error) {
				return adapter.Do(ctx, request, google.RetryOptions{})
			}), nil
		case "kiro":
			return kiro.NewAdapter(transport.BaseURL, secret), nil
		default:
			return nil, fmt.Errorf("adapter %q is not supported", adapterKind)
		}
	}
}

// configuredModelAdapter mirrors TS resolveWireProtocolOverride: immutable wire
// pins win, then a validated per-model override, then the provider default.
// Re-checking policy here protects live/in-memory config written by older builds.
func configuredModelAdapter(providerName, modelID, fallback string, provider config.ProviderConfig) string {
	if pinned := types.PinnedWireAdapter(providerName, modelID); pinned != "" {
		return pinned
	}
	requested := provider.ModelAdapters[modelID]
	if requested == "" || !types.ModelAdapterOverrideAllowed[requested] {
		return fallback
	}
	if providerpolicy.IsCanonicalOpenAiForwardProvider(provider.Adapter, provider.AuthMode, provider.BaseURL) {
		return fallback
	}
	return requested
}

func runtimePaths() (string, string, error) {
	dir, err := configDir()
	if err != nil {
		return "", "", err
	}
	return filepath.Join(dir, "ocx.pid"), filepath.Join(dir, "runtime-port"), nil
}

func writeRuntimeFiles(port int) error {
	pidPath, portPath, err := runtimePaths()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(pidPath), 0o700); err != nil {
		return err
	}
	if data, readErr := os.ReadFile(pidPath); readErr == nil {
		if pid, parseErr := strconv.Atoi(string(data)); parseErr == nil && platform.ProcessAlive(pid) {
			return fmt.Errorf("proxy already running with PID %d", pid)
		}
	}
	if err := os.WriteFile(pidPath, []byte(strconv.Itoa(os.Getpid())), 0o600); err != nil {
		return err
	}
	return os.WriteFile(portPath, []byte(strconv.Itoa(port)), 0o600)
}

func removeRuntimeFiles() {
	pidPath, portPath, _ := runtimePaths()
	_ = os.Remove(pidPath)
	_ = os.Remove(portPath)
}
