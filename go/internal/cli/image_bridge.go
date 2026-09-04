package cli

// Production assembly of the image bridge.
//
// Mirrors configuredSearchLoop: the runtime config decides whether the feature
// exists at all, and the per-request factory decides whether it arms for a
// given turn. The consumer is the Responses core, the only surface whose
// parser attaches the hosted image declaration.

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/images"
	"github.com/lidge-jun/opencodex-go/internal/server"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

// opencodexHome resolves the directory artifacts are written under, matching
// the oracle's OPENCODEX_HOME rule and the same fallback the other consumers
// of this variable use.
//
// Resolved ONCE at startup rather than per request: artifacts written earlier
// in a turn must stay findable even if the environment changes underneath a
// long-running proxy.
func opencodexHome() string {
	if value := strings.TrimSpace(os.Getenv("OPENCODEX_HOME")); value != "" {
		return value
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ".opencodex"
	}
	return filepath.Join(home, ".opencodex")
}

// configuredImageBridge returns nil when the operator has not opted in.
//
// Returning nil rather than a factory that always declines is deliberate: the
// handler checks for nil first, so an un-opted-in proxy carries no per-request
// cost and no chance of arming through a later bug in the factory.
func configuredImageBridge(cfg config.Config, client *http.Client) server.ImageBridgeFactory {
	if cfg.Images == nil || cfg.Images.BridgeEnabled == nil || !*cfg.Images.BridgeEnabled {
		return nil
	}
	home := opencodexHome()
	// Snapshot the config: the factory outlives this call, and reading live
	// mutable config per request would let a mid-flight edit change the
	// endpoint or credential a turn is already using.
	snapshot := cfg
	return func(request *types.NormalizedRequest, routedProvider string) (images.Plan, images.Fulfiller, bool) {
		if request == nil || request.ImageGeneration == nil {
			return images.Plan{}, nil, false
		}
		routed := snapshot.Providers[routedProvider]
		plan, armed := images.PlanImageBridge(&snapshot, *request.ImageGeneration, true, routed)
		if !armed {
			return images.Plan{}, nil, false
		}
		return plan, images.NewFulfiller(client, home, plan), true
	}
}
