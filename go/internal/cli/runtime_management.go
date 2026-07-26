package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/claude"
	"github.com/lidge-jun/opencodex-go/internal/codex"
	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/management"
	"github.com/lidge-jun/opencodex-go/internal/providers"
	"github.com/lidge-jun/opencodex-go/internal/registry"
	"github.com/lidge-jun/opencodex-go/internal/types"
	updatepkg "github.com/lidge-jun/opencodex-go/internal/update"
)

type cliProviderQuotas struct {
	config    *config.Config
	quota     *codex.QuotaStore
	codexAuth *cliCodexAuthManagement
	fetcher   *registry.QuotaFetcher
	auth      types.AuthProvider
	now       func() time.Time
}

var _ management.ProviderQuotaBackend = (*cliProviderQuotas)(nil)

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
	if b.fetcher != nil && b.auth != nil {
		requests := make([]registry.QuotaRequest, 0)
		for _, provider := range configuredQuotaProviders(b.config, b.fetcher) {
			credential, err := b.auth.ResolveAuth(ctx, provider, "management-quota")
			if err != nil || credential == nil {
				continue
			}
			requests = append(requests, registry.QuotaRequest{Provider: provider, Credential: credential})
		}
		for _, result := range b.fetcher.FetchAll(ctx, requests, forceRefresh) {
			if result.Err != nil || result.Quota == nil {
				continue
			}
			reports = append(reports, quotaReport(*result.Quota))
		}
	}
	return management.ProviderQuotaResponse{GeneratedAt: generated, Reports: reports}, nil
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

func quotaReport(quota registry.ProviderQuota) management.ProviderQuotaReport {
	converted := management.ProviderQuota{UpdatedAt: quota.UpdatedAt.UnixMilli()}
	for _, window := range quota.Windows {
		percent := window.Percent
		var reset *int64
		if !window.ResetAt.IsZero() {
			value := window.ResetAt.UnixMilli()
			reset = &value
		}
		switch strings.ToLower(strings.TrimSpace(window.Label)) {
		case "5h", "five hour", "five-hour":
			converted.FiveHourPercent, converted.FiveHourResetAt = &percent, reset
		case "weekly", "7d", "seven day", "seven-day":
			converted.WeeklyPercent, converted.WeeklyResetAt = &percent, reset
		case "monthly", "month":
			converted.MonthlyPercent, converted.MonthlyResetAt = &percent, reset
		default:
			converted.CustomWindows = append(converted.CustomWindows, management.ProviderQuotaWindow{Label: window.Label, Percent: percent, ResetAt: reset})
		}
	}
	label := quota.Provider
	if entry, found := providers.GetProviderRegistryEntry(quota.Provider); found {
		label = entry.Label
	}
	updated := quota.UpdatedAt.UnixMilli()
	return management.ProviderQuotaReport{Provider: quota.Provider, Label: label, Source: quota.Source, Quota: converted, UpdatedAt: updated}
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
	now           func() time.Time
}

var _ management.RuntimeControlBackend = (*cliRuntimeControl)(nil)

func newRuntimeControl(cfg *config.Config) *cliRuntimeControl {
	dir, _ := configDir()
	control := &cliRuntimeControl{config: cfg, now: time.Now}
	control.updateCheck = control.resolveUpdateCheck
	control.updateRunner = func(ctx context.Context, channel string) error {
		return runUpdate(ctx, []string{"--tag", channel}, IO{Out: ioDiscard{}, Err: ioDiscard{}})
	}
	control.restartRunner = func(context.Context) error {
		return runService([]string{"restart"}, IO{Out: ioDiscard{}, Err: ioDiscard{}})
	}
	control.updateManager = &updatepkg.JobManager{
		Store: &updatepkg.JobStore{Path: filepath.Join(dir, "update-job.json")},
		Now:   func() time.Time { return control.now() },
		Execute: func(ctx context.Context, check updatepkg.CheckResult) ([]byte, error) {
			return nil, control.updateRunner(ctx, string(check.Channel))
		},
	}
	return control
}

type ioDiscard struct{}

func (ioDiscard) Write(p []byte) (int, error) { return len(p), nil }

func (r *cliRuntimeControl) StartupHealth(ctx context.Context) (map[string]any, error) {
	pid, port := readRuntime()
	healthy := probeHealth(ctx, r.config.Host, port)
	return map[string]any{"healthy": healthy, "pid": pid, "port": port, "codexAutoStart": r.config.CodexAutoStart == nil || *r.config.CodexAutoStart}, nil
}

func (r *cliRuntimeControl) RunStartupAction(ctx context.Context, action string) (string, error) {
	streams := IO{Out: ioDiscard{}, Err: ioDiscard{}}
	switch action {
	case "install-service":
		if err := runService([]string{"install"}, streams); err != nil {
			return "", err
		}
		return "Background service installed.", nil
	case "install-shim":
		if err := runCodexShim([]string{"install"}, streams); err != nil {
			return "", err
		}
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
