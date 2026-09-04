package codex

import (
	"sync"
	"time"
)

const (
	DefaultModelCacheTTL       = 5 * time.Minute
	ModelsFetchFailureCooldown = 30 * time.Second
)

// CatalogModel is the common catalog identity cached by live provider discovery.
type CatalogModel struct {
	ID          string         `json:"id"`
	Provider    string         `json:"provider"`
	Alias       string         `json:"alias,omitempty"`
	DisplayName string         `json:"displayName,omitempty"`
	OwnedBy     string         `json:"owned_by,omitempty"`
	Metadata    map[string]any `json:"metadata,omitempty"`
}

type ProviderModelDiscoveryFailureReason string

const (
	DiscoveryFailureHTTP            ProviderModelDiscoveryFailureReason = "http"
	DiscoveryFailureBlocked         ProviderModelDiscoveryFailureReason = "blocked"
	DiscoveryFailureInvalidResponse ProviderModelDiscoveryFailureReason = "invalid_response"
	DiscoveryFailureNetwork         ProviderModelDiscoveryFailureReason = "network"
	DiscoveryFailureProvider        ProviderModelDiscoveryFailureReason = "provider"
)

type ProviderModelDiscoveryStatus struct {
	Status     string
	Reason     ProviderModelDiscoveryFailureReason
	HTTPStatus int
}

type modelCacheEntry struct {
	models    []CatalogModel
	fetchedAt time.Time
}

type ModelCache struct {
	mu        sync.RWMutex
	cache     map[string]modelCacheEntry
	failureAt map[string]time.Time
	status    map[string]ProviderModelDiscoveryStatus
}

func NewModelCache() *ModelCache {
	return &ModelCache{
		cache:     make(map[string]modelCacheEntry),
		failureAt: make(map[string]time.Time),
		status:    make(map[string]ProviderModelDiscoveryStatus),
	}
}

func (c *ModelCache) MarkModelsFetchFailure(provider string, now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.failureAt[provider] = now
}

func (c *ModelCache) MarkProviderDiscoveryOK(provider string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.status[provider] = ProviderModelDiscoveryStatus{Status: "ok"}
}

func (c *ModelCache) MarkProviderDiscoveryFailed(provider string, reason ProviderModelDiscoveryFailureReason, httpStatus int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.status[provider] = ProviderModelDiscoveryStatus{Status: "failed", Reason: reason, HTTPStatus: httpStatus}
}

func (c *ModelCache) ShouldLogDiscoveryFailure(provider string, reason ProviderModelDiscoveryFailureReason, httpStatus int) bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	previous, ok := c.status[provider]
	if !ok || previous.Status != "failed" || previous.Reason != reason {
		return true
	}
	return reason == DiscoveryFailureHTTP && previous.HTTPStatus != httpStatus
}

func (c *ModelCache) ProviderDiscoveryStatus(provider string) (ProviderModelDiscoveryStatus, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	status, ok := c.status[provider]
	return status, ok
}

func (c *ModelCache) IsModelsFetchCoolingDown(provider string, cooldown time.Duration, now time.Time) bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	at, ok := c.failureAt[provider]
	return ok && now.Sub(at) < cooldown
}

func (c *ModelCache) Fresh(provider string, ttl time.Duration, now time.Time) ([]CatalogModel, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	entry, ok := c.cache[provider]
	if !ok || now.Sub(entry.fetchedAt) >= ttl {
		return nil, false
	}
	return cloneCatalogModels(entry.models), true
}

func (c *ModelCache) Stale(provider string) ([]CatalogModel, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	entry, ok := c.cache[provider]
	if !ok {
		return nil, false
	}
	return cloneCatalogModels(entry.models), true
}

func (c *ModelCache) Set(provider string, models []CatalogModel, now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.cache[provider] = modelCacheEntry{models: cloneCatalogModels(models), fetchedAt: now}
}

func (c *ModelCache) Clear(provider string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if provider == "" {
		clear(c.cache)
		clear(c.failureAt)
		clear(c.status)
		return
	}
	delete(c.cache, provider)
	delete(c.failureAt, provider)
	delete(c.status, provider)
}

func cloneCatalogModels(models []CatalogModel) []CatalogModel {
	copyModels := make([]CatalogModel, len(models))
	for i, model := range models {
		copyModels[i] = model
		if model.Metadata != nil {
			copyModels[i].Metadata = make(map[string]any, len(model.Metadata))
			for key, value := range model.Metadata {
				copyModels[i].Metadata[key] = value
			}
		}
	}
	return copyModels
}
