package cli

import (
	"net/http"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/images"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

func imageBridgeConfig(enabled *bool) config.Config {
	return config.Config{
		Images: &config.ImagesConfig{BridgeEnabled: enabled},
		Providers: map[string]config.ProviderConfig{
			"xai": {BaseURL: "https://api.x.ai/v1", APIKey: "test-key"},
		},
	}
}

func hostedImageRequest() *types.NormalizedRequest {
	return &types.NormalizedRequest{
		ImageGeneration: &types.HostedImageTools{ToolNames: []string{"image_gen"}},
	}
}

// The master switch is the whole reason an operator can trust this feature not
// to spend their money. Off, and absent, must both mean off.
func TestTheBridgeIsNotAssembledWithoutTheOptIn(t *testing.T) {
	off := false
	for name, cfg := range map[string]config.Config{
		"absent images section": {},
		"absent flag":           {Images: &config.ImagesConfig{}},
		"flag off":              imageBridgeConfig(&off),
	} {
		if factory := configuredImageBridge(cfg, http.DefaultClient); factory != nil {
			t.Fatalf("%s produced a live bridge factory", name)
		}
	}
}

// And with the opt-in, it must actually arm — an always-nil factory would be a
// silently dead feature, which is how five earlier slices in this port shipped.
func TestTheOptInProducesAFactoryThatArms(t *testing.T) {
	on := true
	factory := configuredImageBridge(imageBridgeConfig(&on), http.DefaultClient)
	if factory == nil {
		t.Fatal("the opt-in produced no factory")
	}
	plan, fulfill, armed := factory(hostedImageRequest(), "xai")
	if !armed || fulfill == nil {
		t.Fatalf("armed=%v fulfill=%v", armed, fulfill == nil)
	}
	if plan.Auth.Token != "test-key" {
		t.Fatalf("plan carried no usable credential: %#v", plan.Auth)
	}
	// The endpoint is pinned, not taken from provider config: a baseUrl
	// override must not be able to redirect an authenticated image call.
	if plan.Auth.BaseURL != images.XaiImageBaseURL {
		t.Fatalf("endpoint = %s, want the pinned %s", plan.Auth.BaseURL, images.XaiImageBaseURL)
	}
}

// A request that never declared a hosted image tool must not arm even with the
// opt-in on.
func TestAFactoryDeclinesARequestWithNoHostedDeclaration(t *testing.T) {
	on := true
	factory := configuredImageBridge(imageBridgeConfig(&on), http.DefaultClient)
	if _, _, armed := factory(&types.NormalizedRequest{}, "xai"); armed {
		t.Fatal("a request with no hosted image tool still armed the bridge")
	}
	if _, _, armed := factory(nil, "xai"); armed {
		t.Fatal("a nil request armed the bridge")
	}
}

// Without a usable xAI credential there is nothing to call, so arming would
// only produce failures the user pays for in latency.
func TestAFactoryDeclinesWithoutAnXaiCredential(t *testing.T) {
	on := true
	cfg := imageBridgeConfig(&on)
	cfg.Providers = map[string]config.ProviderConfig{}
	factory := configuredImageBridge(cfg, http.DefaultClient)
	if factory == nil {
		t.Fatal("the opt-in produced no factory")
	}
	if _, _, armed := factory(hostedImageRequest(), "openai"); armed {
		t.Fatal("the bridge armed with no xAI provider configured")
	}
}

// The config stores maxRounds as *int and the clamp takes *float64. Before the
// wiring bridged them the configured budget could not reach the loop at all.
func TestTheConfiguredRoundBudgetIsResolvedAndClamped(t *testing.T) {
	if got := images.ResolveMaxRounds(nil); got != images.DefaultMaxRounds {
		t.Fatalf("absent config = %d, want the default %d", got, images.DefaultMaxRounds)
	}
	if got := images.ResolveMaxRounds(&config.ImagesConfig{}); got != images.DefaultMaxRounds {
		t.Fatalf("absent maxRounds = %d, want the default %d", got, images.DefaultMaxRounds)
	}
	for _, testCase := range []struct{ configured, want int }{
		{configured: 0, want: 0},
		{configured: 2, want: 2},
		{configured: 10000, want: images.MaxRoundsHardLimit},
		{configured: -5, want: 0},
	} {
		rounds := testCase.configured
		if got := images.ResolveMaxRounds(&config.ImagesConfig{MaxRounds: &rounds}); got != testCase.want {
			t.Fatalf("maxRounds %d resolved to %d, want %d", testCase.configured, got, testCase.want)
		}
	}
}
