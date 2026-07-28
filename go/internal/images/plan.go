package images

// Image-bridge activation, ported from src/images/plan.ts.
//
// Every condition here is a gate on PAID upstream calls, so the default answer
// is no: the bridge arms only when the operator opted in, the request actually
// declared a hosted image tool, the route is not OpenAI native, and an xAI
// provider with a usable API key exists.

import (
	"math"
	"net/url"
	"sort"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/config"
)

// DefaultBridgeModel is the xAI image model used when none is configured.
const DefaultBridgeModel = "grok-imagine-image-quality"

// MaxImageTimeoutMS is the absolute ceiling for images.timeoutMs, matching the
// /v1/images relay budget.
const MaxImageTimeoutMS = 300_000

// XaiImageBaseURL is the PINNED endpoint for image fulfilment.
//
// Deliberately not taken from provider config: a config-level baseUrl override
// must not be able to redirect an authenticated image call somewhere else.
const XaiImageBaseURL = "https://api.x.ai/v1"

// BridgeAuth is the pinned endpoint plus the bearer token for fulfilment.
type BridgeAuth struct {
	BaseURL string
	Token   string
}

// Plan is a fully-resolved decision to run the bridge.
type Plan struct {
	ProviderName       string
	Auth               BridgeAuth
	Model              string
	ToolNames          []string
	DefaultSize        string
	DefaultQuality     string
	TimeoutMS          int
	ArtifactsKeepCount int
	// HasArtifactsKeepCount separates an explicit 0 from an absent value, since
	// zero is a real setting.
	HasArtifactsKeepCount bool
}

// FindXaiProvider locates a usable xAI provider.
//
// The well-known name wins; otherwise the hostname is matched, so a
// custom-named config still counts. A disabled provider never does.
func FindXaiProvider(cfg *config.Config) (string, config.ProviderConfig, bool) {
	if cfg == nil {
		return "", config.ProviderConfig{}, false
	}
	if provider, found := cfg.Providers["xai"]; found && !provider.Disabled {
		return "xai", provider, true
	}
	// Map iteration is random, so the candidates are sorted to keep the choice
	// deterministic when several configs point at the same host.
	for _, name := range sortedProviderNames(cfg) {
		provider := cfg.Providers[name]
		if provider.Disabled {
			continue
		}
		parsed, err := url.Parse(provider.BaseURL)
		if err != nil {
			continue
		}
		if host := parsed.Hostname(); host == "api.x.ai" || host == "cli-chat-proxy.grok.com" {
			return name, provider, true
		}
	}
	return "", config.ProviderConfig{}, false
}

func sortedProviderNames(cfg *config.Config) []string {
	names := make([]string, 0, len(cfg.Providers))
	for name := range cfg.Providers {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// ResolveXaiImageAPIKey returns the bearer token for the Images API.
//
// An OAuth-only provider deliberately yields nothing: that transport is
// chat-oriented and is not a supported Images transport, so arming the bridge
// with it would send a credential somewhere it does not belong.
func ResolveXaiImageAPIKey(provider config.ProviderConfig) string {
	if provider.AuthMode == "oauth" {
		return ""
	}
	return strings.TrimSpace(config.ResolveEnvValue(provider.APIKey))
}

// PlanImageBridge decides whether to run the bridge for one request.
func PlanImageBridge(cfg *config.Config, hosted HostedImageGeneration, hostedFound bool, routed config.ProviderConfig) (Plan, bool) {
	if cfg == nil || cfg.Images == nil || cfg.Images.BridgeEnabled == nil || !*cfg.Images.BridgeEnabled {
		return Plan{}, false
	}
	if !hostedFound {
		return Plan{}, false
	}
	// OpenAI native passthrough keeps its own hosted image tool; intercepting
	// there would replace a working feature with a worse one.
	if parsed, err := url.Parse(routed.BaseURL); err == nil && parsed.Hostname() == "api.openai.com" {
		return Plan{}, false
	}
	name, provider, found := FindXaiProvider(cfg)
	if !found {
		return Plan{}, false
	}
	token := ResolveXaiImageAPIKey(provider)
	if token == "" {
		return Plan{}, false
	}

	// The synthetic tool is what the model actually calls, so its name joins
	// the declared ones.
	names := append([]string(nil), hosted.ToolNames...)
	if !containsName(names, ImageGenToolName) {
		names = append(names, ImageGenToolName)
	}

	plan := Plan{
		ProviderName: name,
		Auth:         BridgeAuth{BaseURL: strings.TrimRight(XaiImageBaseURL, "/"), Token: token},
		Model:        DefaultBridgeModel,
		ToolNames:    names,
	}
	if configured := strings.TrimSpace(cfg.Images.BridgeModel); configured != "" {
		plan.Model = configured
	}
	if size, ok := hosted.OriginalTool["size"].(string); ok {
		plan.DefaultSize = size
	}
	if quality, ok := hosted.OriginalTool["quality"].(string); ok {
		plan.DefaultQuality = quality
	}
	plan.TimeoutMS = clampImageTimeoutMS(cfg.Images.TimeoutMS)
	if keep := cfg.Images.ArtifactsKeepCount; keep != nil && !math.IsNaN(*keep) && !math.IsInf(*keep, 0) {
		// Floored, not rounded, and a negative value is kept: the oracle only
		// checks that the number is finite.
		plan.ArtifactsKeepCount = int(math.Floor(*keep))
		plan.HasArtifactsKeepCount = true
	}
	return plan, true
}

// clampImageTimeoutMS floors to whole milliseconds and caps at the relay
// budget.
//
// A non-positive or non-finite value means UNSET rather than instant, and the
// floor is raised to 1 so a fractional value cannot collapse to no timeout at
// all: measured, the oracle turns 0.5 into 1.
func clampImageTimeoutMS(value float64) int {
	if math.IsNaN(value) || math.IsInf(value, 0) || value <= 0 {
		return 0
	}
	floored := math.Floor(value)
	if floored < 1 {
		floored = 1
	}
	return int(math.Min(floored, float64(MaxImageTimeoutMS)))
}

func containsName(names []string, wanted string) bool {
	for _, name := range names {
		if name == wanted {
			return true
		}
	}
	return false
}
