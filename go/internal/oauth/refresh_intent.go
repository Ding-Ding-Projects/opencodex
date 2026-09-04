package oauth

import (
	"encoding/json"
	"os"
	"path/filepath"
)

type RefreshIntent struct {
	Version    int    `json:"version"`
	Provider   string `json:"provider"`
	AccountID  string `json:"accountId"`
	Generation string `json:"generation"`
	CreatedAt  int64  `json:"createdAt"`
	Uncertain  bool   `json:"uncertain,omitempty"`
}

func (s *CredentialStore) RefreshIntentPath(provider, accountID string) string {
	return s.refreshLockPath(provider, accountID) + ".json"
}

func (s *CredentialStore) ReadRefreshIntent(provider, accountID string) (RefreshIntent, bool) {
	data, err := os.ReadFile(s.RefreshIntentPath(provider, accountID))
	if os.IsNotExist(err) {
		return RefreshIntent{}, false
	}
	var intent RefreshIntent
	if err != nil || json.Unmarshal(data, &intent) != nil || intent.Version != 1 || intent.Provider != provider || intent.AccountID != accountID || intent.Generation == "" {
		return RefreshIntent{Version: 1, Provider: provider, AccountID: accountID, Uncertain: true}, true
	}
	return intent, true
}

func (s *CredentialStore) WriteRefreshIntent(provider, accountID, generation string) error {
	intent := RefreshIntent{Version: 1, Provider: provider, AccountID: accountID, Generation: generation, CreatedAt: s.now().UnixMilli()}
	data, err := json.Marshal(intent)
	if err != nil {
		return err
	}
	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	temp, err := os.CreateTemp(dir, ".refresh-intent-*.tmp")
	if err != nil {
		return err
	}
	name := temp.Name()
	defer os.Remove(name)
	if err := temp.Chmod(0o600); err != nil {
		temp.Close()
		return err
	}
	if _, err := temp.Write(append(data, '\n')); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	return atomicReplace(name, s.RefreshIntentPath(provider, accountID))
}

func (s *CredentialStore) ClearRefreshIntent(provider, accountID, generation string) (bool, error) {
	intent, ok := s.ReadRefreshIntent(provider, accountID)
	if !ok || intent.Generation != generation {
		return false, nil
	}
	err := os.Remove(s.RefreshIntentPath(provider, accountID))
	if os.IsNotExist(err) {
		return false, nil
	}
	return err == nil, err
}
