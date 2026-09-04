package oauth

import (
	"context"
	"errors"
	"strings"
)

func (s *CredentialStore) ListAccounts(provider string) ([]ProviderAccount, error) {
	set, ok, err := s.GetAccountSet(provider)
	if err != nil || !ok {
		return nil, err
	}
	return append([]ProviderAccount(nil), set.Accounts...), nil
}

// SaveNamedAccount persists a credential under an API-stable account id. This
// is used by Codex account management, where the public pool id is intentionally
// distinct from the physical ChatGPT account id carried by the credential.
func (s *CredentialStore) SaveNamedAccount(ctx context.Context, provider, accountID string, credential OAuthCredentials) error {
	provider, accountID = strings.TrimSpace(provider), strings.TrimSpace(accountID)
	if provider == "" || accountID == "" || !validCredential(credential) {
		return errors.New("provider, account id, and a valid OAuth credential are required")
	}
	return s.mutate(ctx, func(store AuthStore) error {
		set := store[provider]
		for index := range set.Accounts {
			if set.Accounts[index].ID != accountID {
				continue
			}
			set.Accounts[index].Credential = credential
			set.Accounts[index].NeedsReauth = false
			set.ActiveAccountID = accountID
			store[provider] = set
			return nil
		}
		set.Accounts = append(set.Accounts, ProviderAccount{ID: accountID, Credential: credential, AddedAt: s.now().UnixMilli()})
		set.ActiveAccountID = accountID
		store[provider] = set
		return nil
	})
}

// SaveAccountCredential updates one stable account slot without changing the
// provider's active account selection.
func (s *CredentialStore) SaveAccountCredential(
	ctx context.Context,
	provider string,
	accountID string,
	credential OAuthCredentials,
) error {
	if !validCredential(credential) {
		return errors.New("valid OAuth credential is required")
	}
	return s.mutate(ctx, func(store AuthStore) error {
		set, ok := store[provider]
		if !ok {
			return ErrLoginRequired
		}
		for i := range set.Accounts {
			if set.Accounts[i].ID == accountID {
				set.Accounts[i].Credential = credential
				set.Accounts[i].NeedsReauth = false
				store[provider] = set
				return nil
			}
		}
		return ErrLoginRequired
	})
}

func (s *CredentialStore) RemoveAccount(ctx context.Context, provider, accountID string) (bool, error) {
	removed := false
	err := s.mutate(ctx, func(store AuthStore) error {
		set, ok := store[provider]
		if !ok {
			return nil
		}
		accounts := make([]ProviderAccount, 0, len(set.Accounts))
		for _, account := range set.Accounts {
			if account.ID == accountID {
				removed = true
				continue
			}
			accounts = append(accounts, account)
		}
		if !removed {
			return nil
		}
		if len(accounts) == 0 {
			delete(store, provider)
			return nil
		}
		set.Accounts = accounts
		if set.ActiveAccountID == accountID {
			set.ActiveAccountID = accounts[0].ID
		}
		store[provider] = set
		return nil
	})
	return removed, err
}

func (s *CredentialStore) RemoveCredential(ctx context.Context, provider string) (bool, error) {
	set, ok, err := s.GetAccountSet(provider)
	if err != nil || !ok {
		return false, err
	}
	return s.RemoveAccount(ctx, provider, set.ActiveAccountID)
}
