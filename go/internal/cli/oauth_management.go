package cli

import (
	"context"
	"errors"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/management"
	"github.com/lidge-jun/opencodex-go/internal/oauth"
)

type oauthManagementSession struct {
	cancel context.CancelFunc
	code   chan string
	status management.OAuthStatus
}

type cliOAuthManagement struct {
	store    *oauth.CredentialStore
	mu       sync.Mutex
	sessions map[string]*oauthManagementSession
}

var _ management.OAuthBackend = (*cliOAuthManagement)(nil)

func newOAuthManagement(store *oauth.CredentialStore) *cliOAuthManagement {
	return &cliOAuthManagement{store: store, sessions: make(map[string]*oauthManagementSession)}
}

func (m *cliOAuthManagement) Providers() []string {
	return append([]string(nil), publicOAuthProviders...)
}

func (m *cliOAuthManagement) Start(_ context.Context, provider string, options management.OAuthLoginOptions) (management.OAuthLoginStart, error) {
	flowName, storeName := normalizeLoginProvider(provider)
	flow, err := newLoginFlow(flowName, nil, "")
	if err != nil {
		return management.OAuthLoginStart{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	session := &oauthManagementSession{cancel: cancel, code: make(chan string, 1), status: management.OAuthStatus{Provider: storeName, State: "starting"}}
	manual := func(ctx context.Context, _ string) (string, error) {
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case value := <-session.code:
			return value, nil
		}
	}
	switch typed := flow.(type) {
	case browserLoginFlow:
		typed.manual = manual
		flow = typed
	case anthropicLoginFlow:
		typed.browser.manual = manual
		flow = typed
	}
	m.mu.Lock()
	if existing := m.sessions[storeName]; existing != nil {
		existing.cancel()
	}
	m.sessions[storeName] = session
	m.mu.Unlock()
	authReady := make(chan management.OAuthLoginStart, 1)
	go m.runLoginSession(ctx, storeName, flow, options, session, authReady)
	select {
	case started := <-authReady:
		return started, nil
	case <-time.After(15 * time.Second):
		return management.OAuthLoginStart{Instructions: "OAuth login is starting; poll status for progress."}, nil
	case <-ctx.Done():
		return management.OAuthLoginStart{}, ctx.Err()
	}
}

func (m *cliOAuthManagement) runLoginSession(ctx context.Context, provider string, flow loginFlow, options management.OAuthLoginOptions, session *oauthManagementSession, authReady chan<- management.OAuthLoginStart) {
	defer session.cancel()
	sent := false
	credential, err := flow.Login(ctx, func(auth oauth.Authorization) {
		started := management.OAuthLoginStart{URL: auth.URL, Instructions: auth.Instructions}
		m.setOAuthStatus(provider, func(status *management.OAuthStatus) { status.State = "pending" })
		if !sent {
			sent = true
			authReady <- started
		}
	})
	if !sent {
		sent = true
		authReady <- management.OAuthLoginStart{}
	}
	if err == nil {
		if options.ReauthAccountID != "" {
			err = m.store.SaveAccountCredential(ctx, provider, options.ReauthAccountID, credential)
		} else {
			err = m.store.SaveCredential(ctx, provider, credential)
		}
	}
	if err == nil && provider != "openai" {
		err = upsertOAuthProviderConfig(provider)
	}
	m.setOAuthStatus(provider, func(status *management.OAuthStatus) {
		status.Done = true
		if err != nil {
			status.State, status.Error = "error", err.Error()
		} else {
			status.State, status.LoggedIn = "complete", true
		}
	})
}

func (m *cliOAuthManagement) setOAuthStatus(provider string, update func(*management.OAuthStatus)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if session := m.sessions[provider]; session != nil {
		update(&session.status)
	}
}

func (m *cliOAuthManagement) Cancel(provider string) (bool, error) {
	_, provider = normalizeLoginProvider(provider)
	m.mu.Lock()
	session := m.sessions[provider]
	m.mu.Unlock()
	if session == nil || session.status.Done {
		return false, nil
	}
	session.cancel()
	m.setOAuthStatus(provider, func(status *management.OAuthStatus) { status.State, status.Done = "cancelled", true })
	return true, nil
}

func (m *cliOAuthManagement) SubmitCode(ctx context.Context, provider, input string) error {
	_, provider = normalizeLoginProvider(provider)
	m.mu.Lock()
	session := m.sessions[provider]
	m.mu.Unlock()
	if session == nil {
		return errors.New("OAuth login is not active")
	}
	select {
	case session.code <- strings.TrimSpace(input):
		return nil
	case <-ctx.Done():
		return ctx.Err()
	default:
		return errors.New("OAuth code is already pending")
	}
}

func (m *cliOAuthManagement) Status(provider string) management.OAuthStatus {
	_, provider = normalizeLoginProvider(provider)
	m.mu.Lock()
	session := m.sessions[provider]
	var status management.OAuthStatus
	if session != nil {
		status = session.status
	}
	m.mu.Unlock()
	set, _ := m.Accounts(provider)
	status.Provider, status.ActiveAccountID, status.Accounts = provider, set.ActiveAccountID, set.Accounts
	status.LoggedIn = len(set.Accounts) > 0
	if session == nil {
		status.State = map[bool]string{true: "complete", false: "idle"}[status.LoggedIn]
	}
	return status
}

func (m *cliOAuthManagement) Logout(ctx context.Context, provider string) error {
	_, provider = normalizeLoginProvider(provider)
	set, ok, err := m.store.GetAccountSet(provider)
	if err != nil || !ok {
		return err
	}
	for _, account := range set.Accounts {
		if _, err := m.store.RemoveAccount(ctx, provider, account.ID); err != nil {
			return err
		}
	}
	return nil
}

func (m *cliOAuthManagement) Accounts(provider string) (management.OAuthAccountSet, error) {
	_, provider = normalizeLoginProvider(provider)
	set, ok, err := m.store.GetAccountSet(provider)
	if err != nil || !ok {
		return management.OAuthAccountSet{Accounts: []management.OAuthAccount{}}, err
	}
	result := management.OAuthAccountSet{ActiveAccountID: set.ActiveAccountID, Accounts: make([]management.OAuthAccount, 0, len(set.Accounts))}
	for _, account := range set.Accounts {
		result.Accounts = append(result.Accounts, management.OAuthAccount{ID: account.ID, Alias: account.Alias, Email: account.Credential.Email, Active: account.ID == set.ActiveAccountID, NeedsReauth: account.NeedsReauth})
	}
	sort.Slice(result.Accounts, func(i, j int) bool { return result.Accounts[i].ID < result.Accounts[j].ID })
	return result, nil
}

func (m *cliOAuthManagement) SetActive(ctx context.Context, provider, accountID string) (bool, error) {
	_, provider = normalizeLoginProvider(provider)
	return m.store.SetActiveAccount(ctx, provider, accountID)
}
func (m *cliOAuthManagement) SetAlias(ctx context.Context, provider, accountID, alias string) (bool, error) {
	_, provider = normalizeLoginProvider(provider)
	return m.store.SetAccountAlias(ctx, provider, accountID, alias)
}
func (m *cliOAuthManagement) RemoveAccount(ctx context.Context, provider, accountID string) (bool, error) {
	_, provider = normalizeLoginProvider(provider)
	return m.store.RemoveAccount(ctx, provider, accountID)
}
