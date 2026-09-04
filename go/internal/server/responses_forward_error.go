package server

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strings"

	ocxlib "github.com/lidge-jun/opencodex-go/internal/lib"
)

// Some adapters perform a provider bootstrap while constructing the final
// request. Those failures crossed the network and must remain retryable server
// errors; only deterministic local serialization/validation failures are 400s.
func classifyAdapterBuildFailure(err error) (int, string) {
	if errors.Is(err, context.Canceled) {
		return 499, "client_cancelled"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return http.StatusBadGateway, "transport_error"
	}
	var networkError net.Error
	var urlError *url.Error
	if errors.As(err, &urlError) {
		if strings.EqualFold(strings.TrimSpace(urlError.Op), "parse") {
			return http.StatusBadRequest, "request_build_error"
		}
		return http.StatusBadGateway, "transport_error"
	}
	if errors.As(err, &networkError) || ocxlib.IsConnectionResetError(err) {
		return http.StatusBadGateway, "transport_error"
	}
	message := strings.ToLower(err.Error())
	for _, marker := range []string{"mimo bootstrap", "bootstrap request failed", "dial tcp", "connection refused", "no such host", "tls handshake", "i/o timeout"} {
		if strings.Contains(message, marker) {
			return http.StatusBadGateway, "transport_error"
		}
	}
	return http.StatusBadRequest, "request_build_error"
}
