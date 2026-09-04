package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/oauth"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

type SidecarKind string

const (
	SidecarImageGenerations SidecarKind = "images/generations"
	SidecarImageEdits       SidecarKind = "images/edits"
	SidecarSearch           SidecarKind = "alpha/search"

	defaultImagesTimeout = 300 * time.Second
	defaultSearchTimeout = 200 * time.Second
	imagesResponseLimit  = int64(100 << 20)
	searchResponseLimit  = int64(16 << 20)
	sidecarRequestLimit  = int64(64 << 20)
)

// SidecarTarget is a fully resolved OpenAI sidecar destination. Headers are
// created by the auth resolver; incoming proxy admission credentials are never
// copied to the upstream request.
type SidecarTarget struct {
	URL           string
	Headers       http.Header
	Timeout       time.Duration
	Transport     HTTPDoer
	RecordOutcome func(status int, err error)
}

type SidecarResolver func(context.Context, SidecarKind, http.Header) (SidecarTarget, error)

type SidecarResolveError struct {
	Status int
	Kind   string
	Err    error
}

func (err *SidecarResolveError) Error() string { return err.Err.Error() }
func (err *SidecarResolveError) Unwrap() error { return err.Err }

func defaultSidecarResolver(config Config) SidecarResolver {
	return func(ctx context.Context, kind SidecarKind, incoming http.Header) (SidecarTarget, error) {
		providers := []string{"openai"}
		if kind != SidecarSearch {
			providers = append(providers, "openai-apikey")
		}
		var configured bool
		for _, provider := range providers {
			if _, err := config.Registry.ResolveModel(provider + "/"); err != nil {
				continue
			}
			configured = true
			if config.Auth == nil {
				return SidecarTarget{}, &SidecarResolveError{Status: http.StatusUnauthorized, Kind: "authentication_error", Err: errors.New(sidecarLabel(kind) + " relay needs upstream authentication")}
			}
			auth, err := config.Auth.ResolveAuth(ctx, provider, authThreadID(incoming))
			if err != nil {
				return SidecarTarget{}, &SidecarResolveError{Status: http.StatusUnauthorized, Kind: "authentication_error", Err: err}
			}
			if auth == nil {
				return SidecarTarget{}, &SidecarResolveError{Status: http.StatusUnauthorized, Kind: "authentication_error", Err: errors.New(sidecarLabel(kind) + " relay needs upstream authentication")}
			}
			transport, err := config.Registry.ResolveTransport(provider, auth)
			if err != nil {
				return SidecarTarget{}, &SidecarResolveError{Status: http.StatusBadGateway, Kind: "upstream_error", Err: err}
			}
			headers := make(http.Header)
			for name, value := range transport.Headers {
				headers.Set(name, value)
			}
			for name, value := range auth.Headers {
				headers.Set(name, value)
			}
			baseURL := strings.TrimRight(transport.BaseURL, "/")
			if provider == "openai-apikey" {
				baseURL = strings.TrimSuffix(baseURL, "/v1") + "/v1"
			}
			target := SidecarTarget{URL: baseURL + "/" + string(kind), Headers: headers, Transport: config.Client}
			if auth.AccountID != "" {
				accountID := auth.AccountID
				target.RecordOutcome = func(status int, outcomeErr error) {
					outcome := types.OutcomeSuccess
					if outcomeErr != nil || status < 200 || status >= 300 {
						outcome = outcomeForHTTP(status)
					}
					config.Auth.RecordOutcome(accountID, outcome, &types.RetryMeta{StatusCode: status, Provider: provider, ProbeLeaseID: auth.ProbeLeaseID, ThreadID: auth.ThreadID})
				}
			}
			return target, nil
		}
		if !configured {
			return SidecarTarget{}, &SidecarResolveError{Status: http.StatusBadRequest, Kind: "invalid_request_error", Err: errors.New(sidecarUnavailableMessage(kind))}
		}
		return SidecarTarget{}, &SidecarResolveError{Status: http.StatusUnauthorized, Kind: "authentication_error", Err: errors.New(sidecarLabel(kind) + " relay needs upstream authentication")}
	}
}

func authThreadID(headers http.Header) string {
	if threadID := strings.TrimSpace(headers.Get("Thread-Id")); threadID != "" {
		return threadID
	}
	return strings.TrimSpace(headers.Get("X-Codex-Parent-Thread-Id"))
}

// anthropicSessionKey derives the Anthropic pool's affinity key.
//
// Deliberately separate from authThreadID: that function feeds Codex thread
// affinity and has its own priority, while this one must match the oracle's
// anthropicSessionKeyFromParts. Reusing authThreadID here produced an empty key
// for requests carrying only session-id, and an empty key makes the pool hold
// the active account instead of rotating.
func anthropicSessionKey(headers http.Header, promptCacheKey string, sharedCohort bool) string {
	sessionID := headers.Get("session_id")
	if sessionID == "" {
		sessionID = headers.Get("session-id")
	}
	return oauth.AnthropicSessionKey(oauth.AnthropicSessionKeyParts{
		ClientThreadID:               headers.Get("X-Codex-Parent-Thread-Id"),
		SessionID:                    sessionID,
		ThreadID:                     headers.Get("Thread-Id"),
		PromptCacheKey:               promptCacheKey,
		PromptCacheKeyIsSharedCohort: sharedCohort,
	})
}

// authSelectionKey is what the resolver receives: the Anthropic pool needs its
// own key, every other provider keeps the existing thread id.
func authSelectionKey(provider string, headers http.Header, promptCacheKey string, sharedCohort bool) string {
	if provider == "anthropic" {
		if key := anthropicSessionKey(headers, promptCacheKey, sharedCohort); key != "" {
			return key
		}
		// An empty key is meaningful to the pool - it means "no session
		// identity, hold the active account" - so it is passed through rather
		// than replaced with the thread id.
		return ""
	}
	return authThreadID(headers)
}

func promptCacheKeyOf(normalized *types.NormalizedRequest) string {
	if normalized == nil {
		return ""
	}
	return normalized.Options.PromptCacheKey
}

// sharedCohortFromHeaders reports whether the prompt-cache key is shared by
// many unrelated conversations.
//
// A shared key must never become an affinity key: every Desktop conversation
// carrying it would be pinned to one account, concentrating traffic there and
// causing the rate limits the pool exists to spread.
func sharedCohortFromHeaders(headers http.Header) bool {
	return headers.Get(types.SharedCohortHeader) == "1"
}

// AnthropicPoolMaxFailoversPerRequest caps account rotations inside one
// request, matching ANTHROPIC_POOL_MAX_FAILOVERS_PER_REQUEST.
//
// Without a cap a short Retry-After returned by several accounts in turn would
// keep the request alive indefinitely while the caller waits.
const AnthropicPoolMaxFailoversPerRequest = 3

func sidecarHandler(kind SidecarKind, resolver SidecarResolver) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		if resolver == nil {
			writeJSONError(w, http.StatusBadRequest, "invalid_request_error", sidecarUnavailableMessage(kind))
			return
		}
		payload, contentType, err := readSidecarPayload(w, request, kind)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid_request_error", err.Error())
			return
		}
		target, err := resolver(request.Context(), kind, request.Header.Clone())
		if err != nil {
			writeSidecarResolveError(w, err)
			return
		}
		if err := validateSidecarTarget(target); err != nil {
			writeJSONError(w, http.StatusBadGateway, "upstream_error", err.Error())
			return
		}
		relaySidecar(w, request, kind, target, payload, contentType)
	}
}

func readSidecarPayload(w http.ResponseWriter, request *http.Request, kind SidecarKind) ([]byte, string, error) {
	if request.Body == nil {
		return nil, "", errors.New("request body is required")
	}
	payload, err := io.ReadAll(http.MaxBytesReader(w, request.Body, sidecarRequestLimit))
	if err != nil {
		return nil, "", fmt.Errorf("read request body: %w", err)
	}
	contentType := strings.TrimSpace(request.Header.Get("Content-Type"))
	mediaType := strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0]))
	if kind == SidecarImageEdits && mediaType == "multipart/form-data" {
		if len(payload) == 0 {
			return nil, "", errors.New("request body is required")
		}
		return payload, contentType, nil
	}
	var value any
	if len(payload) == 0 || json.Unmarshal(payload, &value) != nil {
		return nil, "", errors.New("request body must be valid JSON")
	}
	canonical, err := json.Marshal(value)
	return canonical, "application/json", err
}

func validateSidecarTarget(target SidecarTarget) error {
	parsed, err := url.Parse(target.URL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil {
		return errors.New("sidecar resolver returned an invalid upstream URL")
	}
	return nil
}

func relaySidecar(w http.ResponseWriter, incoming *http.Request, kind SidecarKind, target SidecarTarget, payload []byte, contentType string) {
	timeout, limit := sidecarBounds(kind, target.Timeout)
	ctx, cancel := context.WithTimeout(incoming.Context(), timeout)
	defer cancel()
	upstream, err := http.NewRequestWithContext(ctx, http.MethodPost, target.URL, bytes.NewReader(payload))
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, "upstream_error", err.Error())
		return
	}
	upstream.Header = target.Headers.Clone()
	if upstream.Header == nil {
		upstream.Header = make(http.Header)
	}
	if contentType == "" {
		contentType = "application/json"
	}
	upstream.Header.Set("Content-Type", contentType)
	transport := target.Transport
	if transport == nil {
		transport = http.DefaultClient
	}
	response, err := transport.Do(upstream)
	if err != nil {
		if target.RecordOutcome != nil {
			target.RecordOutcome(0, err)
		}
		switch {
		case incoming.Context().Err() != nil:
			writeJSONError(w, 499, "client_closed_request", sidecarLabel(kind)+" request canceled by client")
		case errors.Is(ctx.Err(), context.DeadlineExceeded):
			writeJSONError(w, http.StatusGatewayTimeout, "upstream_error", sidecarLabel(kind)+" upstream timed out")
		default:
			writeJSONError(w, http.StatusBadGateway, "upstream_error", sidecarLabel(kind)+" relay failed: "+err.Error())
		}
		return
	}
	defer response.Body.Close()
	if response.ContentLength > limit {
		if target.RecordOutcome != nil {
			target.RecordOutcome(0, errors.New("sidecar response exceeds size limit"))
		}
		writeJSONError(w, http.StatusBadGateway, "upstream_error", fmt.Sprintf("%s response too large (%d bytes)", sidecarLabel(kind), response.ContentLength))
		return
	}
	buffered, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		if target.RecordOutcome != nil {
			target.RecordOutcome(0, err)
		}
		writeJSONError(w, http.StatusBadGateway, "upstream_error", "read "+sidecarLabel(kind)+" response: "+err.Error())
		return
	}
	if int64(len(buffered)) > limit {
		if target.RecordOutcome != nil {
			target.RecordOutcome(0, errors.New("sidecar response exceeds size limit"))
		}
		writeJSONError(w, http.StatusBadGateway, "upstream_error", fmt.Sprintf("%s response too large (%d bytes)", sidecarLabel(kind), len(buffered)))
		return
	}
	if target.RecordOutcome != nil {
		target.RecordOutcome(response.StatusCode, nil)
	}
	if contentType := response.Header.Get("Content-Type"); contentType != "" {
		w.Header().Set("Content-Type", contentType)
	}
	w.WriteHeader(response.StatusCode)
	_, _ = w.Write(buffered)
}

func writeSidecarResolveError(w http.ResponseWriter, err error) {
	var resolved *SidecarResolveError
	if errors.As(err, &resolved) {
		status, kind := resolved.Status, resolved.Kind
		if status == 0 {
			status = http.StatusBadGateway
		}
		if kind == "" {
			kind = "upstream_error"
		}
		writeJSONError(w, status, kind, resolved.Error())
		return
	}
	writeJSONError(w, http.StatusBadGateway, "upstream_error", err.Error())
}

func sidecarBounds(kind SidecarKind, configured time.Duration) (time.Duration, int64) {
	if kind == SidecarSearch {
		if configured <= 0 {
			configured = defaultSearchTimeout
		}
		return configured, searchResponseLimit
	}
	if configured <= 0 {
		configured = defaultImagesTimeout
	}
	return configured, imagesResponseLimit
}

func sidecarLabel(kind SidecarKind) string {
	if kind == SidecarSearch {
		return "search"
	}
	return "image " + strings.TrimPrefix(string(kind), "images/")
}

func sidecarUnavailableMessage(kind SidecarKind) string {
	if kind == SidecarSearch {
		return "Built-in web search needs a ChatGPT forward provider, but none is configured in opencodex"
	}
	return "Built-in image generation needs an OpenAI upstream, but none is configured in opencodex"
}
