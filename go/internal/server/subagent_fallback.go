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
	state     *codex.SubagentFallbackState
	config    *appconfig.Config
	registry  types.Registry
	quota     *codex.QuotaStore
	codexHome string
	prime     func(context.Context, string) error
	now       func() time.Time
}

func newResponseSubagentFallback(config *appconfig.Config, registry types.Registry, quota *codex.QuotaStore, codexHome string, state *codex.SubagentFallbackState, prime func(context.Context, string) error) *responseSubagentFallback {
	if config == nil || registry == nil {
		return nil
	}
	if state == nil {
		state = codex.NewSubagentFallbackState()
	}
	return &responseSubagentFallback{state: state, config: config, registry: registry, quota: quota, codexHome: codexHome, prime: prime, now: time.Now}
}

func (fallback *responseSubagentFallback) Prime(ctx context.Context) {
	if fallback == nil || fallback.prime == nil {
		return
	}
	_ = fallback.state.PrimeQuota(fallback.now(), fallback.codexConfig(), func(reason string) error {
		return fallback.prime(ctx, reason)
	})
}

func (fallback *responseSubagentFallback) Select(primary string, nativeOnly bool) codex.SubagentModelSelection {
	if fallback == nil {
		return codex.SubagentModelSelection{Model: primary}
	}
	extra := codex.ResolveAgentModelFallbackForPrimary(primary, fallback.codexHome)
	account := fallback.activeAccountID()
	return fallback.state.Select(primary, fallback.codexConfig(), extra, &account, fallback.now(), nativeOnly)
}

func (fallback *responseSubagentFallback) NoteFailure(model, message, accountID string) {
	if fallback == nil {
		return
	}
	if accountID == "" {
		accountID = fallback.activeAccountID()
	}
	interval := time.Duration(fallback.config.SubagentModelFallbackPollMS) * time.Millisecond
	fallback.state.NoteFailure(model, message, fallback.codexConfig(), &accountID, fallback.now(), interval)
}

func (fallback *responseSubagentFallback) canonical(resolved *types.ResolvedModel) bool {
	if fallback == nil || resolved == nil {
		return false
	}
	provider := fallback.config.Providers[resolved.Provider]
	return providers.IsCanonicalOpenAiForwardProvider(EffectiveWireAdapter(resolved.Provider, resolved.Model, provider), provider.AuthMode, provider.BaseURL)
}

func (fallback *responseSubagentFallback) activeAccountID() string {
	if id := strings.TrimSpace(fallback.config.ActiveCodexAccountID); id != "" {
		return id
	}
	return codex.MainCodexAccountID
}

func (fallback *responseSubagentFallback) codexConfig() codex.SubagentFallbackConfig {
	known := make([]string, 0, len(fallback.config.Providers)+16)
	for name := range fallback.config.Providers {
		known = append(known, name)
	}
	for _, entry := range providers.ListRegistryEntries() {
		known = append(known, entry.ID)
	}
	return codex.SubagentFallbackConfig{
		FallbackModels:    append([]string(nil), fallback.config.SubagentModelFallback...),
		DisabledModels:    append([]string(nil), fallback.config.DisabledModels...),
		KnownProviders:    known,
		ActiveAccountID:   fallback.activeAccountID(),
		AutoSwitchPercent: float64(fallback.config.AutoSwitchThreshold),
		PollInterval:      time.Duration(fallback.config.SubagentModelFallbackPollMS) * time.Millisecond,
		Route: func(model string) (codex.FallbackRoute, error) {
			resolved, err := fallback.registry.ResolveModel(model)
			if err != nil {
				return codex.FallbackRoute{}, err
			}
			configured := fallback.config.Providers[resolved.Provider]
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
			for _, account := range fallback.config.CodexAccounts {
				if account.ID == accountID && !account.IsMain {
					return true
				}
			}
			return false
		},
		AccountPlan: func(accountID string) string {
			for _, account := range fallback.config.CodexAccounts {
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
