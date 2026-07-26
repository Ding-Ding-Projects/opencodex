package cli

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/codex"
	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/oauth"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

type codexRoutingRuntime struct {
	mu          sync.Mutex
	config      *config.Config
	persistence *config.LivePersistence
	quota       *codex.QuotaStore
	router      *codex.Router
	resolver    *codex.AuthResolver
}

// reconcileCodexRoutingAccounts imports credentials written by older Go
// releases into the metadata list required by the canonical Codex router. The
// unified OAuth store remains the credential owner; config only gains the
// account identities needed for selection and management projection.
func reconcileCodexRoutingAccounts(cfg *config.Config, persistence *config.LivePersistence, store *oauth.CredentialStore) error {
	if cfg == nil || persistence == nil || store == nil {
		return nil
	}
	set, found, err := store.GetAccountSet("openai")
	if err != nil || !found || len(set.Accounts) == 0 {
		return err
	}
	snapshot := persistence.Snapshot()
	if snapshot == nil {
		return fmt.Errorf("snapshot Codex routing config")
	}
	known := make(map[string]struct{}, len(snapshot.CodexAccounts))
	for _, account := range snapshot.CodexAccounts {
		known[account.ID] = struct{}{}
	}
	missing := make([]oauth.ProviderAccount, 0, len(set.Accounts))
	for _, stored := range set.Accounts {
		if _, exists := known[stored.ID]; !exists {
			missing = append(missing, stored)
		}
	}
	if len(missing) == 0 {
		return nil
	}
	return persistence.Update(func(live *config.Config) {
		known = make(map[string]struct{}, len(live.CodexAccounts))
		for _, account := range live.CodexAccounts {
			known[account.ID] = struct{}{}
		}
		for _, stored := range missing {
			if _, exists := known[stored.ID]; exists {
				continue
			}
			email := stored.Credential.Email
			if email == "" {
				email = "OpenAI account"
			}
			live.CodexAccounts = append(live.CodexAccounts, config.CodexAccount{
				ID: stored.ID, Email: email, Alias: stored.Alias,
				ChatGPTAccountID: stored.Credential.AccountID,
			})
			known[stored.ID] = struct{}{}
		}
	})
}

func newCodexRoutingRuntime(
	cfg *config.Config,
	persistence *config.LivePersistence,
	store *oauth.CredentialStore,
	quota *codex.QuotaStore,
	mainToken func() (codex.MainAccountToken, bool),
	refresh oauth.RefreshFunc,
	client *http.Client,
) *codexRoutingRuntime {
	accountStore := codex.NewOAuthAccountStore(store, refresh)
	runtime := &codexRoutingRuntime{config: cfg, persistence: persistence, quota: quota}
	runtime.router = codex.NewRouter(accountStore, mainToken)
	runtime.resolver = &codex.AuthResolver{
		Router: runtime.router, Store: accountStore, MainToken: mainToken, HTTPClient: client,
	}
	return runtime
}

func (r *codexRoutingRuntime) Router() *codex.Router {
	if r == nil {
		return nil
	}
	return r.router
}

func (r *codexRoutingRuntime) routingConfig() *codex.RoutingConfig {
	cfg := r.config
	if r.persistence != nil {
		cfg = r.persistence.Snapshot()
	}
	if cfg == nil {
		cfg = &config.Config{}
	}
	autoSwitch := float64(cfg.AutoSwitchThreshold)
	failover := cfg.UpstreamFailoverThreshold
	result := &codex.RoutingConfig{
		ActiveCodexAccountID: cfg.ActiveCodexAccountID,
		AutoSwitchThreshold:  &autoSwitch, UpstreamFailoverThreshold: &failover,
		CodexAccounts: make([]codex.CodexAccount, 0, len(cfg.CodexAccounts)),
	}
	for _, account := range cfg.CodexAccounts {
		result.CodexAccounts = append(result.CodexAccounts, codex.CodexAccount{
			ID: account.ID, Email: account.Email, Alias: account.Alias, Plan: account.Plan,
			ChatGPTAccountID: account.ChatGPTAccountID, LogLabel: account.LogLabel, IsMain: account.IsMain,
		})
	}
	return result
}

func (r *codexRoutingRuntime) syncQuotas() {
	if r == nil || r.quota == nil {
		return
	}
	quotas := make(map[string]codex.AccountQuota)
	for accountID, snapshot := range r.quota.List() {
		quotas[accountID] = codex.AccountQuota{
			WeeklyPercent: snapshot.WeeklyPercent, MonthlyPercent: snapshot.MonthlyPercent,
		}
	}
	r.router.ReplaceAccountQuotas(quotas)
}

func (r *codexRoutingRuntime) persistActiveTransition(previous, next string) error {
	if previous == next {
		return nil
	}
	if r.persistence == nil {
		if r.config == nil {
			return fmt.Errorf("Codex routing config is unavailable")
		}
		r.config.ActiveCodexAccountID = next
		return nil
	}
	conflict := false
	if err := r.persistence.Update(func(live *config.Config) {
		if live.ActiveCodexAccountID != previous {
			conflict = true
			return
		}
		live.ActiveCodexAccountID = next
	}); err != nil {
		return err
	}
	if conflict {
		return fmt.Errorf("Codex active account changed concurrently")
	}
	return nil
}

func (r *codexRoutingRuntime) Resolve(ctx context.Context, threadID string) (*types.AuthContext, error) {
	if r == nil || r.resolver == nil {
		return nil, fmt.Errorf("Codex account router is unavailable")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.syncQuotas()
	routing := r.routingConfig()
	previousActive := routing.ActiveCodexAccountID
	auth, err := r.resolver.ResolveCodexAuthContext(ctx, http.Header{
		"X-Codex-Parent-Thread-Id": []string{threadID},
	}, routing, "pool", codex.ResolveCodexAuthContextOptions{})
	if err != nil {
		return nil, err
	}
	if err := r.persistActiveTransition(previousActive, routing.ActiveCodexAccountID); err != nil {
		r.router.ClearThreadAccountMap()
		return nil, fmt.Errorf("persist Codex active account: %w", err)
	}
	resolvedHeaders := codex.HeadersForCodexAuthContext(nil, auth)
	headers := make(map[string]string, len(resolvedHeaders))
	for name, values := range resolvedHeaders {
		if len(values) > 0 {
			headers[name] = values[0]
		}
	}
	return &types.AuthContext{
		Kind: string(auth.Kind), Provider: "openai", AccountID: auth.AccountID,
		Generation: auth.Generation, AccessToken: auth.AccessToken,
		ChatGPTAccountID: auth.ChatGPTAccountID, Headers: headers,
		ProbeLeaseID: auth.ProbeLeaseID(), ThreadID: threadID,
	}, nil
}

func (r *codexRoutingRuntime) RecordOutcome(account string, status types.OutcomeStatus, meta *types.RetryMeta) {
	if r == nil || r.router == nil || account == "" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	code := 0
	if meta != nil {
		code = meta.StatusCode
	}
	if code == 0 {
		switch status {
		case types.OutcomeSuccess:
			code = http.StatusOK
		case types.OutcomeAuthError:
			code = http.StatusUnauthorized
		case types.OutcomeRateLimited:
			code = http.StatusTooManyRequests
		case types.OutcomeCancelled:
			code = 499
		default:
			code = http.StatusBadGateway
		}
	}
	codexMeta := codex.CodexUpstreamOutcomeMeta{Now: time.Now()}
	if meta != nil && meta.RetryAfter > 0 {
		codexMeta.RetryAfter = strconv.FormatFloat(meta.RetryAfter.Seconds(), 'f', -1, 64)
	}
	if meta != nil {
		codexMeta.ProbeLeaseID = meta.ProbeLeaseID
		codexMeta.ThreadID = meta.ThreadID
	}
	routing := r.routingConfig()
	previousActive := routing.ActiveCodexAccountID
	r.router.RecordCodexUpstreamOutcome(routing, account, code, codexMeta)
	if r.persistActiveTransition(previousActive, routing.ActiveCodexAccountID) != nil {
		r.router.ClearThreadAccountMap()
	}
}
