package config

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"time"
)

type APIKeyInfo struct {
	ID      string `json:"id"`
	Label   string `json:"label,omitempty"`
	Masked  string `json:"masked"`
	Active  bool   `json:"active"`
	AddedAt int64  `json:"addedAt,omitempty"`
}

func IsKeyAuthProvider(provider ProviderConfig) bool {
	return provider.AuthMode != "oauth" && provider.AuthMode != "forward"
}

func APIKeyID(key string) string {
	digest := sha256.Sum256([]byte(key))
	return hex.EncodeToString(digest[:4])
}

func MaskAPIKey(key string) string {
	if strings.HasPrefix(key, "$") && !strings.ContainsAny(key, " \t\r\n") {
		return key
	}
	if len(key) <= 8 {
		return "****"
	}
	return key[:4] + "****" + key[len(key)-4:]
}

func ensureAPIKeyPool(provider *ProviderConfig) {
	if len(provider.APIKeyPool) == 0 && provider.APIKey != "" {
		provider.APIKeyPool = []APIKeyEntry{{ID: APIKeyID(provider.APIKey), Key: provider.APIKey}}
	}
}

func ListAPIKeys(cfg *Config, name string) (string, []APIKeyInfo) {
	provider, ok := cfg.Providers[name]
	if !ok || !IsKeyAuthProvider(provider) {
		return "", nil
	}
	ensureAPIKeyPool(&provider)
	cfg.Providers[name] = provider
	activeID := ""
	for _, entry := range provider.APIKeyPool {
		if entry.Key == provider.APIKey {
			activeID = entry.ID
			break
		}
	}
	if activeID == "" && len(provider.APIKeyPool) > 0 {
		activeID = provider.APIKeyPool[0].ID
	}
	infos := make([]APIKeyInfo, 0, len(provider.APIKeyPool))
	for _, entry := range provider.APIKeyPool {
		infos = append(infos, APIKeyInfo{ID: entry.ID, Label: entry.Label, Masked: MaskAPIKey(entry.Key), Active: entry.ID == activeID, AddedAt: entry.AddedAt})
	}
	return activeID, infos
}

func AddAPIKey(cfg *Config, name, key, label string, now time.Time) (string, error) {
	provider, ok := cfg.Providers[name]
	if !ok || !IsKeyAuthProvider(provider) {
		return "", &ConfigError{Field: "providers." + name, Message: "provider does not use API-key auth"}
	}
	key, label = strings.TrimSpace(key), strings.TrimSpace(label)
	if key == "" || strings.ContainsAny(key, "\r\n") {
		return "", &ConfigError{Field: "providers." + name + ".apiKeyPool", Message: "key is required and must not include line breaks"}
	}
	ensureAPIKeyPool(&provider)
	id := APIKeyID(key)
	found := false
	for index := range provider.APIKeyPool {
		if provider.APIKeyPool[index].ID == id {
			if label != "" {
				provider.APIKeyPool[index].Label = label
			}
			found = true
		}
	}
	if !found {
		provider.APIKeyPool = append(provider.APIKeyPool, APIKeyEntry{ID: id, Key: key, Label: label, AddedAt: now.UnixMilli()})
	}
	provider.APIKey = key
	cfg.Providers[name] = provider
	return id, cfg.Validate()
}

func SetActiveAPIKey(cfg *Config, name, id string) bool {
	provider, ok := cfg.Providers[name]
	if !ok || !IsKeyAuthProvider(provider) {
		return false
	}
	ensureAPIKeyPool(&provider)
	for _, entry := range provider.APIKeyPool {
		if entry.ID == id {
			provider.APIKey = entry.Key
			cfg.Providers[name] = provider
			return true
		}
	}
	return false
}

func SetAPIKeyLabel(cfg *Config, name, id, label string) bool {
	provider, ok := cfg.Providers[name]
	if !ok || !IsKeyAuthProvider(provider) {
		return false
	}
	ensureAPIKeyPool(&provider)
	for index := range provider.APIKeyPool {
		if provider.APIKeyPool[index].ID == id {
			provider.APIKeyPool[index].Label = strings.TrimSpace(label)
			cfg.Providers[name] = provider
			return true
		}
	}
	return false
}

func RemoveAPIKey(cfg *Config, name, id string) bool {
	provider, ok := cfg.Providers[name]
	if !ok || !IsKeyAuthProvider(provider) {
		return false
	}
	ensureAPIKeyPool(&provider)
	for index, entry := range provider.APIKeyPool {
		if entry.ID != id {
			continue
		}
		provider.APIKeyPool = append(provider.APIKeyPool[:index], provider.APIKeyPool[index+1:]...)
		if provider.APIKey == entry.Key {
			provider.APIKey = ""
			if len(provider.APIKeyPool) > 0 {
				provider.APIKey = provider.APIKeyPool[0].Key
			}
		}
		if len(provider.APIKeyPool) == 0 {
			provider.APIKeyPool = nil
		}
		cfg.Providers[name] = provider
		return true
	}
	return false
}
