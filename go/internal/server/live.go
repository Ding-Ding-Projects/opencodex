package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const (
	LiveRequestMaxBytes  int64 = 16 << 20
	LiveResponseMaxBytes int64 = 16 << 20
	LiveAVASQuery              = "intent=quicksilver&architecture=avas"
	LiveSidebandAPIRoot        = "https://api.openai.com/v1"
)

var (
	liveCallIDPattern   = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
	liveProtocolHeaders = []string{
		"OpenAI-Alpha", "X-Session-Id", "Session-Id", "Thread-Id", "Originator", "X-OAI-Attestation",
	}
)

type LiveSidebandStyle string

const (
	LiveFramelessPath     LiveSidebandStyle = "frameless-path"
	LiveRealtimeCallsPath LiveSidebandStyle = "realtime-calls-path"
	LiveRealtimeQuery     LiveSidebandStyle = "realtime-query"
)

type LiveSidebandTarget struct {
	Style  LiveSidebandStyle
	CallID string
}

type LiveRelayTarget struct {
	Headers          http.Header
	ProviderBaseURL  string
	UsesBackendShape bool
	Keyed            bool
	RecordOutcome    func(int)
}

type LiveRelayResolver func(context.Context, http.Header) (LiveRelayTarget, error)

type LiveHandler struct {
	Resolve       LiveRelayResolver
	Client        HTTPDoer
	Timeout       time.Duration
	RequestLimit  int64
	ResponseLimit int64
}

func NewLiveHandler(resolve LiveRelayResolver, client HTTPDoer) *LiveHandler {
	if client == nil {
		client = NewProviderClient(FetchTimeouts{Overall: 2 * time.Minute})
	}
	return &LiveHandler{Resolve: resolve, Client: client, Timeout: 2 * time.Minute, RequestLimit: LiveRequestMaxBytes, ResponseLimit: LiveResponseMaxBytes}
}

func ParseLiveSidebandTarget(path string, query url.Values) (LiveSidebandTarget, bool) {
	for _, candidate := range []struct {
		prefix string
		style  LiveSidebandStyle
	}{{"/v1/live/", LiveFramelessPath}, {"/v1/realtime/calls/", LiveRealtimeCallsPath}} {
		if strings.HasPrefix(path, candidate.prefix) {
			raw := strings.TrimSuffix(strings.TrimPrefix(path, candidate.prefix), "/")
			if raw == "" || strings.Contains(raw, "/") {
				return LiveSidebandTarget{}, false
			}
			callID, err := url.PathUnescape(raw)
			if err != nil || !liveCallIDPattern.MatchString(callID) {
				return LiveSidebandTarget{}, false
			}
			return LiveSidebandTarget{Style: candidate.style, CallID: callID}, true
		}
	}
	if path == "/v1/realtime" || path == "/v1/realtime/" {
		callID := strings.TrimSpace(query.Get("call_id"))
		if liveCallIDPattern.MatchString(callID) {
			return LiveSidebandTarget{Style: LiveRealtimeQuery, CallID: callID}, true
		}
	}
	return LiveSidebandTarget{}, false
}

func BuildLiveSidebandUpstreamWSURL(providerBaseURL string, usesBackendShape bool, target LiveSidebandTarget) (string, error) {
	if !liveCallIDPattern.MatchString(target.CallID) {
		return "", fmt.Errorf("invalid live call id")
	}
	root := strings.TrimRight(strings.TrimSpace(providerBaseURL), "/")
	if usesBackendShape {
		root = LiveSidebandAPIRoot
	}
	apiRoot := strings.TrimSuffix(root, "/v1")
	var raw string
	switch target.Style {
	case LiveFramelessPath:
		raw = apiRoot + "/v1/live/" + url.PathEscape(target.CallID)
	case LiveRealtimeCallsPath:
		raw = apiRoot + "/v1/realtime/calls/" + url.PathEscape(target.CallID)
	case LiveRealtimeQuery:
		raw = apiRoot + "/v1/realtime?intent=quicksilver&call_id=" + url.QueryEscape(target.CallID)
	default:
		return "", fmt.Errorf("unsupported live sideband style %q", target.Style)
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return "", fmt.Errorf("invalid live provider base URL")
	}
	if parsed.Scheme == "https" {
		parsed.Scheme = "wss"
	} else {
		parsed.Scheme = "ws"
	}
	return parsed.String(), nil
}

func KeyedLiveURL(baseURL string) (string, error) {
	root, err := normalizeLiveBaseURL(baseURL)
	if err != nil {
		return "", err
	}
	root = strings.TrimSuffix(root, "/v1") + "/v1/realtime/calls"
	return withLiveAVASQuery(root), nil
}

func ForwardLiveURL(baseURL string, backendShape bool) (string, error) {
	root, err := normalizeLiveBaseURL(baseURL)
	if err != nil {
		return "", err
	}
	if backendShape {
		return withLiveAVASQuery(root + "/realtime/calls"), nil
	}
	return root + "/live", nil
}

func normalizeLiveBaseURL(raw string) (string, error) {
	root := strings.TrimRight(strings.TrimSpace(raw), "/")
	parsed, err := url.Parse(root)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return "", fmt.Errorf("invalid live provider base URL")
	}
	return root, nil
}

func withLiveAVASQuery(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	query := parsed.Query()
	if query.Get("intent") == "" {
		query.Set("intent", "quicksilver")
	}
	if query.Get("architecture") == "" {
		query.Set("architecture", "avas")
	}
	parsed.RawQuery = query.Encode()
	return parsed.String()
}

func LiveClientProtocolHeaders(incoming http.Header) http.Header {
	out := make(http.Header)
	for _, name := range liveProtocolHeaders {
		if value := strings.TrimSpace(incoming.Get(name)); value != "" {
			out.Set(name, value)
		}
	}
	return out
}

func ReadLiveBodyCapped(ctx context.Context, body io.ReadCloser, maxBytes int64) ([]byte, error) {
	if body == nil {
		return []byte{}, nil
	}
	defer body.Close()
	if maxBytes <= 0 {
		maxBytes = LiveRequestMaxBytes
	}
	result := make([]byte, 0, min(int(maxBytes), 64<<10))
	buffer := make([]byte, 32<<10)
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		n, err := body.Read(buffer)
		if n > 0 {
			if int64(len(result)+n) > maxBytes {
				return nil, &LiveBodyLimitError{Limit: maxBytes, Total: int64(len(result) + n)}
			}
			result = append(result, buffer[:n]...)
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return result, nil
			}
			return nil, err
		}
	}
}

type LiveBodyLimitError struct {
	Limit int64
	Total int64
}

func (err *LiveBodyLimitError) Error() string {
	return fmt.Sprintf("live body exceeded %d bytes (%d bytes observed)", err.Limit, err.Total)
}

func BackendJSONFromLiveMultipart(body []byte, contentType string) ([]byte, string, error) {
	mediaType, params, err := mime.ParseMediaType(contentType)
	if err != nil || !strings.EqualFold(mediaType, "multipart/form-data") || params["boundary"] == "" {
		return nil, "", fmt.Errorf("ChatGPT voice relay could not parse multipart call-create body")
	}
	reader := multipart.NewReader(bytes.NewReader(body), params["boundary"])
	var sdp string
	var session any
	hasSession := false
	for {
		part, partErr := reader.NextPart()
		if errors.Is(partErr, io.EOF) {
			break
		}
		if partErr != nil {
			return nil, "", fmt.Errorf("ChatGPT voice relay could not parse multipart call-create body")
		}
		data, readErr := io.ReadAll(io.LimitReader(part, LiveRequestMaxBytes+1))
		_ = part.Close()
		if readErr != nil || int64(len(data)) > LiveRequestMaxBytes {
			return nil, "", fmt.Errorf("ChatGPT voice relay could not read multipart field")
		}
		switch part.FormName() {
		case "sdp":
			sdp = string(data)
		case "session":
			if json.Unmarshal(data, &session) != nil {
				return nil, "", fmt.Errorf("ChatGPT voice relay expected JSON in the multipart session field")
			}
			hasSession = true
		}
	}
	if sdp == "" {
		return nil, "", fmt.Errorf("ChatGPT voice relay expects multipart field sdp on call-create")
	}
	payload := map[string]any{"sdp": sdp}
	if hasSession {
		payload["session"] = session
	}
	encoded, err := json.Marshal(payload)
	return encoded, "application/json", err
}

func (handler *LiveHandler) ServeHTTP(w http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.Resolve == nil {
		writeJSONError(w, http.StatusServiceUnavailable, "server_not_configured", "live relay is not configured")
		return
	}
	requestLimit := handler.RequestLimit
	if requestLimit <= 0 {
		requestLimit = LiveRequestMaxBytes
	}
	inbound, err := ReadLiveBodyCapped(request.Context(), request.Body, requestLimit)
	if err != nil {
		var limit *LiveBodyLimitError
		if errors.As(err, &limit) {
			writeJSONError(w, http.StatusRequestEntityTooLarge, "invalid_request_error", "live request body too large")
		} else if request.Context().Err() != nil {
			writeJSONError(w, 499, "client_closed_request", "live request canceled by client")
		} else {
			writeJSONError(w, http.StatusBadRequest, "invalid_request_error", "live request body unreadable")
		}
		return
	}
	target, err := handler.Resolve(request.Context(), request.Header.Clone())
	if err != nil {
		writeJSONError(w, http.StatusUnauthorized, "authentication_error", err.Error())
		return
	}
	headers := LiveClientProtocolHeaders(request.Header)
	for name, values := range target.Headers {
		headers.Del(name)
		for _, value := range values {
			headers.Add(name, value)
		}
	}
	contentType := firstNonBlank(request.Header.Get("Content-Type"), "application/octet-stream")
	outbound := inbound
	var endpoint string
	if target.Keyed {
		endpoint, err = KeyedLiveURL(target.ProviderBaseURL)
	} else {
		endpoint, err = ForwardLiveURL(target.ProviderBaseURL, target.UsesBackendShape)
		if err == nil && target.UsesBackendShape && strings.Contains(strings.ToLower(contentType), "multipart/form-data") {
			outbound, contentType, err = BackendJSONFromLiveMultipart(inbound, contentType)
		}
	}
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid_request_error", err.Error())
		return
	}
	headers.Set("Content-Type", contentType)
	ctx := request.Context()
	timeout := handler.Timeout
	if timeout <= 0 {
		timeout = 2 * time.Minute
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	upstream, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(outbound))
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, "upstream_error", err.Error())
		return
	}
	upstream.Header = headers
	response, err := handler.Client.Do(upstream)
	if err != nil {
		if request.Context().Err() != nil {
			writeJSONError(w, 499, "client_closed_request", "live request canceled by client")
		} else if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			writeJSONError(w, http.StatusGatewayTimeout, "upstream_error", "live upstream timed out")
		} else {
			writeJSONError(w, http.StatusBadGateway, "upstream_error", "live upstream unreachable")
		}
		return
	}
	if target.RecordOutcome != nil {
		target.RecordOutcome(response.StatusCode)
	}
	responseLimit := handler.ResponseLimit
	if responseLimit <= 0 {
		responseLimit = LiveResponseMaxBytes
	}
	payload, err := ReadLiveBodyCapped(request.Context(), response.Body, responseLimit)
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, "upstream_error", err.Error())
		return
	}
	for _, name := range []string{"Content-Type", "Location"} {
		if value := response.Header.Get(name); value != "" {
			w.Header().Set(name, value)
		}
	}
	w.WriteHeader(response.StatusCode)
	_, _ = w.Write(payload)
}

func firstNonBlank(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
