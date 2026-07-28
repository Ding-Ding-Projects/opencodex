package oauth

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/config"
	shared "github.com/lidge-jun/opencodex-go/internal/types"
)

// AuthResolver resolves provider credentials at request time and satisfies the
// shared AuthProvider port used by the proxy server.
type AuthResolver struct {
	Store *CredentialStore
	Pool  *AccountPool
	Skew  time.Duration

	// Anthropic is the opt-in Anthropic pool. It is a separate field rather
	// than another AccountPool because the two select on different contracts:
	// this one is session-keyed and strategy-driven, and its own config decides
	// whether it participates at all.
	Anthropic *AnthropicPool

	mu         sync.RWMutex
	configs    map[string]ProviderAuthConfig
	refreshers map[string]RefreshFunc
	// anthropicPool is re-set per request by the live-config path, so it is
	// guarded rather than exported: an unsynchronized func field would race the
	// request that is reading it.
	anthropicPool    config.NormalizedAnthropicPool
	anthropicPoolSet bool
}

// SetAnthropicPoolConfig publishes the opt-in settings for later resolutions.
func (r *AuthResolver) SetAnthropicPoolConfig(pool config.NormalizedAnthropicPool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.anthropicPool, r.anthropicPoolSet = pool, true
}

func (r *AuthResolver) anthropicPoolConfig() (config.NormalizedAnthropicPool, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.anthropicPool, r.anthropicPoolSet
}

func NewAuthResolver(store *CredentialStore, configs map[string]ProviderAuthConfig, refreshers map[string]RefreshFunc) *AuthResolver {
	return &AuthResolver{Store: store, Skew: time.Minute, configs: configs, refreshers: refreshers}
}

func (r *AuthResolver) ResolveAuth(ctx context.Context, provider, threadID string) (*shared.AuthContext, error) {
	r.mu.RLock()
	config, configured := r.configs[provider]
	refresh := r.refreshers[provider]
	r.mu.RUnlock()
	if !configured {
		config = ProviderAuthConfig{Mode: AuthModeOAuth}
	}
	switch config.Mode {
	case AuthModeAPIKey:
		return apiKeyAuthContext(provider, config)
	case AuthModeForward:
		return &shared.AuthContext{Kind: "forward", Provider: provider}, nil
	case AuthModeOAuth, "":
		return r.resolveOAuth(ctx, provider, threadID, config, refresh)
	default:
		return nil, fmt.Errorf("unsupported auth mode %q for %s", config.Mode, provider)
	}
}

func apiKeyAuthContext(provider string, config ProviderAuthConfig) (*shared.AuthContext, error) {
	if strings.TrimSpace(config.APIKey) == "" {
		if config.KeyOptional {
			return &shared.AuthContext{Kind: "api-key", Provider: provider}, nil
		}
		return nil, fmt.Errorf("%w: %s API key is empty", ErrLoginRequired, provider)
	}
	header := config.HeaderName
	if header == "" {
		header = "Authorization"
	}
	prefix := config.HeaderPrefix
	if prefix == "" && strings.EqualFold(header, "Authorization") {
		prefix = "Bearer "
	}
	return &shared.AuthContext{
		Kind: "api-key", Provider: provider, APIKey: config.APIKey,
		Headers: map[string]string{header: prefix + config.APIKey},
	}, nil
}

func (r *AuthResolver) resolveOAuth(ctx context.Context, provider, threadID string, config ProviderAuthConfig, refresh RefreshFunc) (*shared.AuthContext, error) {
	account, err := r.selectAccount(ctx, provider, threadID, config.UsePool)
	if err != nil {
		return nil, err
	}
	credential := account.Credential
	if credential.Expired(time.Now(), r.Skew) {
		if refresh == nil || credential.Refresh == "" {
			return nil, fmt.Errorf("%w: %s", ErrLoginRequired, provider)
		}
		result, refreshErr := r.Store.RefreshAccountIfGeneration(
			ctx, provider, account.ID, CredentialGeneration(credential), refresh,
		)
		if refreshErr != nil {
			return nil, fmt.Errorf("refresh %s OAuth credential: %w", provider, refreshErr)
		}
		credential = result.Credential
	}
	if credential.Access == "" {
		return nil, fmt.Errorf("%w: %s", ErrLoginRequired, provider)
	}
	headers := map[string]string{"Authorization": "Bearer " + credential.Access}
	if (provider == "chatgpt" || config.UsePool) && credential.AccountID != "" {
		headers["chatgpt-account-id"] = credential.AccountID
	}
	return &shared.AuthContext{
		Kind: "oauth", Provider: provider, AccountID: account.ID,
		Generation: generationNumber(credential), AccessToken: credential.Access,
		ChatGPTAccountID: credential.AccountID, Headers: headers,
	}, nil
}

func (r *AuthResolver) selectAccount(ctx context.Context, provider, threadID string, usePool bool) (ProviderAccount, error) {
	// Anthropic routes through its own pool when the opt-in is on. Checked
	// before usePool because that flag belongs to the Codex pool and is never
	// set for this provider.
	if provider == anthropicPoolProvider && r.Anthropic != nil {
		if pool, configured := r.anthropicPoolConfig(); configured && pool.Enabled {
			return r.selectAnthropicAccount(provider, threadID, pool)
		}
	}
	if usePool {
		if r.Pool == nil {
			return ProviderAccount{}, ErrNoUsableAccount
		}
		if r.Pool.provider != provider {
			return ProviderAccount{}, fmt.Errorf("account pool belongs to %s, not %s", r.Pool.provider, provider)
		}
		return r.Pool.Select(ctx, threadID)
	}
	set, ok, err := r.Store.GetAccountSet(provider)
	if err != nil {
		return ProviderAccount{}, err
	}
	if !ok {
		return ProviderAccount{}, fmt.Errorf("%w: %s", ErrLoginRequired, provider)
	}
	for _, account := range set.Accounts {
		if account.ID == set.ActiveAccountID && !account.NeedsReauth {
			return account, nil
		}
	}
	return ProviderAccount{}, fmt.Errorf("%w: %s", ErrLoginRequired, provider)
}

// selectAnthropicAccount resolves through the opt-in pool and reports why it
// failed, because "every account is cooling down" and "no account is logged in"
// need different operator responses.
func (r *AuthResolver) selectAnthropicAccount(
	provider, sessionKey string, pool config.NormalizedAnthropicPool,
) (ProviderAccount, error) {
	selection := r.Anthropic.Resolve(sessionKey, pool, time.Now())
	if selection.AccountID == "" {
		if selection.Reason == AnthropicReasonAllCooled {
			return ProviderAccount{}, ErrNoUsableAccount
		}
		return ProviderAccount{}, fmt.Errorf("%w: %s", ErrLoginRequired, provider)
	}
	set, ok, err := r.Store.GetAccountSet(provider)
	if err != nil {
		return ProviderAccount{}, err
	}
	if !ok {
		return ProviderAccount{}, fmt.Errorf("%w: %s", ErrLoginRequired, provider)
	}
	for _, account := range set.Accounts {
		if account.ID == selection.AccountID {
			return account, nil
		}
	}
	return ProviderAccount{}, fmt.Errorf("%w: %s", ErrLoginRequired, provider)
}

func generationNumber(credential OAuthCredentials) int64 {
	digest := sha256.Sum256([]byte(CredentialGeneration(credential)))
	return int64(binary.BigEndian.Uint64(digest[:8]) & ^(uint64(1) << 63))
}

// CredentialGenerationNumber exposes the stable numeric generation used by
// cross-package request affinity without exposing credential bytes.
func CredentialGenerationNumber(credential OAuthCredentials) int64 {
	return generationNumber(credential)
}

func (r *AuthResolver) RecordOutcome(account string, status shared.OutcomeStatus, meta *shared.RetryMeta) {
	if r.Pool != nil {
		r.Pool.RecordOutcome(account, status, meta)
	}
}

func (r *AuthResolver) SetProvider(provider string, config ProviderAuthConfig, refresh RefreshFunc) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.configs == nil {
		r.configs = make(map[string]ProviderAuthConfig)
	}
	if r.refreshers == nil {
		r.refreshers = make(map[string]RefreshFunc)
	}
	r.configs[provider] = config
	if refresh == nil {
		delete(r.refreshers, provider)
	} else {
		r.refreshers[provider] = refresh
	}
}

var _ shared.AuthProvider = (*AuthResolver)(nil)
