package cli

import (
	"context"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/oauth"
)

type tokenGuardianLifecycle interface {
	Start(context.Context) error
	Stop()
}

var newTokenGuardian = func(store *oauth.CredentialStore, cfg oauth.GuardianConfig, refreshers map[string]oauth.RefreshFunc) tokenGuardianLifecycle {
	return oauth.NewTokenGuardian(store, cfg, refreshers)
}

func configuredOAuthRefreshers(cfg config.Config, client oauth.HTTPDoer, proactiveOnly bool) map[string]oauth.RefreshFunc {
	refreshers := make(map[string]oauth.RefreshFunc)
	for provider, providerCfg := range cfg.Providers {
		policy := providerCfg.RefreshPolicy
		if policy == "disabled" || proactiveOnly && policy != "proactive" {
			continue
		}
		var refresh oauth.RefreshFunc
		switch provider {
		case "openai", "chatgpt":
			refresh = oauth.NewChatGPTFlow(client).Refresh
		case "anthropic":
			refresh = oauth.NewAnthropicFlow(client).Refresh
		case "xai":
			refresh = oauth.NewXAIFlow(client).Refresh
		case "google-antigravity":
			refresh = oauth.NewAntigravityFlow(client).Refresh
		case "cursor":
			refresh = oauth.NewCursorFlow(client).Refresh
		case "kimi":
			refresh = oauth.NewKimiFlow(client).Refresh
		}
		if refresh != nil {
			refreshers[provider] = refresh
		}
	}
	return refreshers
}

func activateTokenGuardian(ctx context.Context, cfg config.Config, store *oauth.CredentialStore, client oauth.HTTPDoer) (func(), error) {
	if cfg.TokenGuardian == nil || !cfg.TokenGuardian.Enabled {
		return func() {}, nil
	}
	guardianCfg := oauth.GuardianConfig{Enabled: true}
	if cfg.TokenGuardian.TickSeconds > 0 {
		guardianCfg.Interval = time.Duration(cfg.TokenGuardian.TickSeconds) * time.Second
	}
	if cfg.TokenGuardian.LeadSeconds > 0 {
		guardianCfg.LeadTime = time.Duration(cfg.TokenGuardian.LeadSeconds) * time.Second
	}
	guardian := newTokenGuardian(store, guardianCfg, configuredOAuthRefreshers(cfg, client, true))
	if err := guardian.Start(ctx); err != nil {
		return nil, err
	}
	return guardian.Stop, nil
}
