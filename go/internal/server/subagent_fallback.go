package server

import (
	"context"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/codex"
	appconfig "github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/providers"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

type responseSubagentFallback struct {
	state       *codex.SubagentFallbackState
	config      *appconfig.Config
	persistence *appconfig.LivePersistence
	registry    types.Registry
	quota       *codex.QuotaStore
	codexHome   string
	prime       func(context.Context, string) error
	now         func() time.Time
}

func newResponseSubagentFallback(config *appconfig.Config, registry types.Registry, quota *codex.QuotaStore, codexHome string, state *codex.SubagentFallbackState, prime func(context.Context, string) error, persistence ...*appconfig.LivePersistence) *responseSubagentFallback {
	if config == nil || registry == nil {
		return nil
	}
	if state == nil {
		state = codex.NewSubagentFallbackState()
	}
	fallback := &responseSubagentFallback{state: state, config: config, registry: registry, quota: quota, codexHome: codexHome, prime: prime, now: time.Now}
	if len(persistence) > 0 {
		fallback.persistence = persistence[0]
	}
	return fallback
}

func (fallback *responseSubagentFallback) Prime(ctx context.Context) {
	if fallback == nil || fallback.prime == nil {
		return
	}
	cfg := fallback.snapshot()
	_ = fallback.state.PrimeQuota(fallback.now(), fallback.codexConfig(cfg), func(reason string) error {
		return fallback.prime(ctx, reason)
	})
}

func (fallback *responseSubagentFallback) Select(primary string, nativeOnly bool) codex.SubagentModelSelection {
	if fallback == nil {
		return codex.SubagentModelSelection{Model: primary}
	}
	cfg := fallback.snapshot()
	extra := codex.ResolveAgentModelFallbackForPrimary(primary, fallback.codexHome)
	account := fallback.activeAccountID(cfg)
	return fallback.state.Select(primary, fallback.codexConfig(cfg), extra, &account, fallback.now(), nativeOnly)
}

func (fallback *responseSubagentFallback) NoteFailure(model, message, accountID string) {
	if fallback == nil {
		return
	}
	cfg := fallback.snapshot()
	if accountID == "" {
		accountID = fallback.activeAccountID(cfg)
	}
	interval := time.Duration(cfg.SubagentModelFallbackPollMS) * time.Millisecond
	fallback.state.NoteFailure(model, message, fallback.codexConfig(cfg), &accountID, fallback.now(), interval)
}

func (fallback *responseSubagentFallback) canonical(resolved *types.ResolvedModel) bool {
	if fallback == nil || resolved == nil {
		return false
	}
	provider := fallback.snapshot().Providers[resolved.Provider]
	return providers.IsCanonicalOpenAiForwardProvider(EffectiveWireAdapter(resolved.Provider, resolved.Model, provider), provider.AuthMode, provider.BaseURL)
}

func (fallback *responseSubagentFallback) activeAccountID(cfg *appconfig.Config) string {
	if cfg != nil {
		if id := strings.TrimSpace(cfg.ActiveCodexAccountID); id != "" {
			return id
		}
	}
	return codex.MainCodexAccountID
}

func (fallback *responseSubagentFallback) snapshot() *appconfig.Config {
	if fallback != nil && fallback.persistence != nil {
		if snapshot := fallback.persistence.Snapshot(); snapshot != nil {
			return snapshot
		}
	}
	if fallback != nil && fallback.config != nil {
		return fallback.config
	}
	value := appconfig.Default()
	return &value
}

func (fallback *responseSubagentFallback) codexConfig(cfg *appconfig.Config) codex.SubagentFallbackConfig {
	if cfg == nil {
		cfg = fallback.snapshot()
	}
	known := make([]string, 0, len(cfg.Providers)+16)
	for name := range cfg.Providers {
		known = append(known, name)
	}
	for _, entry := range providers.ListRegistryEntries() {
		known = append(known, entry.ID)
	}
	return codex.SubagentFallbackConfig{
		FallbackModels:    append([]string(nil), cfg.SubagentModelFallback...),
		DisabledModels:    append([]string(nil), cfg.DisabledModels...),
		KnownProviders:    known,
		ActiveAccountID:   fallback.activeAccountID(cfg),
		AutoSwitchPercent: float64(cfg.AutoSwitchThreshold),
		PollInterval:      time.Duration(cfg.SubagentModelFallbackPollMS) * time.Millisecond,
		Route: func(model string) (codex.FallbackRoute, error) {
			resolved, err := fallback.registry.ResolveModel(model)
			if err != nil {
				return codex.FallbackRoute{}, err
			}
			configured := cfg.Providers[resolved.Provider]
			adapter := EffectiveWireAdapter(resolved.Provider, resolved.Model, configured)
			return codex.FallbackRoute{Provider: codex.FallbackProvider{
				ID: resolved.Provider, Disabled: configured.Disabled,
				CodexAccountMode: providers.ProviderCodexAccountMode(resolved.Provider, &providers.ProviderConfig{CodexAccountMode: configured.CodexAccountMode}),
				CanonicalOpenAI:  providers.IsCanonicalOpenAiForwardProvider(adapter, configured.AuthMode, configured.BaseURL),
			}}, nil
		},
		AccountUsable: func(accountID string) bool {
			if accountID == codex.MainCodexAccountID {
				return true
			}
			for _, account := range cfg.CodexAccounts {
				if account.ID == accountID && !account.IsMain {
					return true
				}
			}
			return false
		},
		AccountPlan: func(accountID string) string {
			for _, account := range cfg.CodexAccounts {
				if account.ID == accountID {
					return account.Plan
				}
			}
			return ""
		},
		Quota: func(accountID string) (codex.StoredAccountQuota, bool) {
			if fallback.quota == nil {
				return codex.StoredAccountQuota{}, false
			}
			return fallback.quota.Get(accountID)
		},
	}
}

type subagentFallbackAttempt struct {
	model     string
	accountID string
}
