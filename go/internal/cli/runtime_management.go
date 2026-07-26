package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/claude"
	"github.com/lidge-jun/opencodex-go/internal/codex"
	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/management"
	"github.com/lidge-jun/opencodex-go/internal/platform"
	"github.com/lidge-jun/opencodex-go/internal/providers"
	"github.com/lidge-jun/opencodex-go/internal/registry"
	"github.com/lidge-jun/opencodex-go/internal/server"
	"github.com/lidge-jun/opencodex-go/internal/service"
	"github.com/lidge-jun/opencodex-go/internal/tray"
	"github.com/lidge-jun/opencodex-go/internal/types"
	updatepkg "github.com/lidge-jun/opencodex-go/internal/update"
)

type cliProviderQuotas struct {
	config     *config.Config
	quota      *codex.QuotaStore
	codexAuth  *cliCodexAuthManagement
	fetcher    *registry.QuotaFetcher
	auth       types.AuthProvider
	now        func() time.Time
	parsedOnce sync.Once
	parsed     management.ProviderQuotaBackend
}

var _ management.ProviderQuotaBackend = (*cliProviderQuotas)(nil)
var _ management.ProviderQuotaPayloadSource = (*cliProviderQuotas)(nil)

func newProviderQuotaBackend(cfg *config.Config, quota *codex.QuotaStore, codexAuth *cliCodexAuthManagement, fetcher *registry.QuotaFetcher, auth types.AuthProvider, now func() time.Time) *cliProviderQuotas {
	return &cliProviderQuotas{config: cfg, quota: quota, codexAuth: codexAuth, fetcher: fetcher, auth: auth, now: now}
}

func (b *cliProviderQuotas) ProviderQuotas(ctx context.Context, forceRefresh bool) (management.ProviderQuotaResponse, error) {
	now := time.Now
	if b.now != nil {
		now = b.now
	}
	generated := now().UnixMilli()
	reports := []management.ProviderQuotaReport{}
	if forceRefresh && b.codexAuth != nil {
		if _, err := b.codexAuth.ListCodexAccounts(ctx, true); err != nil {
			return management.ProviderQuotaResponse{}, err
		}
	}
	accountID := b.config.ActiveCodexAccountID
	if accountID == "" {
		accountID = codex.MainCodexAccountID
	}
	if b.quota != nil {
		if quota, found := b.quota.Get(accountID); found {
			report := management.ProviderQuotaReport{
				Provider: "openai", Label: "OpenAI", Source: "chatgpt:runtime", UpdatedAt: quota.UpdatedAt,
				Quota: management.ProviderQuota{
					WeeklyPercent: quota.WeeklyPercent, MonthlyPercent: quota.MonthlyPercent,
					WeeklyResetAt: floatMillisToInt(quota.WeeklyResetAt), MonthlyResetAt: floatMillisToInt(quota.MonthlyResetAt),
					UpdatedAt: quota.UpdatedAt,
				},
			}
			reports = append(reports, report)
		}
	}
	b.parsedOnce.Do(func() {
		b.parsed = &management.ParsedProviderQuotaBackend{Source: b, Tracker: providers.NewQuotaTracker(), Now: func() time.Time { return now() }}
	})
	if b.parsed != nil {
		parsed, err := b.parsed.ProviderQuotas(ctx, forceRefresh)
		if err != nil {
			return management.ProviderQuotaResponse{}, err
		}
		if len(parsed.Reports) > 0 {
			generated = parsed.GeneratedAt
		}
		reports = append(reports, parsed.Reports...)
	}
	return management.ProviderQuotaResponse{GeneratedAt: generated, Reports: reports}, nil
}

func (b *cliProviderQuotas) CacheKey() string {
	return "configured:" + strings.Join(configuredQuotaProviders(b.config, b.fetcher), ",")
}

func (b *cliProviderQuotas) FetchProviderQuotaPayloads(ctx context.Context) ([]management.ProviderQuotaPayload, error) {
	providerNames := configuredQuotaProviders(b.config, b.fetcher)
	results := make([]management.ProviderQuotaPayload, len(providerNames))
	available := make([]bool, len(providerNames))
	var wait sync.WaitGroup
	for index, provider := range providerNames {
		index, provider := index, provider
		wait.Add(1)
		go func() {
			defer wait.Done()
			payload, ok := b.fetchProviderQuotaPayload(ctx, provider)
			results[index], available[index] = payload, ok
		}()
	}
	wait.Wait()
	payloads := make([]management.ProviderQuotaPayload, 0, len(results))
	for index, payload := range results {
		if available[index] {
			payloads = append(payloads, payload)
		}
	}
	return payloads, nil
}

func (b *cliProviderQuotas) fetchProviderQuotaPayload(ctx context.Context, provider string) (management.ProviderQuotaPayload, bool) {
	if b.fetcher == nil || b.auth == nil {
		return management.ProviderQuotaPayload{}, false
	}
	endpoint, supported := b.fetcher.Endpoints[provider]
	if !supported {
		return management.ProviderQuotaPayload{}, false
	}
	credential, err := b.auth.ResolveAuth(ctx, provider, "management-quota")
	if err != nil || credential == nil {
		return management.ProviderQuotaPayload{}, false
	}
	method := endpoint.Method
	if method == "" {
		method = http.MethodGet
	}
	request, err := http.NewRequestWithContext(ctx, method, endpoint.URL, strings.NewReader(endpoint.Body))
	if err != nil {
		return management.ProviderQuotaPayload{}, false
	}
	request.Header.Set("Accept", "application/json")
	for name, value := range endpoint.Headers {
		request.Header.Set(name, value)
	}
	secret := credential.AccessToken
	if secret == "" {
		secret = credential.APIKey
	}
	if secret != "" {
		request.Header.Set("Authorization", "Bearer "+secret)
	}
	for name, value := range credential.Headers {
		request.Header.Set(name, value)
	}
	client := b.fetcher.Client
	if client == nil {
		client = http.DefaultClient
	}
	response, err := client.Do(request)
	if err != nil {
		return management.ProviderQuotaPayload{}, false
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return management.ProviderQuotaPayload{}, false
	}
	var value any
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&value); err != nil {
		return management.ProviderQuotaPayload{}, false
	}
	label := provider
	if entry, found := providers.GetProviderRegistryEntry(provider); found {
		label = entry.Label
	}
	return management.ProviderQuotaPayload{Provider: provider, Label: label, Source: endpoint.Source, Value: value}, true
}

func configuredQuotaProviders(cfg *config.Config, fetcher *registry.QuotaFetcher) []string {
	if cfg == nil || fetcher == nil {
		return nil
	}
	result := make([]string, 0)
	for name, provider := range cfg.Providers {
		if name == "openai" || provider.Disabled {
			continue
		}
		if _, supported := fetcher.Endpoints[name]; supported {
			result = append(result, name)
		}
	}
	sort.Strings(result)
	return result
}

func floatMillisToInt(value *float64) *int64 {
	if value == nil {
		return nil
	}
	converted := int64(*value)
	return &converted
}

type cliClaudeRuntime struct {
	config     *config.Config
	configHome string
	claudeHome string
	registry   types.Registry
	client     *http.Client
}

var _ management.ClaudeCodeRuntime = (*cliClaudeRuntime)(nil)

func newClaudeRuntime(cfg *config.Config, configHome string, registry types.Registry, client *http.Client) *cliClaudeRuntime {
	claudeHome := strings.TrimSpace(os.Getenv("CLAUDE_CONFIG_DIR"))
	if claudeHome == "" {
		home, _ := os.UserHomeDir()
		claudeHome = filepath.Join(home, ".claude")
	}
	return &cliClaudeRuntime{config: cfg, configHome: configHome, claudeHome: claudeHome, registry: registry, client: client}
}

func (r *cliClaudeRuntime) ApplyClaudeCodeSystemEnv(ctx context.Context) error {
	path := filepath.Join(r.configHome, "claude-env.sh")
	if r.config.ClaudeCode == nil || !r.config.ClaudeCode.SystemEnv || r.config.ClaudeCode.Enabled != nil && !*r.config.ClaudeCode.Enabled {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	port := r.config.Port
	if port <= 0 {
		port = config.DefaultPort
	}
	lines := []string{
		"# Generated by opencodex — do not edit manually",
		"export ANTHROPIC_BASE_URL=" + shellEnvValue(fmt.Sprintf("http://127.0.0.1:%d", port)),
		"export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY='1'",
	}
	if len(r.config.APIKeys) > 0 && strings.TrimSpace(r.config.APIKeys[0].Key) != "" {
		lines = append(lines, "export ANTHROPIC_AUTH_TOKEN="+shellEnvValue(r.config.APIKeys[0].Key))
	} else if r.config.ClaudeCode.AuthMode == "proxy" {
		lines = append(lines, `[ -z "${ANTHROPIC_AUTH_TOKEN+x}" ] && export ANTHROPIC_AUTH_TOKEN='opencodex-proxy'`)
	}
	windows, _ := claude.BoundedContextWindows(ctx, 3*time.Second, func(context.Context) (map[string]int, error) {
		return runtimeClaudeContextWindows(*r.config, r.registry), nil
	})
	tiers := claude.ClaudeTierModels{}
	if configured := r.config.ClaudeCode.TierModels; configured != nil {
		tiers = claude.ClaudeTierModels{Opus: configured.Opus, Sonnet: configured.Sonnet, Haiku: configured.Haiku, Fable: configured.Fable}
	}
	auto := claude.ResolveAutoContext(&claude.ContextConfig{
		AutoContext: r.config.ClaudeCode.AutoContext, AutoCompactWindow: r.config.ClaudeCode.AutoCompactWindow,
		MaxContextTokens: r.config.ClaudeCode.MaxContextTokens,
	}, os.Getenv("CLAUDE_CODE_AUTO_COMPACT_WINDOW"))
	modelEnv := claude.EffectiveModelEnv(&claude.ModelEnvConfig{
		ContextConfig: claude.ContextConfig{AutoContext: r.config.ClaudeCode.AutoContext, AutoCompactWindow: r.config.ClaudeCode.AutoCompactWindow, MaxContextTokens: r.config.ClaudeCode.MaxContextTokens},
		Model:         r.config.ClaudeCode.Model, SmallFastModel: r.config.ClaudeCode.SmallFastModel, TierModels: tiers,
	}, windows, &auto)
	modelNames := make([]string, 0, len(modelEnv))
	for name := range modelEnv {
		modelNames = append(modelNames, name)
	}
	sort.Strings(modelNames)
	for _, name := range modelNames {
		value := modelEnv[name]
		if name == "ANTHROPIC_MODEL" {
			lines = append(lines, "export "+name+"="+shellEnvValue(value))
		} else {
			lines = append(lines, `[ -z "${`+name+`+x}" ] && export `+name+`=`+shellEnvValue(value))
		}
	}
	if maxContext := r.config.ClaudeCode.MaxContextTokens; maxContext > 0 {
		lines = append(lines,
			`[ -z "${CLAUDE_CODE_MAX_CONTEXT_TOKENS+x}" ] && export CLAUDE_CODE_MAX_CONTEXT_TOKENS=`+shellEnvValue(fmt.Sprint(maxContext)),
			`[ -z "${DISABLE_COMPACT+x}" ] && export DISABLE_COMPACT='1'`,
		)
	} else if auto.Enabled {
		lines = append(lines, `[ -z "${CLAUDE_CODE_AUTO_COMPACT_WINDOW+x}" ] && export CLAUDE_CODE_AUTO_COMPACT_WINDOW=`+shellEnvValue(fmt.Sprint(auto.CompactWindow)))
	}
	if r.config.ClaudeCode.AlwaysEnableEffort {
		lines = append(lines, `[ -z "${CLAUDE_CODE_ALWAYS_ENABLE_EFFORT+x}" ] && export CLAUDE_CODE_ALWAYS_ENABLE_EFFORT='1'`)
	}
	if err := os.MkdirAll(r.configHome, 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		return err
	}
	_, _ = claude.RefreshGatewayModelCacheFromProxy(ctx, r.client, port, 3*time.Second, r.claudeHome)
	return nil
}

func shellEnvValue(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

func runtimeClaudeContextWindows(cfg config.Config, registry types.Registry) map[string]int {
	var listed []types.ModelEntry
	if registry != nil {
		listed = registry.ListModels()
	}
	models := codex.FilterVisibleRuntimeModels(listed, cfg)
	native := make(map[string]int)
	routed := make([]claude.ContextModel, 0, len(models))
	for _, model := range models {
		id := strings.TrimPrefix(model.ID, model.Provider+"/")
		if model.Provider == "openai" && !strings.Contains(model.ID, "/") {
			native[model.ID] = model.ContextWindow
			continue
		}
		routed = append(routed, claude.ContextModel{Provider: model.Provider, ID: id, ContextWindow: model.ContextWindow})
	}
	return claude.BuildClaudeContextWindows(native, routed)
}

func (r *cliClaudeRuntime) SyncClaudeAgentDefinitions(_ context.Context) error {
	if r.config.ClaudeCode != nil && r.config.ClaudeCode.InjectAgents != nil && !*r.config.ClaudeCode.InjectAgents {
		_, err := claude.SyncClaudeAgentDefs(nil, r.claudeHome)
		return err
	}
	models := make([]claude.AgentModel, 0, len(r.config.SubagentModels))
	windows := make(map[string]int)
	for _, qualified := range r.config.SubagentModels {
		provider, model, found := strings.Cut(qualified, "/")
		if !found {
			provider, model = "native", qualified
		}
		models = append(models, claude.AgentModel{Provider: provider, ID: model})
		if configured, ok := r.config.Providers[provider]; ok {
			if value := configured.ModelContextWindows[model]; value > 0 {
				windows[claude.ClaudeCodeAlias(provider, model)] = value
			}
		}
	}
	blocked := []string{}
	defaultModel := ""
	auto := claude.AutoContextOff
	if r.config.ClaudeCode != nil {
		blocked = append(blocked, r.config.ClaudeCode.BlockedSkills...)
		defaultModel = r.config.ClaudeCode.Model
		auto = claude.ResolveAutoContext(&claude.ContextConfig{
			AutoContext: r.config.ClaudeCode.AutoContext, AutoCompactWindow: r.config.ClaudeCode.AutoCompactWindow,
			MaxContextTokens: r.config.ClaudeCode.MaxContextTokens,
		}, os.Getenv("CLAUDE_CODE_AUTO_COMPACT_WINDOW"))
	}
	defs := claude.BuildClaudeAgentDefs(claude.AgentConfig{Models: models, DefaultModel: defaultModel, ConfigDir: r.claudeHome, AutoContext: auto, BlockedSkills: blocked}, windows)
	_, err := claude.SyncClaudeAgentDefs(defs, r.claudeHome)
	return err
}

type cliRuntimeControl struct {
	config        *config.Config
	updateManager *updatepkg.JobManager
	updateCheck   func(context.Context, string) (updatepkg.CheckResult, error)
	updateRunner  func(context.Context, string) error
	restartRunner func(context.Context) error
	healthCache   *platform.StartupHealthCache
	healthProbe   platform.HealthProbe
	now           func() time.Time
}

type runtimeTarget struct {
	Host string
	Port int
}

var _ management.RuntimeControlBackend = (*cliRuntimeControl)(nil)

func newRuntimeControl(cfg *config.Config, targets ...runtimeTarget) *cliRuntimeControl {
	dir, _ := configDir()
	control := &cliRuntimeControl{config: cfg, now: time.Now, healthCache: platform.NewStartupHealthCache(30 * time.Second)}
	control.healthProbe = control.probeStartupHealth
	control.updateCheck = control.resolveUpdateCheck
	control.updateRunner = func(ctx context.Context, channel string) error {
		return runUpdate(ctx, []string{"--tag", channel}, IO{Out: ioDiscard{}, Err: ioDiscard{}})
	}
	control.restartRunner = func(ctx context.Context) error {
		return runRestart(ctx, nil, IO{Out: ioDiscard{}, Err: ioDiscard{}})
	}
	target := runtimeTarget{Host: cfg.Host, Port: cfg.Port}
	if len(targets) > 0 {
		target = targets[0]
	}
	lifecycle := productionUpdateLifecycle(cfg, target, control)
	control.updateManager = &updatepkg.JobManager{
		Store:     &updatepkg.JobStore{Path: filepath.Join(dir, "update-job.json")},
		Lifecycle: lifecycle,
		Now:       func() time.Time { return control.now() },
		Execute: func(ctx context.Context, check updatepkg.CheckResult) ([]byte, error) {
			return nil, control.updateRunner(ctx, string(check.Channel))
		},
	}
	return control
}

func productionUpdateLifecycle(cfg *config.Config, target runtimeTarget, control *cliRuntimeControl) *updatepkg.LifecycleDependencies {
	executable, err := os.Executable()
	if err != nil {
		executable = os.Args[0]
	}
	state := readServiceInstallState()
	serviceInstalled := state != nil && serviceEnvironmentOwnedHere()
	serviceArgs := []string(nil)
	if serviceInstalled {
		serviceArgs = service.ServiceReinstallArgs(*state)
		control.restartRunner = func(context.Context) error {
			return runService([]string{"restart"}, IO{Out: ioDiscard{}, Err: ioDiscard{}})
		}
	}
	var trayManager tray.Manager
	var trayInitErr error
	if manager, err := tray.New(trayConfig(*cfg)); err == nil {
		trayManager = manager
	} else if !errors.Is(err, tray.ErrNotSupported) {
		trayInitErr = err
	}
	var trayMu sync.Mutex
	var trayHandoff tray.Handoff
	completeTray := func(ctx context.Context) error {
		if trayManager == nil {
			return nil
		}
		trayMu.Lock()
		handoff := trayHandoff
		trayMu.Unlock()
		_, err := trayManager.CompleteUpdate(ctx, handoff)
		return err
	}
	host := gracefulStopHost(target.Host)
	return &updatepkg.LifecycleDependencies{
		CheckIntegrity: func(ctx context.Context, check updatepkg.CheckResult) updatepkg.IntegrityResult {
			if strings.TrimSpace(check.LatestVersion) == "" {
				return updatepkg.ParseIntegrityResult("", "", nil)
			}
			integrityCtx, cancel := context.WithTimeout(ctx, 12*time.Second)
			defer cancel()
			npm := "npm"
			if runtime.GOOS == "windows" {
				npm = "npm.cmd"
			}
			output, err := (updatepkg.ExecRunner{}).Run(integrityCtx, updatepkg.Command{Bin: npm, Args: []string{"view", updatepkg.PackageName + "@" + check.LatestVersion, "dist.integrity"}})
			return updatepkg.ParseIntegrityResult(check.LatestVersion, string(output), err)
		},
		PrepareTray: func(ctx context.Context) (updatepkg.TrayHandoff, error) {
			if trayInitErr != nil {
				return updatepkg.TrayHandoff{}, trayInitErr
			}
			if trayManager == nil {
				return updatepkg.TrayHandoff{}, nil
			}
			handoff, err := trayManager.PrepareUpdate(ctx)
			if err != nil {
				return updatepkg.TrayHandoff{}, err
			}
			trayMu.Lock()
			trayHandoff = handoff
			trayMu.Unlock()
			return updatepkg.TrayHandoff{RestoreOnFailure: handoff.Running, RefreshAfterReplacement: handoff.Installed}, nil
		},
		RestoreTray: completeTray,
		RefreshTray: completeTray,

		RuntimeExecutable: executable,
		Launcher:          executable,
		ServiceInstalled:  serviceInstalled,
		ServiceArgs:       serviceArgs,
		Host:              host,
		Port:              target.Port,
		ReclaimPort: func(ctx context.Context, host string, port int) bool {
			return reclaimListenPort(ctx, host, port, server.ReclaimListenPortOptions{Timeout: 30 * time.Second})
		},
		Restart: func(ctx context.Context, _ updatepkg.RestartPlan) error {
			return control.restartRunner(ctx)
		},
		Probe: func(ctx context.Context) bool {
			return probeHealth(ctx, host, target.Port)
		},
	}
}

type ioDiscard struct{}

func (ioDiscard) Write(p []byte) (int, error) { return len(p), nil }

func (r *cliRuntimeControl) StartupHealth(ctx context.Context) (map[string]any, error) {
	pid, port := readRuntime()
	fallback := platform.StartupHealthDiagnostics{
		Service:   platform.HealthDiagnostic{State: platform.HealthOffline, Summary: "Proxy health is being refreshed."},
		Startup:   platform.HealthDiagnostic{State: platform.HealthWarning, Summary: "Startup protection is being refreshed."},
		CheckedAt: r.now().UTC(), Stale: true,
	}
	diagnostics := r.healthCache.GetStaleWhileRevalidate(ctx, fallback, r.healthProbe)
	return map[string]any{
		"healthy": diagnostics.Service.State == platform.HealthHealthy, "pid": pid, "port": port,
		"codexAutoStart": r.config.CodexAutoStart == nil || *r.config.CodexAutoStart,
		"stale":          diagnostics.Stale,
	}, nil
}

func (r *cliRuntimeControl) probeStartupHealth(ctx context.Context) (platform.StartupHealthDiagnostics, error) {
	_, port := readRuntime()
	healthy := probeHealth(ctx, r.config.Host, port)
	serviceState, serviceSummary := platform.HealthOffline, "Proxy is not responding."
	if healthy {
		serviceState, serviceSummary = platform.HealthHealthy, "Proxy is responding."
	}
	startupState, startupSummary := platform.HealthWarning, "Automatic startup is disabled."
	if r.config.CodexAutoStart == nil || *r.config.CodexAutoStart {
		startupState, startupSummary = platform.HealthHealthy, "Automatic startup is enabled."
	}
	return platform.StartupHealthDiagnostics{
		Service: platform.HealthDiagnostic{State: serviceState, Summary: serviceSummary},
		Tray:    platform.HealthDiagnostic{State: platform.HealthWarning, Summary: "Tray health is checked independently."},
		Startup: platform.HealthDiagnostic{State: startupState, Summary: startupSummary}, CheckedAt: r.now().UTC(),
	}, nil
}

func (r *cliRuntimeControl) RunStartupAction(ctx context.Context, action string) (string, error) {
	streams := IO{Out: ioDiscard{}, Err: ioDiscard{}}
	switch action {
	case "install-service":
		if err := runService([]string{"install"}, streams); err != nil {
			return "", err
		}
		r.healthCache.Invalidate()
		return "Background service installed.", nil
	case "install-shim":
		if err := runCodexShim([]string{"install"}, streams); err != nil {
			return "", err
		}
		r.healthCache.Invalidate()
		return "Codex shim installed.", nil
	default:
		return "", fmt.Errorf("unsupported startup action %q", action)
	}
}

func (r *cliRuntimeControl) WindowsTray(ctx context.Context, action string) (map[string]any, error) {
	var output bytes.Buffer
	if err := runTray(ctx, []string{action, "--json"}, IO{Out: &output, Err: &output}); err != nil {
		return nil, err
	}
	if action != "status" {
		r.healthCache.Invalidate()
	}
	result := map[string]any{}
	if err := json.Unmarshal(output.Bytes(), &result); err != nil {
		return nil, err
	}
	return result, nil
}

func (r *cliRuntimeControl) SyncModels(ctx context.Context) (map[string]any, error) {
	var output bytes.Buffer
	if err := runSync(ctx, nil, IO{Out: &output, Err: &output}); err != nil {
		return map[string]any{"ok": false, "message": err.Error()}, nil
	}
	return map[string]any{"ok": true, "message": strings.TrimSpace(output.String())}, nil
}

func (r *cliRuntimeControl) CheckUpdate(ctx context.Context, channel string) (map[string]any, error) {
	check, err := r.updateCheck(ctx, channel)
	if err != nil {
		return nil, err
	}
	return updateCheckMap(check), nil
}

func (r *cliRuntimeControl) resolveUpdateCheck(ctx context.Context, channel string) (updatepkg.CheckResult, error) {
	resolver := updatepkg.NewGitHubReleaseResolver()
	artifact, err := resolver.Resolve(ctx, updatepkg.Channel(channel))
	if err != nil {
		return updatepkg.CheckResult{}, err
	}
	available := artifact.Version != strings.TrimPrefix(Version, "v")
	check := updatepkg.CheckResult{
		CurrentVersion: strings.TrimPrefix(Version, "v"), LatestVersion: artifact.Version,
		Channel: updatepkg.Channel(channel), Installer: updatepkg.InstallerNPM,
		UpdateAvailable: available, CanUpdate: available, ReleaseNotesURL: updatepkg.ReleaseNotesURL,
	}
	if !available {
		check.Reason = "already_latest"
	}
	return check, nil
}

func (r *cliRuntimeControl) StartUpdate(ctx context.Context, channel string, restart bool) (map[string]any, error) {
	check, err := r.updateCheck(ctx, channel)
	if err != nil {
		return nil, err
	}
	job, err := r.updateManager.Start(ctx, check, restart, r.restartRunner)
	if err != nil {
		return nil, err
	}
	return runtimeJobMap(job), nil
}

func (r *cliRuntimeControl) UpdateStatus(_ context.Context, id string) (map[string]any, bool, error) {
	job, found, err := r.updateManager.Status(id)
	return runtimeJobMap(job), found, err
}

func updateCheckMap(check updatepkg.CheckResult) map[string]any {
	result := map[string]any{
		"currentVersion": check.CurrentVersion, "latestVersion": check.LatestVersion,
		"channel": string(check.Channel), "installer": string(check.Installer),
		"updateAvailable": check.UpdateAvailable, "canUpdate": check.CanUpdate,
		"command": check.Command, "releaseNotesUrl": check.ReleaseNotesURL,
	}
	if check.Reason != "" {
		result["reason"] = check.Reason
	}
	return result
}

func runtimeJobMap(job updatepkg.Job) map[string]any {
	result := map[string]any{
		"id": job.ID, "status": string(job.Status), "channel": string(job.Channel),
		"installer": string(job.Installer), "restart": job.Restart,
		"startedAt": job.StartedAt.UnixMilli(), "updatedAt": job.UpdatedAt.UnixMilli(),
		"currentVersion": job.CurrentVersion, "latestVersion": job.LatestVersion,
		"command": job.Command, "log": append([]string(nil), job.Log...),
	}
	if job.Error != "" {
		result["error"] = job.Error
	}
	if job.ExitCode != nil {
		result["exitCode"] = *job.ExitCode
	}
	if job.Restarted {
		result["restarted"] = true
	}
	return result
}
