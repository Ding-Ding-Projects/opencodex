package cli

import (
	"context"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/oauth"
)

type guardianLifecycleProbe struct {
	started bool
	stopped bool
}

func (p *guardianLifecycleProbe) Start(context.Context) error { p.started = true; return nil }
func (p *guardianLifecycleProbe) Stop()                       { p.stopped = true }

func TestActivateTokenGuardianStartsAndStopsProductionLifecycle(t *testing.T) {
	cfg := config.FreshInstall()
	cfg.TokenGuardian = &config.TokenGuardianConfig{Enabled: true, TickSeconds: 60, LeadSeconds: 15}
	cfg.Providers["anthropic"] = config.ProviderConfig{RefreshPolicy: "proactive"}
	probe := &guardianLifecycleProbe{}
	original := newTokenGuardian
	t.Cleanup(func() { newTokenGuardian = original })
	newTokenGuardian = func(_ *oauth.CredentialStore, guardianCfg oauth.GuardianConfig, refreshers map[string]oauth.RefreshFunc) tokenGuardianLifecycle {
		if !guardianCfg.Enabled || guardianCfg.Interval.Seconds() != 60 || guardianCfg.LeadTime.Seconds() != 15 {
			t.Fatalf("guardian config=%#v", guardianCfg)
		}
		if refreshers["anthropic"] == nil {
			t.Fatal("proactive Anthropic refresher was not wired")
		}
		return probe
	}
	stop, err := activateTokenGuardian(context.Background(), cfg, oauth.NewCredentialStore(t.TempDir()+"/auth.json"), nil)
	if err != nil {
		t.Fatal(err)
	}
	if !probe.started {
		t.Fatal("guardian did not start")
	}
	stop()
	if !probe.stopped {
		t.Fatal("guardian did not stop")
	}
}

func TestConfiguredOAuthRefreshersRespectEffectivePolicy(t *testing.T) {
	cfg := config.FreshInstall()
	cfg.Providers["anthropic"] = config.ProviderConfig{RefreshPolicy: "proactive"}
	cfg.Providers["cursor"] = config.ProviderConfig{RefreshPolicy: "lazy-only"}
	cfg.Providers["xai"] = config.ProviderConfig{RefreshPolicy: "disabled"}
	proactive := configuredOAuthRefreshers(cfg, nil, true)
	if proactive["anthropic"] == nil || proactive["cursor"] != nil || proactive["xai"] != nil {
		t.Fatalf("proactive refreshers=%v", proactive)
	}
	lazy := configuredOAuthRefreshers(cfg, nil, false)
	if lazy["anthropic"] == nil || lazy["cursor"] == nil || lazy["xai"] != nil {
		t.Fatalf("request refreshers=%v", lazy)
	}
}
