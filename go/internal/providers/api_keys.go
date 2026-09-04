package providers

import (
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"strings"
)

var envKeyReference = regexp.MustCompile(`^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$`)

type APIKeyInfo struct {
	ID, Label, Masked string
	Active            bool
	AddedAt           int64
}

func MaskAPIKey(value string) string {
	if envKeyReference.MatchString(value) {
		return value
	}
	if len(value) <= 8 {
		return "****"
	}
	return value[:4] + "****" + value[len(value)-4:]
}

func IsKeyAuthProvider(provider ProviderConfig) bool {
	return provider.AuthMode != "oauth" && provider.AuthMode != "forward"
}

func APIKeyID(key string) string {
	sum := sha256.Sum256([]byte(key))
	return hex.EncodeToString(sum[:4])
}

func EnsureAPIKeyPool(provider *ProviderConfig) []APIKeyEntry {
	if provider == nil {
		return nil
	}
	if len(provider.APIKeyPool) == 0 && provider.APIKey != "" {
		provider.APIKeyPool = []APIKeyEntry{{ID: APIKeyID(provider.APIKey), Key: provider.APIKey}}
	}
	return provider.APIKeyPool
}

func ListAPIKeys(provider *ProviderConfig) (string, []APIKeyInfo) {
	if provider == nil || !IsKeyAuthProvider(*provider) {
		return "", nil
	}
	pool := EnsureAPIKeyPool(provider)
	active := ""
	for _, entry := range pool {
		if entry.Key == provider.APIKey {
			active = entry.ID
			break
		}
	}
	if active == "" && len(pool) > 0 {
		active = pool[0].ID
	}
	out := make([]APIKeyInfo, 0, len(pool))
	for _, entry := range pool {
		out = append(out, APIKeyInfo{ID: entry.ID, Label: entry.Label, Masked: MaskAPIKey(entry.Key), Active: entry.ID == active})
	}
	return active, out
}

func AddAPIKey(provider *ProviderConfig, key, label string) (string, bool) {
	if provider == nil || !IsKeyAuthProvider(*provider) {
		return "", false
	}
	key = strings.TrimSpace(key)
	label = strings.TrimSpace(label)
	if key == "" || strings.ContainsAny(key, "\r\n") {
		return "", false
	}
	pool := EnsureAPIKeyPool(provider)
	id := APIKeyID(key)
	found := false
	for i := range pool {
		if pool[i].ID == id {
			if label != "" {
				pool[i].Label = label
			}
			found = true
			break
		}
	}
	if !found {
		pool = append(pool, APIKeyEntry{ID: id, Key: key, Label: label})
	}
	provider.APIKeyPool = pool
	provider.APIKey = key
	return id, true
}

func RemoveAPIKey(provider *ProviderConfig, id string) bool {
	if provider == nil || !IsKeyAuthProvider(*provider) {
		return false
	}
	pool := EnsureAPIKeyPool(provider)
	for i, e := range pool {
		if e.ID != id {
			continue
		}
		wasActive := e.Key == provider.APIKey
		provider.APIKeyPool = append(pool[:i:i], pool[i+1:]...)
		if wasActive {
			provider.APIKey = ""
			if len(provider.APIKeyPool) > 0 {
				provider.APIKey = provider.APIKeyPool[0].Key
			}
		}
		return true
	}
	return false
}

func NewAPIKeyEntry(key, label string) APIKeyEntry {
	return APIKeyEntry{ID: APIKeyID(key), Key: key, Label: label}
}
