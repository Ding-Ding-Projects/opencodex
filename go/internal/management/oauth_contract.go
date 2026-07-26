package management

import "context"

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
