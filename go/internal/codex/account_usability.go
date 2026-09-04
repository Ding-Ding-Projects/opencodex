package codex

import "time"

const MainCodexAccountID = "__main__"

// MainAccountToken is read from the Codex CLI auth file and is never refreshed by the pool.
type MainAccountToken struct {
	AccessToken      string
	ChatGPTAccountID string
	ExpiresAt        time.Time
}

func (t MainAccountToken) Live(now time.Time) bool {
	return t.AccessToken != "" && (t.ExpiresAt.IsZero() || t.ExpiresAt.After(now))
}

type AccountUsability struct {
	Store       *AccountStore
	MainToken   func() (MainAccountToken, bool)
	NeedsReauth func(string) bool
	Now         func() time.Time
}

func (u AccountUsability) IsCodexAccountUsable(config *RoutingConfig, accountID string) bool {
	now := time.Now()
	if u.Now != nil {
		now = u.Now()
	}
	needsReauth := u.NeedsReauth != nil && u.NeedsReauth(accountID)
	if accountID == MainCodexAccountID {
		if needsReauth || u.MainToken == nil {
			return false
		}
		token, ok := u.MainToken()
		return ok && token.Live(now)
	}
	configured := false
	if config != nil {
		for _, account := range config.CodexAccounts {
			if !account.IsMain && account.ID == accountID {
				configured = true
				break
			}
		}
	}
	if !configured || needsReauth || u.Store == nil {
		return false
	}
	_, live, err := u.Store.GetCredential(accountID)
	return err == nil && live
}
