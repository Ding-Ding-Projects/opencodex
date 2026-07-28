package images

// Assembly of the production bridge.
//
// The decision to arm and the transports that spend money are put together in
// one place, in this package, so a caller cannot accidentally build a bridge
// that skips the opt-in, the routing check or the credential check.

import (
	"context"
	"io"
	"net"
	"net/http"
	"path/filepath"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/config"
)

// ArtifactsDirName is the artifacts subdirectory under the resolved home.
const ArtifactsDirName = "artifacts"

// ResolveMaxRounds converts the configured budget.
//
// The config stores maxRounds as *int while ClampImageMaxRounds takes the
// *float64 the oracle's flooring semantics require. Bridging the two here is
// what makes the clamp reachable at all: before this the two types could not
// meet, so a configured budget could never have been applied to anything.
func ResolveMaxRounds(images *config.ImagesConfig) int {
	if images == nil || images.MaxRounds == nil {
		return ClampImageMaxRounds(nil)
	}
	rounds := float64(*images.MaxRounds)
	return ClampImageMaxRounds(&rounds)
}

// NewFulfiller builds the paid-call side of the bridge for one plan.
//
// The budget is per bridge, not per call: it caps the bytes ONE turn may write
// to disk, so a model asking for images repeatedly cannot fill the disk one
// under-cap call at a time.
func NewFulfiller(client *http.Client, home string, plan Plan) Fulfiller {
	dir := filepath.Join(home, ArtifactsDirName)
	budget := &ImageBudget{}
	return func(ctx context.Context, call ImageCall) ImageCallResult {
		return FulfillImageCall(ctx, dir, ImageToolCall{ID: call.ID, Name: call.Name, Arguments: call.Args},
			plan, budget, SystemIPLookup, PinnedDownloader(client), func(
				callCtx context.Context, request XaiImageRequest, auth BridgeAuth, timeout time.Duration,
			) ([]XaiImage, error) {
				return CallXaiImages(callCtx, client, request, auth, timeout)
			})
	}
}

// SystemIPLookup resolves through the platform resolver.
func SystemIPLookup(ctx context.Context, host string) ([]net.IP, error) {
	addresses, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, err
	}
	out := make([]net.IP, 0, len(addresses))
	for _, address := range addresses {
		out = append(out, address.IP)
	}
	return out, nil
}

// PinnedDownloader dials the ALREADY-VALIDATED address while keeping the
// hostname for TLS and SNI. That separation is the DNS-rebinding defence: the
// name is resolved once, above this function, and the connection can no longer
// follow a second answer.
//
// A fresh transport per download, not the shared pooled client, for the same
// reason — a pooled connection could be reused for a host whose address was
// validated at a different moment.
//
// Redirects are returned rather than followed, because a redirect is a second
// destination nobody validated; download.go treats any non-2xx as a failure.
func PinnedDownloader(base *http.Client) PinnedDownload {
	return func(ctx context.Context, url string, pinned PinnedAddress) (int, io.ReadCloser, error) {
		dialer := &net.Dialer{Timeout: 10 * time.Second}
		transport := &http.Transport{
			DialContext: func(dialCtx context.Context, network, address string) (net.Conn, error) {
				_, port, err := net.SplitHostPort(address)
				if err != nil {
					return nil, err
				}
				return dialer.DialContext(dialCtx, network, net.JoinHostPort(pinned.Address, port))
			},
		}
		client := &http.Client{
			Transport: transport,
			Timeout:   downloadTimeout(base),
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return 0, nil, err
		}
		response, err := client.Do(request)
		if err != nil {
			return 0, nil, err
		}
		return response.StatusCode, response.Body, nil
	}
}

func downloadTimeout(base *http.Client) time.Duration {
	if base != nil && base.Timeout > 0 {
		return base.Timeout
	}
	return 60 * time.Second
}
