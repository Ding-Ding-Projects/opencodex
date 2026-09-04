package providers

import (
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	DefaultKeyCooldown = time.Minute
	MaxKeyCooldown     = 10 * time.Minute
)

type KeyFailover struct {
	mu        sync.Mutex
	cooldowns map[string]time.Time
}

func NewKeyFailover() *KeyFailover { return &KeyFailover{cooldowns: map[string]time.Time{}} }
func HasKeyPoolFailover(p ProviderConfig) bool {
	return p.AuthMode != "oauth" && p.AuthMode != "forward" && len(p.APIKeyPool) >= 2
}
func cooldownKey(provider, id string) string { return provider + "\x00" + id }
func parseRetryAfter(value string, now time.Time) time.Duration {
	value = strings.TrimSpace(value)
	if seconds, err := strconv.ParseFloat(value, 64); err == nil && seconds > 0 {
		return clampCooldown(time.Duration(seconds * float64(time.Second)))
	}
	if when, err := http.ParseTime(value); err == nil && when.After(now) {
		return clampCooldown(when.Sub(now))
	}
	return DefaultKeyCooldown
}
func clampCooldown(v time.Duration) time.Duration {
	if v < time.Millisecond {
		return time.Millisecond
	}
	if v > MaxKeyCooldown {
		return MaxKeyCooldown
	}
	return v
}
func (f *KeyFailover) inCooldown(provider, id string, now time.Time) bool {
	k := cooldownKey(provider, id)
	until, ok := f.cooldowns[k]
	if !ok {
		return false
	}
	if !until.After(now) {
		delete(f.cooldowns, k)
		return false
	}
	return true
}

// RotateKeyOn429 mutates the active key in provider and returns a defensive copy.
func (f *KeyFailover) RotateKeyOn429(providerName string, p *ProviderConfig, retryAfter string, now time.Time, attemptedKey string) (ProviderConfig, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if p == nil || !HasKeyPoolFailover(*p) {
		return ProviderConfig{}, false
	}
	failed := p.APIKey
	if attemptedKey != "" {
		failed = attemptedKey
	}
	current := -1
	for i, e := range p.APIKeyPool {
		if e.Key == failed {
			current = i
			f.cooldowns[cooldownKey(providerName, e.ID)] = now.Add(parseRetryAfter(retryAfter, now))
			break
		}
	}
	if attemptedKey != "" && p.APIKey != attemptedKey {
		for _, e := range p.APIKeyPool {
			if e.Key == p.APIKey && !f.inCooldown(providerName, e.ID, now) {
				return cloneProviderConfig(*p), true
			}
		}
	}
	for step := 1; step < len(p.APIKeyPool); step++ {
		idx := (current + step + len(p.APIKeyPool)) % len(p.APIKeyPool)
		candidate := p.APIKeyPool[idx]
		if !f.inCooldown(providerName, candidate.ID, now) {
			p.APIKey = candidate.Key
			return cloneProviderConfig(*p), true
		}
	}
	return ProviderConfig{}, false
}
func (f *KeyFailover) Clear(provider string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if provider == "" {
		clear(f.cooldowns)
		return
	}
	prefix := provider + "\x00"
	for k := range f.cooldowns {
		if strings.HasPrefix(k, prefix) {
			delete(f.cooldowns, k)
		}
	}
}
func (f *KeyFailover) CooldownUntil(provider, id string, now time.Time) (time.Time, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.inCooldown(provider, id, now) {
		return time.Time{}, false
	}
	return f.cooldowns[cooldownKey(provider, id)], true
}
func cloneProviderConfig(p ProviderConfig) ProviderConfig {
	p.APIKeyPool = append([]APIKeyEntry(nil), p.APIKeyPool...)
	p.Headers = cloneStringMap(p.Headers)
	p.Models = cloneStrings(p.Models)
	return p
}
