package codex

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/config"
)

const maxProviderModelsResponseBytes = 8 << 20

type ProviderModelsAPIItem struct {
	ID            string `json:"id"`
	OwnedBy       string `json:"owned_by,omitempty"`
	ContextLength int    `json:"context_length,omitempty"`
	MaxModelLen   int    `json:"max_model_len,omitempty"`
	Metadata      struct {
		Capabilities map[string]any `json:"capabilities,omitempty"`
		Limits       map[string]any `json:"limits,omitempty"`
	} `json:"metadata,omitempty"`
}

type ProviderModelFetchOptions struct {
	ProviderName string
	Provider     config.ProviderConfig
	AccessToken  string
	Cache        *ModelCache
	Client       *http.Client
	TTL          time.Duration
	Now          func() time.Time
}

// FetchProviderModels fetches an OpenAI-compatible /models document and degrades
// to stale or configured models on failure. Secrets never enter returned errors.
func FetchProviderModels(ctx context.Context, options ProviderModelFetchOptions) ([]CatalogModel, error) {
	if options.Cache == nil {
		options.Cache = NewModelCache()
	}
	if options.Client == nil {
		options.Client = &http.Client{Timeout: 8 * time.Second}
	}
	if options.TTL <= 0 {
		options.TTL = DefaultModelCacheTTL
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	now := options.Now()
	configured := configuredCatalogModels(options.ProviderName, options.Provider)
	if options.Provider.AuthMode == "forward" || options.Provider.Disabled {
		return configured, nil
	}
	if fresh, ok := options.Cache.Fresh(options.ProviderName, options.TTL, now); ok {
		return fresh, nil
	}
	if options.Cache.IsModelsFetchCoolingDown(options.ProviderName, ModelsFetchFailureCooldown, now) {
		if stale, ok := options.Cache.Stale(options.ProviderName); ok {
			return stale, nil
		}
		return configured, nil
	}
	modelsURL, err := providerModelsURL(options.Provider.BaseURL)
	if err != nil {
		return providerFetchFallback(options, configured, DiscoveryFailureBlocked, 0, err)
	}
	if !options.Provider.AllowPrivateNetwork {
		if err := rejectPrivateDestination(ctx, modelsURL); err != nil {
			return providerFetchFallback(options, configured, DiscoveryFailureBlocked, 0, err)
		}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, modelsURL.String(), nil)
	if err != nil {
		return providerFetchFallback(options, configured, DiscoveryFailureNetwork, 0, err)
	}
	req.Header.Set("Accept", "application/json")
	for name, value := range options.Provider.Headers {
		req.Header.Set(name, value)
	}
	if token := strings.TrimSpace(options.AccessToken); token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	response, err := options.Client.Do(req)
	if err != nil {
		return providerFetchFallback(options, configured, DiscoveryFailureNetwork, 0, errors.New("provider models request failed"))
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return providerFetchFallback(options, configured, DiscoveryFailureHTTP, response.StatusCode, fmt.Errorf("provider models returned HTTP %d", response.StatusCode))
	}
	limited := io.LimitReader(response.Body, maxProviderModelsResponseBytes+1)
	body, err := io.ReadAll(limited)
	if err != nil || len(body) > maxProviderModelsResponseBytes {
		return providerFetchFallback(options, configured, DiscoveryFailureInvalidResponse, 0, errors.New("provider models response is invalid"))
	}
	var payload struct {
		Data []ProviderModelsAPIItem `json:"data"`
	}
	decoder := json.NewDecoder(strings.NewReader(string(body)))
	if err := decoder.Decode(&payload); err != nil || decoder.Decode(&struct{}{}) != io.EOF {
		return providerFetchFallback(options, configured, DiscoveryFailureInvalidResponse, 0, errors.New("provider models response is invalid"))
	}
	live := make([]CatalogModel, 0, len(payload.Data)+len(configured))
	seen := make(map[string]bool, len(payload.Data))
	for _, item := range payload.Data {
		item.ID = strings.TrimSpace(item.ID)
		if item.ID == "" || seen[item.ID] {
			continue
		}
		seen[item.ID] = true
		live = append(live, catalogModelFromAPIItem(options.ProviderName, item, options.Provider))
	}
	for _, model := range configured {
		if seen[model.ID] {
			continue
		}
		if dated := datedCatalogAlias(live, model.ID); dated != nil {
			alias := *dated
			alias.ID = model.ID
			live = append(live, alias)
			seen[model.ID] = true
		}
	}
	options.Cache.MarkProviderDiscoveryOK(options.ProviderName)
	options.Cache.Set(options.ProviderName, live, now)
	return cloneCatalogModels(live), nil
}

func configuredCatalogModels(providerName string, provider config.ProviderConfig) []CatalogModel {
	models := make([]CatalogModel, 0, len(provider.Models)+1)
	seen := map[string]bool{}
	for _, id := range provider.Models {
		id = strings.TrimSpace(id)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		models = append(models, CatalogModel{ID: id, Provider: providerName})
	}
	if provider.Adapter == "anthropic" && provider.DefaultModel != "" && len(models) == 0 {
		models = append(models, CatalogModel{ID: provider.DefaultModel, Provider: providerName})
	}
	return models
}

func catalogModelFromAPIItem(providerName string, item ProviderModelsAPIItem, provider config.ProviderConfig) CatalogModel {
	metadata := map[string]any{}
	contextWindow := item.ContextLength
	if contextWindow <= 0 {
		contextWindow = item.MaxModelLen
	}
	if limit, ok := positiveJSONNumber(item.Metadata.Limits["max_context_length"]); ok {
		contextWindow = limit
	}
	if configured := provider.ModelContextWindows[item.ID]; configured > 0 && (contextWindow == 0 || configured < contextWindow) {
		contextWindow = configured
	}
	if contextWindow > 0 {
		metadata["context_window"] = contextWindow
	}
	if vision, ok := item.Metadata.Capabilities["vision"].(bool); ok {
		if vision {
			metadata["input_modalities"] = []string{"text", "image"}
		} else {
			metadata["input_modalities"] = []string{"text"}
		}
	}
	if efforts := provider.ModelReasoningEfforts[item.ID]; len(efforts) > 0 {
		metadata["reasoning_efforts"] = append([]string(nil), efforts...)
	} else if reasoning, ok := item.Metadata.Capabilities["reasoning_effort"].(bool); ok {
		if reasoning {
			metadata["reasoning_efforts"] = []string{"low", "medium", "high", "xhigh"}
		} else {
			metadata["reasoning_efforts"] = []string{}
		}
	}
	if len(metadata) == 0 {
		metadata = nil
	}
	return CatalogModel{ID: item.ID, Provider: providerName, OwnedBy: item.OwnedBy, Metadata: metadata}
}

func providerFetchFallback(options ProviderModelFetchOptions, configured []CatalogModel, reason ProviderModelDiscoveryFailureReason, status int, cause error) ([]CatalogModel, error) {
	now := options.Now()
	options.Cache.MarkModelsFetchFailure(options.ProviderName, now)
	options.Cache.MarkProviderDiscoveryFailed(options.ProviderName, reason, status)
	if stale, ok := options.Cache.Stale(options.ProviderName); ok {
		return stale, cause
	}
	return configured, cause
}

func providerModelsURL(base string) (*url.URL, error) {
	parsed, err := url.Parse(strings.TrimSpace(base))
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil {
		return nil, errors.New("provider base URL is invalid")
	}
	parsed.RawQuery, parsed.Fragment = "", ""
	if !strings.HasSuffix(strings.TrimRight(parsed.Path, "/"), "/models") {
		parsed.Path = strings.TrimRight(parsed.Path, "/") + "/models"
	}
	return parsed, nil
}

func rejectPrivateDestination(ctx context.Context, destination *url.URL) error {
	host := strings.ToLower(destination.Hostname())
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return errors.New("provider models destination is private")
	}
	addresses, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return errors.New("provider models destination could not be resolved")
	}
	for _, address := range addresses {
		if address.IP.IsLoopback() || address.IP.IsPrivate() || address.IP.IsLinkLocalUnicast() || address.IP.IsUnspecified() {
			return errors.New("provider models destination is private")
		}
	}
	return nil
}

func positiveJSONNumber(value any) (int, bool) {
	switch number := value.(type) {
	case float64:
		return int(number), number > 0
	case int:
		return number, number > 0
	default:
		return 0, false
	}
}

func datedCatalogAlias(models []CatalogModel, configuredID string) *CatalogModel {
	prefix := configuredID + "-"
	for i := range models {
		if !strings.HasPrefix(models[i].ID, prefix) {
			continue
		}
		suffix := strings.TrimPrefix(models[i].ID, prefix)
		if len(suffix) == 8 && strings.Trim(suffix, "0123456789") == "" {
			return &models[i]
		}
	}
	return nil
}
