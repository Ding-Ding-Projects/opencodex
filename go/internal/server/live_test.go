package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestParseLiveSidebandTargetAndBuildURL(t *testing.T) {
	tests := []struct {
		path  string
		query url.Values
		style LiveSidebandStyle
	}{
		{path: "/v1/live/call_1", style: LiveFramelessPath},
		{path: "/v1/realtime/calls/call-2/", style: LiveRealtimeCallsPath},
		{path: "/v1/realtime", query: url.Values{"call_id": {"call_3"}}, style: LiveRealtimeQuery},
	}
	for _, test := range tests {
		target, ok := ParseLiveSidebandTarget(test.path, test.query)
		if !ok || target.Style != test.style {
			t.Fatalf("target for %s = %#v, %v", test.path, target, ok)
		}
		upstream, err := BuildLiveSidebandUpstreamWSURL("https://chatgpt.com/backend-api/codex", true, target)
		if err != nil || !strings.HasPrefix(upstream, "wss://api.openai.com/v1/") || !strings.Contains(upstream, target.CallID) {
			t.Fatalf("upstream = %q, err=%v", upstream, err)
		}
	}
	for _, path := range []string{"/v1/live/", "/v1/live/a/b", "/v1/live/%2F", "/v1/realtime?call_id="} {
		parsed, _ := url.Parse(path)
		if _, ok := ParseLiveSidebandTarget(parsed.Path, parsed.Query()); ok {
			t.Fatalf("accepted invalid target %q", path)
		}
	}
}

func TestLiveURLsPreserveAndCompleteAVASQuery(t *testing.T) {
	keyed, err := KeyedLiveURL("https://api.openai.com/v1")
	if err != nil || !strings.Contains(keyed, "intent=quicksilver") || !strings.Contains(keyed, "architecture=avas") || !strings.Contains(keyed, "/v1/realtime/calls") {
		t.Fatalf("keyed=%q err=%v", keyed, err)
	}
	backend, err := ForwardLiveURL("https://chatgpt.com/backend-api/codex", true)
	if err != nil || !strings.Contains(backend, "/realtime/calls?") {
		t.Fatalf("backend=%q err=%v", backend, err)
	}
	frameless, err := ForwardLiveURL("https://api.openai.com/v1", false)
	if err != nil || frameless != "https://api.openai.com/v1/live" {
		t.Fatalf("frameless=%q err=%v", frameless, err)
	}
}

func TestBackendJSONFromLiveMultipart(t *testing.T) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	_ = writer.WriteField("sdp", "offer-sdp")
	_ = writer.WriteField("session", `{"type":"realtime","model":"gpt-live"}`)
	_ = writer.Close()
	payload, contentType, err := BackendJSONFromLiveMultipart(body.Bytes(), writer.FormDataContentType())
	if err != nil || contentType != "application/json" {
		t.Fatal(err)
	}
	var parsed map[string]any
	_ = json.Unmarshal(payload, &parsed)
	if parsed["sdp"] != "offer-sdp" || parsed["session"].(map[string]any)["model"] != "gpt-live" {
		t.Fatalf("payload=%s", payload)
	}
	if _, _, err := BackendJSONFromLiveMultipart([]byte("bad"), "multipart/form-data; boundary=x"); err == nil {
		t.Fatal("malformed multipart accepted")
	}
}

func TestReadLiveBodyCappedRejectsBeforeReturningPartialPayload(t *testing.T) {
	_, err := ReadLiveBodyCapped(context.Background(), io.NopCloser(strings.NewReader("123456789")), 8)
	var limit *LiveBodyLimitError
	if !errorsAs(err, &limit) || limit.Total != 9 {
		t.Fatalf("error=%#v", err)
	}
}

func errorsAs(err error, target any) bool {
	switch typed := target.(type) {
	case **LiveBodyLimitError:
		value, ok := err.(*LiveBodyLimitError)
		if ok {
			*typed = value
		}
		return ok
	default:
		return false
	}
}

func TestLiveHandlerRewritesBackendMultipartAndRelaysSafeHeaders(t *testing.T) {
	var upstreamBody, alpha string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		payload, _ := io.ReadAll(request.Body)
		upstreamBody = string(payload)
		alpha = request.Header.Get("OpenAI-Alpha")
		if request.URL.Path != "/backend-api/codex/realtime/calls" || request.URL.Query().Get("architecture") != "avas" {
			t.Errorf("URL=%s", request.URL.String())
		}
		w.Header().Set("Content-Type", "application/sdp")
		w.Header().Set("Location", "/v1/live/call_1")
		w.Header().Set("Set-Cookie", "secret=bad")
		w.WriteHeader(http.StatusCreated)
		_, _ = io.WriteString(w, "answer-sdp")
	}))
	defer upstream.Close()
	var outcome int
	handler := NewLiveHandler(func(context.Context, http.Header) (LiveRelayTarget, error) {
		return LiveRelayTarget{
			ProviderBaseURL: upstream.URL + "/backend-api/codex", UsesBackendShape: true,
			Headers: http.Header{"Authorization": {"Bearer upstream-only"}}, RecordOutcome: func(status int) { outcome = status },
		}, nil
	}, upstream.Client())
	var inbound bytes.Buffer
	multipartWriter := multipart.NewWriter(&inbound)
	_ = multipartWriter.WriteField("sdp", "offer")
	_ = multipartWriter.WriteField("session", `{"voice":"alloy"}`)
	_ = multipartWriter.Close()
	request := httptest.NewRequest(http.MethodPost, "/v1/live", &inbound)
	request.Header.Set("Content-Type", multipartWriter.FormDataContentType())
	request.Header.Set("OpenAI-Alpha", "quicksilver=v2")
	request.Header.Set("Cookie", "must-not-forward")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusCreated || response.Body.String() != "answer-sdp" || outcome != http.StatusCreated {
		t.Fatalf("response=%d %q outcome=%d", response.Code, response.Body.String(), outcome)
	}
	if alpha != "quicksilver=v2" || !strings.Contains(upstreamBody, `"sdp":"offer"`) || strings.Contains(upstreamBody, "must-not-forward") {
		t.Fatalf("alpha=%q body=%s", alpha, upstreamBody)
	}
	if response.Header().Get("Set-Cookie") != "" || response.Header().Get("Location") != "/v1/live/call_1" {
		t.Fatalf("headers=%v", response.Header())
	}
}

func TestLiveHandlerMapsRequestOverflowAndTimeout(t *testing.T) {
	handler := &LiveHandler{Resolve: func(context.Context, http.Header) (LiveRelayTarget, error) {
		return LiveRelayTarget{ProviderBaseURL: "https://example.invalid/v1", Keyed: true}, nil
	}, Client: roundTripDoer(func(request *http.Request) (*http.Response, error) {
		<-request.Context().Done()
		return nil, request.Context().Err()
	}), RequestLimit: 4, Timeout: 5 * time.Millisecond}
	overflow := httptest.NewRecorder()
	handler.ServeHTTP(overflow, httptest.NewRequest(http.MethodPost, "/v1/live", strings.NewReader("12345")))
	if overflow.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("overflow=%d %s", overflow.Code, overflow.Body.String())
	}
	timed := httptest.NewRecorder()
	handler.ServeHTTP(timed, httptest.NewRequest(http.MethodPost, "/v1/live", strings.NewReader("1234")))
	if timed.Code != http.StatusGatewayTimeout {
		t.Fatalf("timeout=%d %s", timed.Code, timed.Body.String())
	}
}

type roundTripDoer func(*http.Request) (*http.Response, error)

func (do roundTripDoer) Do(request *http.Request) (*http.Response, error) { return do(request) }

type fakeLiveSocket struct {
	receive chan LiveFrame
	sent    chan LiveFrame
	closed  chan struct{}
	once    sync.Once
}

func newFakeLiveSocket() *fakeLiveSocket {
	return &fakeLiveSocket{receive: make(chan LiveFrame, 4), sent: make(chan LiveFrame, 4), closed: make(chan struct{})}
}

func (socket *fakeLiveSocket) Receive(ctx context.Context) (LiveFrame, error) {
	select {
	case frame, ok := <-socket.receive:
		if !ok {
			return LiveFrame{}, io.EOF
		}
		return frame, nil
	case <-socket.closed:
		return LiveFrame{}, io.EOF
	case <-ctx.Done():
		return LiveFrame{}, ctx.Err()
	}
}

func (socket *fakeLiveSocket) Send(ctx context.Context, frame LiveFrame) error {
	select {
	case socket.sent <- frame:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (socket *fakeLiveSocket) Close(error) error {
	socket.once.Do(func() { close(socket.closed) })
	return nil
}

func TestRelayLiveSidebandPreservesTextAndLargeBinaryBytes(t *testing.T) {
	client, upstream := newFakeLiveSocket(), newFakeLiveSocket()
	textPayload := []byte("안녕하세요, live")
	binaryPayload := bytes.Repeat([]byte{0x00, 0xff, 0x7f, 0x80}, 330_000)
	client.receive <- LiveFrame{Kind: LiveFrameText, Payload: textPayload}
	upstream.receive <- LiveFrame{Kind: LiveFrameBinary, Payload: binaryPayload}
	var metadata []LiveFrameMetadata
	var metadataMu sync.Mutex
	done := make(chan error, 1)
	go func() {
		done <- RelayLiveSideband(context.Background(), client, upstream, func(value LiveFrameMetadata) {
			metadataMu.Lock()
			metadata = append(metadata, value)
			metadataMu.Unlock()
		})
	}()
	select {
	case frame := <-upstream.sent:
		if frame.Kind != LiveFrameText || !bytes.Equal(frame.Payload, textPayload) {
			t.Fatalf("upstream frame mismatch kind=%d bytes=%d", frame.Kind, len(frame.Payload))
		}
	case <-time.After(time.Second):
		t.Fatal("client-to-upstream frame not relayed")
	}
	select {
	case frame := <-client.sent:
		if frame.Kind != LiveFrameBinary || !bytes.Equal(frame.Payload, binaryPayload) {
			t.Fatalf("client frame mismatch kind=%d bytes=%d", frame.Kind, len(frame.Payload))
		}
	case <-time.After(time.Second):
		t.Fatal("upstream-to-client frame not relayed")
	}
	close(client.receive)
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("relay close error=%v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("sideband relay did not stop")
	}
	metadataMu.Lock()
	defer metadataMu.Unlock()
	if len(metadata) != 2 || metadata[0].Bytes == 0 || metadata[1].Bytes == 0 {
		t.Fatalf("metadata=%#v", metadata)
	}
}

func TestResolveLiveSidebandPlanDoesNotForwardAdmissionHeaders(t *testing.T) {
	incoming := make(http.Header)
	incoming.Set("OpenAI-Alpha", "quicksilver=v2")
	incoming.Set("X-OpenCodex-API-Key", "proxy-secret")
	incoming.Set("Authorization", "Bearer caller")
	plan, err := ResolveLiveSidebandPlan(LiveRelayTarget{
		ProviderBaseURL: "https://api.openai.com/v1",
		Headers:         http.Header{"Authorization": {"Bearer upstream"}, "ChatGPT-Account-Id": {"acct"}},
	}, LiveSidebandTarget{Style: LiveRealtimeQuery, CallID: "call_1"}, incoming)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Headers.Get("Authorization") != "Bearer upstream" || plan.Headers.Get("OpenAI-Alpha") != "quicksilver=v2" || plan.Headers.Get("X-OpenCodex-API-Key") != "" {
		t.Fatalf("headers=%v", plan.Headers)
	}
}
