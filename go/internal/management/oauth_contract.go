package management

import "context"

// BackendError lets composition preserve the TypeScript management API's
// status/message contract without exposing provider response bodies.
type BackendError struct {
	Status  int
	Message string
	Code    string
}

func (e *BackendError) Error() string { return e.Message }

type OAuthLoginOptions struct {
	AddAccount      bool
	Reauth          bool
	ReauthAccountID string
}

type OAuthLoginStart struct {
	URL          string `json:"url,omitempty"`
	Instructions string `json:"instructions,omitempty"`
	DeviceCode   string `json:"deviceCode,omitempty"`
}

type OAuthAccount struct {
	ID          string `json:"id"`
	Alias       string `json:"alias,omitempty"`
	Email       string `json:"email,omitempty"`
	Active      bool   `json:"active"`
	NeedsReauth bool   `json:"needsReauth,omitempty"`
}

type OAuthAccountSet struct {
	ActiveAccountID string         `json:"activeAccountId,omitempty"`
	Accounts        []OAuthAccount `json:"accounts"`
}

type OAuthStatus struct {
	Provider        string         `json:"provider,omitempty"`
	State           string         `json:"state,omitempty"`
	LoggedIn        bool           `json:"loggedIn"`
	Done            bool           `json:"done,omitempty"`
	NeedsReauth     bool           `json:"needsReauth,omitempty"`
	ActiveAccountID string         `json:"activeAccountId,omitempty"`
	Accounts        []OAuthAccount `json:"accounts,omitempty"`
	Error           string         `json:"error,omitempty"`
}

// OAuthBackend is implemented by CLI composition. The management package owns
// HTTP parsing and response safety; implementations own provider flow state and
// credential-store mutations. No method may return access or refresh tokens.
type OAuthBackend interface {
	Providers() []string
	Start(context.Context, string, OAuthLoginOptions) (OAuthLoginStart, error)
	Cancel(string) (bool, error)
	SubmitCode(context.Context, string, string) error
	Status(string) OAuthStatus
	Logout(context.Context, string) error
	Accounts(string) (OAuthAccountSet, error)
	SetActive(context.Context, string, string) (bool, error)
	SetAlias(context.Context, string, string, string) (bool, error)
	RemoveAccount(context.Context, string, string) (bool, error)
}

// ModelCacheInvalidator is satisfied by codex.ModelCache and registry.ModelCache.
// Composition must inject the same instance used by live catalog discovery.
type ModelCacheInvalidator interface {
	Clear(provider string)
}

type CodexAccountQuota struct {
	WeeklyPercent  *float64 `json:"weeklyPercent,omitempty"`
	MonthlyPercent *float64 `json:"monthlyPercent,omitempty"`
	WeeklyResetAt  *float64 `json:"weeklyResetAt,omitempty"`
	MonthlyResetAt *float64 `json:"monthlyResetAt,omitempty"`
	ResetCredits   *int     `json:"resetCredits,omitempty"`
	UpdatedAt      int64    `json:"updatedAt"`
}

// CodexAuthAccount is deliberately a display-only projection. Credential and
// upstream account identifiers are not representable, so they cannot leak via
// management JSON by accident.
type CodexAuthAccount struct {
	ID            string             `json:"id"`
	Alias         string             `json:"alias,omitempty"`
	Email         string             `json:"email"`
	Plan          *string            `json:"plan,omitempty"`
	LogLabel      string             `json:"logLabel,omitempty"`
	IsMain        bool               `json:"isMain"`
	Quota         *CodexAccountQuota `json:"quota"`
	NeedsReauth   bool               `json:"needsReauth,omitempty"`
	HasCredential bool               `json:"hasCredential"`
}

type CodexAccountImport struct {
	ID               string
	Email            string
	Plan             string
	AccessToken      string
	RefreshToken     string
	ChatGPTAccountID string
}

type CodexLoginOptions struct {
	AccountID string
	Reauth    bool
}

type CodexLoginStart struct {
	FlowID       string `json:"flowId"`
	URL          string `json:"url,omitempty"`
	Instructions string `json:"instructions,omitempty"`
}

type CodexLoginStatus struct {
	Status    string `json:"status"`
	AccountID string `json:"accountId,omitempty"`
	Email     string `json:"email,omitempty"`
	Error     string `json:"error,omitempty"`
	DoneAt    int64  `json:"doneAt,omitempty"`
}

type ResetCredit struct {
	GrantedAt string `json:"granted_at"`
	ExpiresAt string `json:"expires_at"`
}

type ResetCredits struct {
	Credits        []ResetCredit `json:"credits"`
	AvailableCount *int          `json:"available_count,omitempty"`
}

type ResetCreditConsumeResult struct {
	Code      string `json:"code"`
	Remaining *int   `json:"remaining,omitempty"`
}

// CodexResetCreditConsumer is the expanded consume contract. Remaining must
// come from the fresh post-consume WHAM response; implementations must leave it
// nil when refresh fails or omits available_count rather than using cached quota.
type CodexResetCreditConsumer interface {
	ConsumeCodexResetCredit(context.Context, string) (ResetCreditConsumeResult, error)
}

// legacyCodexResetCreditConsumer keeps already-built CLI backends source
// compatible during the contract handoff. Remove after every composition owner
// implements CodexResetCreditConsumer.
type legacyCodexResetCreditConsumer interface {
	ConsumeCodexResetCredit(context.Context, string) (string, error)
}

// CodexAuthBackend is injected by CLI composition. Implementations own all
// credential-store and OAuth state. Returned values must contain display-safe
// metadata only; tokens and physical ChatGPT account IDs never cross this API.
type CodexAuthBackend interface {
	ListCodexAccounts(context.Context, bool) ([]CodexAuthAccount, error)
	ImportCodexAccount(context.Context, CodexAccountImport) error
	DeleteCodexAccount(context.Context, string) error
	SetCodexAccountAlias(context.Context, string, string) (bool, error)
	CodexResetCredits(context.Context, string) (ResetCredits, error)
	StartCodexLogin(context.Context, CodexLoginOptions) (CodexLoginStart, error)
	SubmitCodexLoginCode(context.Context, string, string) error
	CancelCodexLogin(context.Context, string) (bool, error)
	CodexLoginStatus(context.Context, string, string, bool) CodexLoginStatus
}
