package images

// Differential against src/images/plan.ts. Every expectation was captured by
// RUNNING the oracle.

import (
	"sort"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/config"
)

func providerConfig(baseURL string) config.ProviderConfig {
	return config.ProviderConfig{BaseURL: baseURL}
}

// Oracle P1-P7: the well-known name wins, a hostname match covers a
// custom-named config, and a disabled provider never counts either way.
func TestFindXaiProviderMatchesTheOracle(t *testing.T) {
	for _, testCase := range []struct {
		name      string
		providers map[string]config.ProviderConfig
		want      string
	}{
		{"well-known name", map[string]config.ProviderConfig{"xai": providerConfig("https://api.x.ai/v1")}, "xai"},
		{"hostname match", map[string]config.ProviderConfig{"custom": providerConfig("https://api.x.ai/v1")}, "custom"},
		{"grok cli proxy", map[string]config.ProviderConfig{"c": providerConfig("https://cli-chat-proxy.grok.com/v1")}, "c"},
		{"unrelated host", map[string]config.ProviderConfig{"c": providerConfig("https://api.openai.com/v1")}, ""},
		{"unparseable url", map[string]config.ProviderConfig{"c": providerConfig("://not a url")}, ""},
	} {
		name, _, found := FindXaiProvider(&config.Config{Providers: testCase.providers})
		if testCase.want == "" {
			if found {
				t.Fatalf("%s matched %q, oracle finds nothing", testCase.name, name)
			}
			continue
		}
		if !found || name != testCase.want {
			t.Fatalf("%s = (%q, %v), oracle returns %q", testCase.name, name, found, testCase.want)
		}
	}

	// Disabled providers are skipped under BOTH match paths.
	disabled := config.ProviderConfig{BaseURL: "https://api.x.ai/v1", Disabled: true}
	if _, _, found := FindXaiProvider(&config.Config{Providers: map[string]config.ProviderConfig{"xai": disabled}}); found {
		t.Fatal("a disabled well-known provider was selected")
	}
	if _, _, found := FindXaiProvider(&config.Config{Providers: map[string]config.ProviderConfig{"c": disabled}}); found {
		t.Fatal("a disabled host-matched provider was selected")
	}
}

// Oracle K1-K5: an OAuth provider yields no token, because that transport is
// chat-oriented and not a supported Images transport.
func TestResolveXaiImageAPIKeyMatchesTheOracle(t *testing.T) {
	for _, testCase := range []struct {
		name     string
		provider config.ProviderConfig
		want     string
	}{
		{"oauth is refused", config.ProviderConfig{AuthMode: "oauth", APIKey: "sk-x"}, ""},
		{"api key", config.ProviderConfig{APIKey: "sk-x"}, "sk-x"},
		{"trimmed", config.ProviderConfig{APIKey: "  sk-y  "}, "sk-y"},
		{"blank", config.ProviderConfig{APIKey: "   "}, ""},
		{"missing", config.ProviderConfig{}, ""},
	} {
		if got := ResolveXaiImageAPIKey(testCase.provider); got != testCase.want {
			t.Fatalf("%s = %q, oracle returns %q", testCase.name, got, testCase.want)
		}
	}
}

func enabledImages(over func(*config.ImagesConfig)) *config.Config {
	enabled := true
	images := &config.ImagesConfig{BridgeEnabled: &enabled}
	if over != nil {
		over(images)
	}
	return &config.Config{
		Images: images,
		Providers: map[string]config.ProviderConfig{
			"xai": {BaseURL: "https://api.x.ai/v1", APIKey: "sk-key"},
		},
	}
}

func hostedImage(original map[string]any) HostedImageGeneration {
	return HostedImageGeneration{ToolNames: []string{"image_generation"}, OriginalTool: original}
}

var routedElsewhere = config.ProviderConfig{BaseURL: "https://api.anthropic.com"}

// Oracle B1: the happy path pins the endpoint, defaults the model, and merges
// the synthetic tool name with the declared one.
func TestPlanImageBridgeHappyPath(t *testing.T) {
	plan, ok := PlanImageBridge(enabledImages(nil), hostedImage(nil), true, routedElsewhere)
	if !ok {
		t.Fatal("the bridge did not arm")
	}
	if plan.Auth.BaseURL != "https://api.x.ai/v1" || plan.Auth.Token != "sk-key" {
		t.Fatalf("auth = %#v", plan.Auth)
	}
	if plan.Model != "grok-imagine-image-quality" {
		t.Fatalf("model = %q", plan.Model)
	}
	names := append([]string(nil), plan.ToolNames...)
	sort.Strings(names)
	if len(names) != 2 || names[0] != "image_gen" || names[1] != "image_generation" {
		t.Fatalf("tool names = %v, oracle returns [image_gen image_generation]", names)
	}
}

// Oracle B2-B5: every refusal path. These are gates on PAID calls, so each one
// failing open would cost the operator money they did not agree to.
func TestPlanImageBridgeRefusals(t *testing.T) {
	disabled := false
	offConfig := enabledImages(nil)
	offConfig.Images.BridgeEnabled = &disabled
	if _, ok := PlanImageBridge(offConfig, hostedImage(nil), true, routedElsewhere); ok {
		t.Fatal("the bridge armed while the opt-in was off")
	}
	if _, ok := PlanImageBridge(enabledImages(nil), HostedImageGeneration{}, false, routedElsewhere); ok {
		t.Fatal("the bridge armed without a hosted image tool")
	}
	openaiRoute := config.ProviderConfig{BaseURL: "https://api.openai.com/v1"}
	if _, ok := PlanImageBridge(enabledImages(nil), hostedImage(nil), true, openaiRoute); ok {
		t.Fatal("the bridge armed on the OpenAI native route")
	}
	oauthOnly := enabledImages(nil)
	oauthOnly.Providers["xai"] = config.ProviderConfig{BaseURL: "https://api.x.ai/v1", AuthMode: "oauth", APIKey: "sk"}
	if _, ok := PlanImageBridge(oauthOnly, hostedImage(nil), true, routedElsewhere); ok {
		t.Fatal("the bridge armed with an oauth-only provider")
	}
	noProvider := enabledImages(nil)
	noProvider.Providers = map[string]config.ProviderConfig{}
	if _, ok := PlanImageBridge(noProvider, hostedImage(nil), true, routedElsewhere); ok {
		t.Fatal("the bridge armed with no xAI provider")
	}
}

// Oracle B6, the security contract: a config-level baseUrl override must NOT
// redirect an authenticated image call.
func TestPlanImageBridgePinsTheEndpointAgainstConfigOverride(t *testing.T) {
	redirected := enabledImages(nil)
	redirected.Providers["xai"] = config.ProviderConfig{BaseURL: "https://evil.example/v1", APIKey: "sk"}
	plan, ok := PlanImageBridge(redirected, hostedImage(nil), true, routedElsewhere)
	if !ok {
		t.Fatal("the bridge did not arm")
	}
	if plan.Auth.BaseURL != "https://api.x.ai/v1" {
		t.Fatalf("base url = %q, the endpoint must stay pinned", plan.Auth.BaseURL)
	}
}

// Oracle B7-B11: hosted options carry through, the timeout clamps at the relay
// budget, a non-positive timeout means unset rather than instant, and a
// configured model wins.
func TestPlanImageBridgeCarriesOptions(t *testing.T) {
	withOptions, _ := PlanImageBridge(enabledImages(nil), hostedImage(map[string]any{"size": "1024x1024", "quality": "high"}), true, routedElsewhere)
	if withOptions.DefaultSize != "1024x1024" || withOptions.DefaultQuality != "high" {
		t.Fatalf("hosted options = %q/%q", withOptions.DefaultSize, withOptions.DefaultQuality)
	}

	clamped, _ := PlanImageBridge(enabledImages(func(images *config.ImagesConfig) { images.TimeoutMS = 999_999_999 }), hostedImage(nil), true, routedElsewhere)
	if clamped.TimeoutMS != MaxImageTimeoutMS {
		t.Fatalf("timeout = %d, oracle clamps to %d", clamped.TimeoutMS, MaxImageTimeoutMS)
	}
	negative, _ := PlanImageBridge(enabledImages(func(images *config.ImagesConfig) { images.TimeoutMS = -5 }), hostedImage(nil), true, routedElsewhere)
	if negative.TimeoutMS != 0 {
		t.Fatalf("negative timeout = %d, oracle leaves it unset", negative.TimeoutMS)
	}

	// Floored rather than rounded, measured against the oracle: 7.9 -> 7.
	keep := 7.9
	kept, _ := PlanImageBridge(enabledImages(func(images *config.ImagesConfig) { images.ArtifactsKeepCount = &keep }), hostedImage(nil), true, routedElsewhere)
	if kept.ArtifactsKeepCount != 7 || !kept.HasArtifactsKeepCount {
		t.Fatalf("keep count = %d (set=%v), oracle floors to 7", kept.ArtifactsKeepCount, kept.HasArtifactsKeepCount)
	}
	// A negative value is KEPT: the oracle only requires the number be finite.
	negativeKeep := -2.0
	negativeKept, _ := PlanImageBridge(enabledImages(func(images *config.ImagesConfig) { images.ArtifactsKeepCount = &negativeKeep }), hostedImage(nil), true, routedElsewhere)
	if negativeKept.ArtifactsKeepCount != -2 {
		t.Fatalf("negative keep = %d, oracle returns -2", negativeKept.ArtifactsKeepCount)
	}
	// A fractional timeout floors up to 1 rather than collapsing to unset.
	fractional, _ := PlanImageBridge(enabledImages(func(images *config.ImagesConfig) { images.TimeoutMS = 0.5 }), hostedImage(nil), true, routedElsewhere)
	if fractional.TimeoutMS != 1 {
		t.Fatalf("fractional timeout = %d, oracle returns 1", fractional.TimeoutMS)
	}

	custom, _ := PlanImageBridge(enabledImages(func(images *config.ImagesConfig) { images.BridgeModel = "custom-model" }), hostedImage(nil), true, routedElsewhere)
	if custom.Model != "custom-model" {
		t.Fatalf("model = %q", custom.Model)
	}
}
