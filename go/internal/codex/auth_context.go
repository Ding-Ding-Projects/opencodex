package codex

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	openaiadapter "github.com/lidge-jun/opencodex-go/internal/adapter/openai"
	"github.com/lidge-jun/opencodex-go/internal/config"
)

type AuthContextKind string

const (
	AuthContextMain     AuthContextKind = "main"
	AuthContextPool     AuthContextKind = "pool"
	AuthContextMainPool AuthContextKind = "main-pool"
)

// AuthContext discriminates passthrough main auth from managed and read-only pool auth.
type AuthContext struct {
	Kind             AuthContextKind
	AccountID        string
	Generation       int64
	AccessToken      string
	ChatGPTAccountID string
	ProbeLease       *ProbeLease
}

func (c *AuthContext) ProbeLeaseID() string {
	if c == nil || c.ProbeLease == nil || c.Kind != AuthContextPool && c.Kind != AuthContextMainPool {
		return ""
	}
	return c.ProbeLease.ID
}

type CodexAuthContextError struct {
	AccountID string
	Cause     error
}

func (e *CodexAuthContextError) Error() string { return "Codex pool account auth failed" }
func (e *CodexAuthContextError) Unwrap() error { return e.Cause }

type CodexPoolAuthenticationError struct{}

func (*CodexPoolAuthenticationError) Error() string {
	return "OpenAI account pool has no usable account credential"
}

type CodexDirectAuthenticationError struct{}

func (*CodexDirectAuthenticationError) Error() string {
	return "Codex Direct requires a caller Authorization bearer token"
}

type CodexAccountCooldownError struct {
	AccountID     string
	CooldownUntil time.Time
}

func (e *CodexAccountCooldownError) Error() string { return "selected Codex account is cooling down" }

type CodexThreadAffinityExpiredError struct{ AccountID string }

func (e *CodexThreadAffinityExpiredError) Error() string {
	return "Codex thread account affinity expired"
}

type ResolveCodexAuthContextOptions struct {
	ExcludeAccountID string
}

type AuthResolver struct {
	Router     *Router
	Store      *AccountStore
	MainToken  func() (MainAccountToken, bool)
	HTTPClient *http.Client
	PrimeQuota func(*RoutingConfig, string)
	Now        func() time.Time
}

func HasCallerCodexBearer(headers http.Header) bool {
	parts := strings.Fields(strings.TrimSpace(headers.Get("authorization")))
	return len(parts) >= 2 && strings.EqualFold(parts[0], "bearer") && parts[1] != ""
}

func ShouldMarkAccountNeedsReauthForCodexAuthFailure(cause error) bool {
	return !errors.Is(cause, ErrCredentialGenerationConflict) && !errors.Is(cause, ErrCredentialRefreshLockTimeout)
}

func (r *AuthResolver) ResolveCodexAuthContext(
	ctx context.Context,
	headers http.Header,
	config *RoutingConfig,
	mode string,
	options ResolveCodexAuthContextOptions,
) (*AuthContext, error) {
	if mode == "direct" {
		if !HasCallerCodexBearer(headers) {
			return nil, &CodexDirectAuthenticationError{}
		}
		return &AuthContext{Kind: AuthContextMain}, nil
	}
	if r.Router == nil || r.Store == nil {
		return nil, &CodexPoolAuthenticationError{}
	}
	now := time.Now()
	if r.Now != nil {
		now = r.Now()
	}
	var resolution CodexThreadResolution
	if options.ExcludeAccountID != "" {
		accountID := r.Router.PickLowestUsageCodexAccount(config, options.ExcludeAccountID, now)
		if accountID == "" {
			resolution = CodexThreadResolution{Status: ThreadNone}
		} else {
			resolution = CodexThreadResolution{Status: ThreadSelected, AccountID: accountID}
		}
	} else {
		resolution = r.Router.ResolveCodexAccountForThreadDetailed(headers.Get("x-codex-parent-thread-id"), config, now)
	}
	if resolution.Status == ThreadExpired {
		return nil, &CodexThreadAffinityExpiredError{AccountID: resolution.AccountID}
	}
	if resolution.Status != ThreadSelected || resolution.AccountID == "" {
		return nil, &CodexPoolAuthenticationError{}
	}
	accountID := resolution.AccountID
	if r.PrimeQuota != nil {
		r.Router.mu.Lock()
		_, hasQuota := r.Router.quotas[accountID]
		r.Router.mu.Unlock()
		if !hasQuota {
			go r.PrimeQuota(config, "pre-route")
		}
	}

	var lease *ProbeLease
	if cooldownUntil, cooling := r.Router.GetCodexAccountCooldownUntil(accountID, now); cooling {
		if acquired, ok := r.Router.TryAcquireCodexQuotaProbeLease(accountID, now); ok {
			lease = &acquired
		} else {
			return nil, &CodexAccountCooldownError{AccountID: accountID, CooldownUntil: cooldownUntil}
		}
	}
	if accountID == MainCodexAccountID {
		mainToken := r.MainToken
		if mainToken == nil {
			mainToken = r.Router.mainToken
		}
		if mainToken == nil {
			r.releaseLease(accountID, lease, now)
			return nil, &CodexPoolAuthenticationError{}
		}
		token, ok := mainToken()
		if !ok || !token.Live(now) {
			r.releaseLease(accountID, lease, now)
			return nil, &CodexPoolAuthenticationError{}
		}
		return &AuthContext{
			Kind: AuthContextMainPool, AccountID: accountID, AccessToken: token.AccessToken,
			ChatGPTAccountID: token.ChatGPTAccountID, ProbeLease: lease,
		}, nil
	}

	token, err := r.Store.GetValidToken(ctx, accountID, r.HTTPClient)
	if err != nil {
		r.releaseLease(accountID, lease, now)
		if ShouldMarkAccountNeedsReauthForCodexAuthFailure(err) {
			r.Router.MarkAccountNeedsReauth(accountID)
		}
		return nil, &CodexAuthContextError{AccountID: accountID, Cause: err}
	}
	return &AuthContext{
		Kind: AuthContextPool, AccountID: accountID, Generation: token.Generation,
		AccessToken: token.AccessToken, ChatGPTAccountID: token.ChatGPTAccountID, ProbeLease: lease,
	}, nil
}

func (r *AuthResolver) releaseLease(accountID string, lease *ProbeLease, now time.Time) {
	if lease != nil && r.Router != nil {
		r.Router.ReleaseCodexQuotaProbeLease(accountID, lease.ID, now)
	}
}

func (r *AuthResolver) ReleaseCodexAuthContextProbeLease(auth *AuthContext) {
	if auth == nil || auth.ProbeLeaseID() == "" || r.Router == nil {
		return
	}
	now := time.Now()
	if r.Now != nil {
		now = r.Now()
	}
	r.Router.ReleaseCodexQuotaProbeLease(auth.AccountID, auth.ProbeLease.ID, now)
}

func (r *AuthResolver) AssertCodexAuthContextNotCooled(auth *AuthContext) error {
	if auth == nil || auth.Kind != AuthContextPool && auth.Kind != AuthContextMainPool || auth.ProbeLease != nil {
		return nil
	}
	now := time.Now()
	if r.Now != nil {
		now = r.Now()
	}
	if until, cooling := r.Router.GetCodexAccountCooldownUntil(auth.AccountID, now); cooling {
		return &CodexAccountCooldownError{AccountID: auth.AccountID, CooldownUntil: until}
	}
	return nil
}

func (r *AuthResolver) IsCodexAuthContextUsable(auth *AuthContext, config *RoutingConfig) bool {
	if auth == nil {
		return false
	}
	if auth.Kind == AuthContextMain {
		return true
	}
	now := time.Now()
	if r.Now != nil {
		now = r.Now()
	}
	r.Router.mu.Lock()
	defer r.Router.mu.Unlock()
	if !r.Router.isUsableLocked(config, auth.AccountID, now.UnixMilli()) {
		return false
	}
	return auth.Kind == AuthContextMainPool || r.Router.generationLiveLocked(auth.AccountID, auth.Generation)
}

type CodexAccountOverride struct {
	AccessToken      string
	ChatGPTAccountID string
}

type OcxRuntimeProviderConfig struct {
	config.ProviderConfig
	CodexAccountOverride *CodexAccountOverride
	CodexAccountRequired bool
}

func ApplyCodexAuthContextToProvider(provider config.ProviderConfig, auth *AuthContext, mode string) OcxRuntimeProviderConfig {
	runtime := OcxRuntimeProviderConfig{ProviderConfig: provider}
	if mode != "pool" || auth == nil || auth.Kind != AuthContextPool && auth.Kind != AuthContextMainPool || provider.AuthMode != "forward" {
		return runtime
	}
	runtime.CodexAccountOverride = &CodexAccountOverride{auth.AccessToken, auth.ChatGPTAccountID}
	runtime.CodexAccountRequired = true
	return runtime
}

func HeadersForCodexAuthContext(headers http.Header, auth *AuthContext) http.Header {
	selected := make(http.Header)
	for _, name := range openaiadapter.ForwardHeaders {
		if value := headers.Get(name); value != "" {
			selected.Set(name, value)
		}
	}
	if auth != nil && (auth.Kind == AuthContextPool || auth.Kind == AuthContextMainPool) {
		selected.Set("authorization", "Bearer "+auth.AccessToken)
		selected.Set("chatgpt-account-id", auth.ChatGPTAccountID)
	}
	return selected
}

func StripCodexRuntimeProviderFields(provider OcxRuntimeProviderConfig) config.ProviderConfig {
	return provider.ProviderConfig
}

func (c *AuthContext) String() string {
	if c == nil {
		return "<nil>"
	}
	return fmt.Sprintf("CodexAuthContext{kind:%s account:%s}", c.Kind, c.AccountID)
}
