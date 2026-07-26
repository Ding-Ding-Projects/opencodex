package codex

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/oauth"
)

const oauthCredentialSkew = time.Minute

// OAuthAccountStore adapts the production unified OAuth credential store to
// the canonical Codex routing/auth owner.
type OAuthAccountStore struct {
	store   *oauth.CredentialStore
	refresh oauth.RefreshFunc
	now     func() time.Time
}

func NewOAuthAccountStore(store *oauth.CredentialStore, refresh oauth.RefreshFunc) *OAuthAccountStore {
	return &OAuthAccountStore{store: store, refresh: refresh, now: time.Now}
}

func (s *OAuthAccountStore) account(id string) (oauth.ProviderAccount, bool, error) {
	if s == nil || s.store == nil {
		return oauth.ProviderAccount{}, false, nil
	}
	set, found, err := s.store.GetAccountSet("openai")
	if err != nil || !found {
		return oauth.ProviderAccount{}, false, err
	}
	for _, account := range set.Accounts {
		if account.ID == id {
			return account, true, nil
		}
	}
	return oauth.ProviderAccount{}, false, nil
}

func (s *OAuthAccountStore) GetCredential(id string) (AccountCredentials, bool, error) {
	account, found, err := s.account(id)
	if err != nil || !found || account.NeedsReauth {
		return AccountCredentials{}, false, err
	}
	return oauthToCodexCredential(account.Credential), true, nil
}

func (s *OAuthAccountStore) GetValidToken(ctx context.Context, id string, _ *http.Client) (ValidToken, error) {
	account, found, err := s.account(id)
	if err != nil {
		return ValidToken{}, err
	}
	if !found || account.NeedsReauth {
		return ValidToken{}, errors.New("Codex account credential is unavailable; reauthenticate the account")
	}
	credential := account.Credential
	if credential.Expired(s.now(), oauthCredentialSkew) {
		if s.refresh == nil || credential.Refresh == "" {
			return ValidToken{}, errors.New("Codex account credential is expired; reauthenticate the account")
		}
		result, refreshErr := s.store.RefreshAccountIfGeneration(ctx, "openai", id, oauth.CredentialGeneration(credential), s.refresh)
		if refreshErr != nil {
			if errors.Is(refreshErr, context.Canceled) || errors.Is(refreshErr, context.DeadlineExceeded) {
				return ValidToken{}, fmt.Errorf("%w: %v", ErrCredentialRefreshLockTimeout, refreshErr)
			}
			return ValidToken{}, refreshErr
		}
		credential = result.Credential
	}
	return ValidToken{
		AccessToken: credential.Access, ChatGPTAccountID: credential.AccountID,
		Generation: oauth.CredentialGenerationNumber(credential),
	}, nil
}

func (s *OAuthAccountStore) IsGenerationLive(id string, generation int64) bool {
	account, found, err := s.account(id)
	return err == nil && found && !account.NeedsReauth &&
		oauth.CredentialGenerationNumber(account.Credential) == generation
}

func (s *OAuthAccountStore) CredentialGeneration(id string) (int64, bool, error) {
	account, found, err := s.account(id)
	if err != nil || !found || account.NeedsReauth {
		return 0, false, err
	}
	return oauth.CredentialGenerationNumber(account.Credential), true, nil
}

func oauthToCodexCredential(credential oauth.OAuthCredentials) AccountCredentials {
	return AccountCredentials{
		AccessToken: credential.Access, RefreshToken: credential.Refresh,
		ExpiresAt: credential.Expires, ChatGPTAccountID: credential.AccountID,
	}
}

var _ RoutingAccountStore = (*OAuthAccountStore)(nil)
