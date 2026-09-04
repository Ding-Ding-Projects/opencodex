package kiro

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"syscall"
	"time"
)

const (
	resetAttempts      = 3
	resetRetryBase     = 150 * time.Millisecond
	resetRetryMax      = time.Second
	maxEndpointInspect = 1 << 20
)

var canonicalRuntimeHost = regexp.MustCompile(`(?i)^runtime\.([a-z]{2}(?:-[a-z]+)+-\d)\.kiro\.dev$`)

var endpointErrorMarkers = []string{
	"unknownoperation",
	"unknown operation",
	"invalidsignature",
	"invalid signature",
	"endpoint not found",
	"unsupported endpoint",
}

func IsConnectionReset(err error) bool {
	if err == nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return false
	}
	if errors.Is(err, syscall.ECONNRESET) || errors.Is(err, syscall.EPIPE) || errors.Is(err, io.ErrUnexpectedEOF) {
		return true
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return true
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "connection reset") || strings.Contains(message, "socket connection was closed unexpectedly")
}

func LegacyRuntimeURL(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" || parsed.Path != "/" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return ""
	}
	match := canonicalRuntimeHost.FindStringSubmatch(parsed.Hostname())
	if len(match) != 2 {
		return ""
	}
	port := parsed.Port()
	parsed.Host = "q." + match[1] + ".amazonaws.com"
	if port != "" {
		parsed.Host += ":" + port
	}
	return parsed.String()
}

// DoWithRetry owns only replay-safe connection-reset recovery and the one
// canonical-to-legacy Kiro endpoint fallback. Ordinary HTTP status retries are
// deliberately left to the caller's retry policy, matching the TypeScript adapter.
func DoWithRetry(ctx context.Context, client *http.Client, request *http.Request) (*http.Response, error) {
	if client == nil {
		client = http.DefaultClient
	}
	legacy := LegacyRuntimeURL(request.URL.String())
	response, err := doWithResetRecoveryAt(ctx, client, request, request.URL)
	if err != nil {
		if legacy == "" || !isEndpointConnectFailure(err) {
			return nil, err
		}
		legacyURL, parseErr := url.Parse(legacy)
		if parseErr != nil {
			return nil, err
		}
		return doWithResetRecoveryAt(ctx, client, request, legacyURL)
	}
	if legacy == "" || response.StatusCode < 400 {
		return response, nil
	}
	fallback, rebuilt, inspectErr := inspectEndpointHTTPFailure(response)
	if inspectErr != nil {
		return nil, inspectErr
	}
	if !fallback {
		return rebuilt, nil
	}
	if rebuilt.Body != nil {
		_ = rebuilt.Body.Close()
	}
	legacyURL, parseErr := url.Parse(legacy)
	if parseErr != nil {
		return rebuilt, nil
	}
	return doWithResetRecoveryAt(ctx, client, request, legacyURL)
}

func doWithResetRecoveryAt(ctx context.Context, client *http.Client, request *http.Request, target *url.URL) (*http.Response, error) {
	var last error
	for attempt := 0; attempt < resetAttempts; attempt++ {
		clone := request.Clone(ctx)
		clone.URL = cloneURL(target)
		clone.Host = ""
		if request.GetBody != nil {
			body, err := request.GetBody()
			if err != nil {
				return nil, err
			}
			clone.Body = body
		}
		if attempt > 0 {
			clone.Close = true
			clone.Header.Set("Connection", "close")
		}
		response, err := client.Do(clone)
		if err == nil {
			return response, nil
		}
		last = err
		if !IsConnectionReset(err) || attempt == resetAttempts-1 {
			return nil, err
		}
		delay := resetRetryBase * time.Duration(1<<attempt)
		if delay > resetRetryMax {
			delay = resetRetryMax
		}
		timer := time.NewTimer(delay)
		select {
		case <-timer.C:
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		}
	}
	return nil, last
}

func cloneURL(source *url.URL) *url.URL {
	if source == nil {
		return &url.URL{}
	}
	copy := *source
	return &copy
}

func isEndpointConnectFailure(err error) bool {
	if err == nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return false
	}
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return true
	}
	if errors.Is(err, syscall.ECONNREFUSED) || errors.Is(err, syscall.ENETUNREACH) || errors.Is(err, syscall.EHOSTUNREACH) {
		return true
	}
	message := strings.ToLower(err.Error())
	return containsAny(message,
		"dns", "name resolution", "failed to lookup address", "connection refused",
		"failed to connect", "connect error",
	)
}

// inspectEndpointHTTPFailure preserves a replayable copy of the response body
// because callers still need the original Kiro error when fallback is not selected.
func inspectEndpointHTTPFailure(response *http.Response) (bool, *http.Response, error) {
	if response == nil {
		return false, nil, errors.New("inspect Kiro endpoint response: nil response")
	}
	if response.StatusCode == http.StatusNotFound || response.StatusCode == http.StatusMethodNotAllowed {
		return true, response, nil
	}
	if response.StatusCode != http.StatusBadRequest && response.StatusCode != http.StatusForbidden {
		return false, response, nil
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxEndpointInspect+1))
	if err != nil {
		return false, response, fmt.Errorf("inspect Kiro endpoint response: %w", err)
	}
	if len(body) > maxEndpointInspect {
		body = body[:maxEndpointInspect]
	}
	_ = response.Body.Close()
	response.Body = io.NopCloser(bytes.NewReader(body))
	response.ContentLength = int64(len(body))
	response.Header.Del("Content-Encoding")
	response.Header.Del("Content-Length")
	lower := strings.ToLower(string(body))
	for _, marker := range endpointErrorMarkers {
		if strings.Contains(lower, marker) {
			return true, response, nil
		}
	}
	return false, response, nil
}
