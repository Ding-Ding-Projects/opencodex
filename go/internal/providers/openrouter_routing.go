package providers

import (
	"fmt"
	"net/url"
	"strings"
)

const maxProviderSlugs = 64

func IsCanonicalOpenRouterTarget(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Host != "openrouter.ai" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return false
	}
	return strings.TrimRight(u.Path, "/") == "/api/v1"
}
func routingPreferenceError(p OpenRouterProviderRouting, field string) error {
	for name, list := range map[string][]string{"order": p.Order, "only": p.Only} {
		if list == nil {
			continue
		}
		if len(list) == 0 || len(list) > maxProviderSlugs {
			return fmt.Errorf("%s.%s must contain 1-%d provider slugs", field, name, maxProviderSlugs)
		}
		seen := map[string]bool{}
		for _, slug := range list {
			if strings.TrimSpace(slug) == "" || strings.TrimSpace(slug) != slug || len(slug) > 128 {
				return fmt.Errorf("%s.%s must contain nonblank trimmed provider slugs up to 128 characters", field, name)
			}
			if seen[slug] {
				return fmt.Errorf("%s.%s must not contain duplicate provider slugs", field, name)
			}
			seen[slug] = true
		}
	}
	if p.Order == nil && p.Only == nil && p.AllowFallbacks == nil {
		return fmt.Errorf("%s must define order, only, or allowFallbacks", field)
	}
	return nil
}
func OpenRouterRoutingConfigError(p ProviderConfig) error {
	hasDefault := p.OpenRouterRouting != nil
	hasModels := p.ModelOpenRouterRouting != nil
	if !hasDefault && !hasModels {
		return nil
	}
	if p.Adapter != "openai-chat" {
		return fmt.Errorf("OpenRouter routing preferences require the openai-chat adapter")
	}
	if !IsCanonicalOpenRouterTarget(p.BaseURL) {
		return fmt.Errorf("OpenRouter routing preferences require the canonical https://openrouter.ai/api/v1 baseUrl")
	}
	if hasDefault {
		if err := routingPreferenceError(*p.OpenRouterRouting, "openRouterRouting"); err != nil {
			return err
		}
	}
	for id, pref := range p.ModelOpenRouterRouting {
		if strings.TrimSpace(id) == "" || strings.TrimSpace(id) != id {
			return fmt.Errorf("modelOpenRouterRouting keys must be nonblank trimmed model ids")
		}
		if err := routingPreferenceError(pref, "modelOpenRouterRouting."+id); err != nil {
			return err
		}
	}
	return nil
}
func ResolveOpenRouterRouting(p ProviderConfig, model string) (OpenRouterProviderRouting, bool) {
	if !IsCanonicalOpenRouterTarget(p.BaseURL) {
		return OpenRouterProviderRouting{}, false
	}
	if v, ok := p.ModelOpenRouterRouting[model]; ok {
		return cloneRouting(v), true
	}
	if p.OpenRouterRouting == nil {
		return OpenRouterProviderRouting{}, false
	}
	return cloneRouting(*p.OpenRouterRouting), true
}
func OpenRouterProviderPayload(p OpenRouterProviderRouting) map[string]any {
	out := map[string]any{}
	if p.Order != nil {
		out["order"] = cloneStrings(p.Order)
	}
	if p.Only != nil {
		out["only"] = cloneStrings(p.Only)
	}
	if p.AllowFallbacks != nil {
		out["allow_fallbacks"] = *p.AllowFallbacks
	}
	return out
}
func cloneRouting(p OpenRouterProviderRouting) OpenRouterProviderRouting {
	p.Order, p.Only = cloneStrings(p.Order), cloneStrings(p.Only)
	if p.AllowFallbacks != nil {
		v := *p.AllowFallbacks
		p.AllowFallbacks = &v
	}
	return p
}
