package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/images"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

// imageBridgeAdapter replays a scripted turn per upstream call, so the loop can
// be driven without spending anything.
type imageBridgeAdapter struct {
	endpoint string
	turns    *atomic.Int32
	seen     *[]([]types.Tool)
}

func (a imageBridgeAdapter) BuildRequest(ctx context.Context, request *types.NormalizedRequest) (*http.Request, error) {
	if a.seen != nil {
		*a.seen = append(*a.seen, append([]types.Tool(nil), request.Context.Tools...))
	}
	return http.NewRequestWithContext(ctx, http.MethodPost, a.endpoint, strings.NewReader(`{}`))
}

func (a imageBridgeAdapter) ParseStream(_ context.Context, body io.ReadCloser) <-chan types.AdapterEvent {
	defer body.Close()
	out := make(chan types.AdapterEvent, 4)
	if a.turns.Add(1) == 1 {
		out <- types.AdapterEvent{Type: types.EventToolCall, ToolCall: &types.ToolCall{
			ID: "call_1", Name: "image_gen", Arguments: json.RawMessage(`{"prompt":"a cat"}`)}}
		out <- types.AdapterEvent{Type: types.EventDone, Usage: &types.Usage{InputTokens: 10, OutputTokens: 5}}
	} else {
		out <- types.AdapterEvent{Type: types.EventTextDelta, Text: "here is your image"}
		out <- types.AdapterEvent{Type: types.EventDone, Usage: &types.Usage{InputTokens: 20, OutputTokens: 7}}
	}
	close(out)
	return out
}

func (a imageBridgeAdapter) ParseUnary(context.Context, []byte) ([]types.AdapterEvent, error) {
	return []types.AdapterEvent{{Type: types.EventDone}}, nil
}

func imageBridgeCore(t *testing.T, factory ImageBridgeFactory, maxRounds int) (*ResponsesCore, *atomic.Int32, *[]([]types.Tool)) {
	t.Helper()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(upstream.Close)
	turns := &atomic.Int32{}
	seen := &[]([]types.Tool){}
	core := NewResponsesCore(ResponsesCoreConfig{
		Registry: coreRegistry{endpoint: upstream.URL},
		ResolveAdapter: func(_ *types.ResolvedModel, transport *types.Transport, _ *types.AuthContext, _ http.Header) (types.Adapter, error) {
			return imageBridgeAdapter{endpoint: transport.BaseURL, turns: turns, seen: seen}, nil
		},
		ImageBridge: factory, ImageMaxRounds: maxRounds,
	})
	return core, turns, seen
}

func armedFactory(fulfilled *atomic.Int32) ImageBridgeFactory {
	return func(*types.NormalizedRequest, string) (images.Plan, images.Fulfiller, bool) {
		return images.Plan{Model: "m", ToolNames: []string{"image_gen", "image_generation"}},
			func(context.Context, images.ImageCall) images.ImageCallResult {
				fulfilled.Add(1)
				return images.ImageCallResult{OK: true, Model: "m", Prompt: "a cat", Path: "/a.png", Files: []string{"/a.png"}, Count: 1}
			}, true
	}
}

const imageToolBody = `{"model":"public","stream":true,"tools":[{"type":"image_generation"}],"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"draw a cat"}]}]}`

// A compaction turn carries a compaction_trigger input item. It still declares
// the image tool, which is exactly why the exclusion is needed.
const compactionImageToolBody = `{"model":"public","stream":true,"tools":[{"type":"image_generation"}],"input":[{"type":"compaction_trigger"},{"type":"message","role":"user","content":[{"type":"input_text","text":"draw a cat"}]}]}`

// The whole reason this slice exists: five earlier implementations in this port
// shipped with no production caller, and my own first attempt at this wiring was
// dead code. This drives a real HTTP request all the way through.
func TestARealResponsesRequestReachesTheImageBridge(t *testing.T) {
	fulfilled := &atomic.Int32{}
	core, turns, seen := imageBridgeCore(t, armedFactory(fulfilled), 3)

	response := httptest.NewRecorder()
	core.ServeHTTP(response, loopbackRequest(http.MethodPost, "/v1/responses", strings.NewReader(imageToolBody)))

	if fulfilled.Load() != 1 {
		t.Fatalf("the bridge never fulfilled a call: %d", fulfilled.Load())
	}
	if turns.Load() != 2 {
		t.Fatalf("upstream turns = %d, want the image turn plus the follow-up", turns.Load())
	}
	body := response.Body.String()
	if !strings.Contains(body, "here is your image") {
		t.Fatalf("the client never received the model's answer: %s", body)
	}
	// The synthetic call is fulfilled locally and must never be shown.
	if strings.Contains(body, "image_gen") {
		t.Fatalf("the synthetic call leaked to the client: %s", body)
	}
	// The hosted declaration is REPLACED by the synthetic tool, not joined by
	// it: two names for the same thing would let the hosted one be relayed
	// upstream where this proxy cannot fulfil it.
	if len(*seen) == 0 {
		t.Fatal("no upstream request was built")
	}
	names := []string{}
	for _, tool := range (*seen)[0] {
		names = append(names, tool.Name)
	}
	if len(names) != 1 || names[0] != images.ImageGenToolName {
		t.Fatalf("the first upstream turn offered %v", names)
	}
}

// Every alias the plan knows must be replaced, not joined. A hosted
// image_generation entry left beside the synthetic tool gives the model two
// names for the same capability, and the hosted one is relayed upstream where
// this proxy cannot fulfil it — so the user's image silently never arrives.
func TestEveryImageAliasIsReplacedByTheSyntheticTool(t *testing.T) {
	fulfilled := &atomic.Int32{}
	core, _, seen := imageBridgeCore(t, armedFactory(fulfilled), 3)

	// Three shapes at once: the hosted declaration, a plan-known alias, and an
	// unrelated tool that must survive.
	body := `{"model":"public","stream":true,"tools":[` +
		`{"type":"image_generation"},` +
		`{"type":"function","name":"image_generation","parameters":{"type":"object"}},` +
		`{"type":"function","name":"shell","parameters":{"type":"object"}}` +
		`],"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"draw a cat"}]}]}`
	core.ServeHTTP(httptest.NewRecorder(), loopbackRequest(http.MethodPost, "/v1/responses", strings.NewReader(body)))

	if len(*seen) == 0 {
		t.Fatal("no upstream request was built")
	}
	names := []string{}
	for _, tool := range (*seen)[0] {
		names = append(names, tool.Name)
	}
	if len(names) != 2 || names[0] != "shell" || names[1] != images.ImageGenToolName {
		t.Fatalf("the upstream turn offered %v, want the unrelated tool plus exactly one synthetic image tool", names)
	}
}

// Nothing may reach the bridge without the operator opting in.
func TestWithoutAFactoryTheRequestTakesTheNormalPath(t *testing.T) {
	core, turns, _ := imageBridgeCore(t, nil, 3)
	response := httptest.NewRecorder()
	core.ServeHTTP(response, loopbackRequest(http.MethodPost, "/v1/responses", strings.NewReader(imageToolBody)))
	// Exactly one upstream turn: the ordinary forward, not a bridge loop.
	if turns.Load() != 1 {
		t.Fatalf("upstream turns = %d, want the single normal forward", turns.Load())
	}
}

// A declining factory is the last gate before spending.
func TestADecliningFactoryTakesTheNormalPath(t *testing.T) {
	core, turns, _ := imageBridgeCore(t, func(*types.NormalizedRequest, string) (images.Plan, images.Fulfiller, bool) {
		return images.Plan{}, nil, false
	}, 3)
	response := httptest.NewRecorder()
	core.ServeHTTP(response, loopbackRequest(http.MethodPost, "/v1/responses", strings.NewReader(imageToolBody)))
	if turns.Load() != 1 {
		t.Fatalf("upstream turns = %d, want the single normal forward", turns.Load())
	}
}

// Measured against the oracle by running it: response.created reaches the
// client BEFORE the first paid image call even starts. A real multi-round image
// turn takes tens of seconds, and a client that has seen nothing by then cannot
// tell a working proxy from a hung one.
func TestTheClientSeesTheStreamOpenBeforeTheFirstPaidCall(t *testing.T) {
	opened := make(chan struct{})
	fulfilling := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()
	turns := &atomic.Int32{}
	core := NewResponsesCore(ResponsesCoreConfig{
		Registry: coreRegistry{endpoint: upstream.URL},
		ResolveAdapter: func(_ *types.ResolvedModel, transport *types.Transport, _ *types.AuthContext, _ http.Header) (types.Adapter, error) {
			return imageBridgeAdapter{endpoint: transport.BaseURL, turns: turns}, nil
		},
		ImageMaxRounds: 3,
		ImageBridge: func(*types.NormalizedRequest, string) (images.Plan, images.Fulfiller, bool) {
			return images.Plan{Model: "m", ToolNames: []string{"image_gen"}},
				func(context.Context, images.ImageCall) images.ImageCallResult {
					// Stand in for a real paid call, which is slow. Block until
					// the observer confirms the client already has bytes.
					close(fulfilling)
					<-opened
					return images.ImageCallResult{OK: true, Model: "m", Files: []string{"/a.png"}, Count: 1}
				}, true
		},
	})

	recorder := &flushCountingRecorder{ResponseRecorder: httptest.NewRecorder(), sawCreated: make(chan struct{})}
	done := make(chan struct{})
	go func() {
		defer close(done)
		core.ServeHTTP(recorder, loopbackRequest(http.MethodPost, "/v1/responses", strings.NewReader(imageToolBody)))
	}()

	// The paid call has started. Check WITHOUT waiting: allowing any grace
	// period here would accept "the client got it eventually", which is the
	// bug. The guarantee is that response.created is on the wire BEFORE a paid
	// call can begin.
	<-fulfilling
	select {
	case <-recorder.sawCreated:
	default:
		close(opened)
		<-done
		t.Fatal("a paid call started while the client had not yet received response.created")
	}
	// And it must have been FLUSHED, or it is still in the server's buffer and
	// the client has nothing regardless of what was written.
	if recorder.flushCount() == 0 {
		close(opened)
		<-done
		t.Fatal("response.created was written but never flushed; the client still has nothing")
	}
	close(opened)
	<-done

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d", recorder.Code)
	}
	if !strings.Contains(recorder.Body.String(), "response.created") {
		t.Fatalf("the stream never opened: %s", recorder.Body.String())
	}
}

// flushCountingRecorder reports the moment the handler committed a status, so a
// test can observe ordering rather than only the final bytes.
type flushCountingRecorder struct {
	*httptest.ResponseRecorder
	once       sync.Once
	created    sync.Once
	sawCreated chan struct{}
	mu         sync.Mutex
	flushes    int
}

// Flush is what actually pushes bytes to a real client. httptest's recorder
// records the call, which is the only way to tell a delivered frame from one
// sitting in a buffer.
func (r *flushCountingRecorder) Flush() {
	r.mu.Lock()
	r.flushes++
	r.mu.Unlock()
	r.ResponseRecorder.Flush()
}

func (r *flushCountingRecorder) flushCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.flushes
}

// Only a written response.created counts. A committed status is not evidence
// the client has anything to read.
//
// The first write is deliberately SLOW, which opens the scheduling window the
// ordering guarantee has to survive: without it the loop could reach a paid
// call while response.created is still being written.
func (r *flushCountingRecorder) Write(payload []byte) (int, error) {
	first := false
	r.once.Do(func() { first = true })
	if first {
		time.Sleep(50 * time.Millisecond)
	}
	n, err := r.ResponseRecorder.Write(payload)
	if strings.Contains(string(payload), "response.created") {
		r.created.Do(func() { close(r.sawCreated) })
	}
	return n, err
}

// A bridged answer must be rememberable. Without this the client gets a resp_*
// id that was never stored, and the very next turn silently loses the whole
// conversation — the worst kind of failure, because the image itself worked.
func TestABridgedAnswerCanBeContinuedWithPreviousResponseID(t *testing.T) {
	state := NewResponseStateStore("")
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()
	turns := &atomic.Int32{}
	fulfilled := &atomic.Int32{}
	core := NewResponsesCore(ResponsesCoreConfig{
		Registry: coreRegistry{endpoint: upstream.URL}, ResponseState: state,
		ResolveAdapter: func(_ *types.ResolvedModel, transport *types.Transport, _ *types.AuthContext, _ http.Header) (types.Adapter, error) {
			return imageBridgeAdapter{endpoint: transport.BaseURL, turns: turns}, nil
		},
		ImageBridge: armedFactory(fulfilled), ImageMaxRounds: 3,
	})

	response := httptest.NewRecorder()
	core.ServeHTTP(response, loopbackRequest(http.MethodPost, "/v1/responses", strings.NewReader(imageToolBody)))
	if fulfilled.Load() != 1 {
		t.Fatalf("the turn was not bridged: %d", fulfilled.Load())
	}

	responseID := completedResponseID(t, response.Body.String())
	// The id the client was handed must resolve, or continuation is broken.
	expanded, _, _, ok := state.Expand(map[string]any{"previous_response_id": responseID, "input": "next"})
	if !ok {
		t.Fatalf("the bridged response id %q was never stored; the next turn would lose the conversation", responseID)
	}
	if expanded == nil {
		t.Fatal("expansion produced no body")
	}
}

// A request that answered the client successfully must not be logged as a
// failure. Without the observer the bridged turn records no terminal, and the
// log says 502 while the user got their image.
func TestASuccessfulBridgedTurnIsNotLoggedAsAFailure(t *testing.T) {
	logs := NewRequestLogStore(16, nil)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()
	turns := &atomic.Int32{}
	fulfilled := &atomic.Int32{}
	core := NewResponsesCore(ResponsesCoreConfig{
		Registry: coreRegistry{endpoint: upstream.URL}, RequestLogs: logs,
		ResolveAdapter: func(_ *types.ResolvedModel, transport *types.Transport, _ *types.AuthContext, _ http.Header) (types.Adapter, error) {
			return imageBridgeAdapter{endpoint: transport.BaseURL, turns: turns}, nil
		},
		ImageBridge: armedFactory(fulfilled), ImageMaxRounds: 3,
	})

	response := httptest.NewRecorder()
	core.ServeHTTP(response, loopbackRequest(http.MethodPost, "/v1/responses", strings.NewReader(imageToolBody)))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "response.completed") {
		t.Fatalf("the client did not get a completed response: %d %s", response.Code, response.Body.String())
	}

	entries := logs.Entries()
	if len(entries) == 0 {
		t.Fatal("no request was logged")
	}
	last := entries[len(entries)-1]
	if last.Status != http.StatusOK {
		t.Fatalf("a successful bridged turn was logged as %d", last.Status)
	}
}

// completedResponseID pulls the id the client was actually handed.
func completedResponseID(t *testing.T, body string) string {
	t.Helper()
	for _, line := range strings.Split(body, "\n") {
		if !strings.HasPrefix(line, "data: {") || !strings.Contains(line, `"response"`) {
			continue
		}
		var event map[string]any
		if json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &event) != nil {
			continue
		}
		if response, _ := event["response"].(map[string]any); response["status"] == "completed" {
			if id, _ := response["id"].(string); id != "" {
				return id
			}
		}
	}
	t.Fatalf("no completed response id in: %s", body)
	return ""
}

// Usage must be recorded for a bridged turn at all, and it must describe the
// route that produced the answer. A combo failover inside the loop moves the
// route, and the record is written when the terminal event arrives — so the
// rebinding has to happen at that moment, not before the loop starts.
func TestUsageIsRecordedAndReboundToTheAnsweringRoute(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()
	turns := &atomic.Int32{}
	fulfilled := &atomic.Int32{}
	recorder := &capturingUsageRecorder{}
	core := NewResponsesCore(ResponsesCoreConfig{
		Registry: coreRegistry{endpoint: upstream.URL}, Recorder: recorder,
		ResolveAdapter: func(_ *types.ResolvedModel, transport *types.Transport, _ *types.AuthContext, _ http.Header) (types.Adapter, error) {
			return imageBridgeAdapter{endpoint: transport.BaseURL, turns: turns}, nil
		},
		ImageBridge: armedFactory(fulfilled), ImageMaxRounds: 3,
	})

	core.ServeHTTP(httptest.NewRecorder(), loopbackRequest(http.MethodPost, "/v1/responses", strings.NewReader(imageToolBody)))
	if fulfilled.Load() != 1 {
		t.Fatalf("the turn was not bridged: %d", fulfilled.Load())
	}
	record := recorder.last()
	if record == nil {
		t.Fatal("no usage was recorded for a bridged turn; the operator sees the spend as free")
	}
	if record.Provider != "provider" || record.Model != "wire" {
		t.Fatalf("usage route = %s/%s", record.Provider, record.Model)
	}
	if record.Usage.InputTokens == 0 && record.Usage.OutputTokens == 0 {
		t.Fatalf("usage carried no tokens: %#v", record.Usage)
	}
}

// The rebinding must be WIRED, not merely correct. A key rotation inside
// forward changes the account that served the turn, and the record is written
// when the terminal event arrives — so a record captured before the loop names
// the account that failed rather than the one that answered.
func TestUsageFollowsAKeyRotationThatHappenedInsideTheLoop(t *testing.T) {
	var upstreamCalls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		// The first attempt is rate limited, forcing the rotation; everything
		// after it succeeds.
		if upstreamCalls.Add(1) == 1 {
			w.Header().Set("Retry-After", "1")
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = io.WriteString(w, `{"error":{"message":"rate limited"}}`)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	auth := &rotatingAuth{}
	auth.account.Store("acct-first")
	turns := &atomic.Int32{}
	fulfilled := &atomic.Int32{}
	recorder := &capturingUsageRecorder{}
	core := NewResponsesCore(ResponsesCoreConfig{
		Registry: coreRegistry{endpoint: upstream.URL}, Auth: auth, Recorder: recorder,
		ResolveAdapter: func(_ *types.ResolvedModel, transport *types.Transport, _ *types.AuthContext, _ http.Header) (types.Adapter, error) {
			return imageBridgeAdapter{endpoint: transport.BaseURL, turns: turns}, nil
		},
		RotateAPIKeyOn429: func(string, string, string) (string, bool) {
			auth.account.Store("acct-second")
			return "rotated-key", true
		},
		ImageBridge: armedFactory(fulfilled), ImageMaxRounds: 3,
	})

	core.ServeHTTP(httptest.NewRecorder(), loopbackRequest(http.MethodPost, "/v1/responses", strings.NewReader(imageToolBody)))
	if fulfilled.Load() != 1 {
		t.Fatalf("the turn was not bridged: %d", fulfilled.Load())
	}
	record := recorder.last()
	if record == nil {
		t.Fatal("no usage was recorded")
	}
	if record.AccountID != "acct-second" {
		t.Fatalf("usage was attributed to %q, but %q served the answer after the rotation", record.AccountID, "acct-second")
	}
}

type capturingUsageRecorder struct {
	mu      sync.Mutex
	records []types.UsageRecord
}

func (r *capturingUsageRecorder) Record(_ context.Context, record *types.UsageRecord) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.records = append(r.records, *record)
	return nil
}

func (r *capturingUsageRecorder) last() *types.UsageRecord {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.records) == 0 {
		return nil
	}
	return &r.records[len(r.records)-1]
}

// A request that never declared a hosted image tool must not be bridged, even
// with the feature on.
func TestARequestWithNoHostedImageToolIsNotBridged(t *testing.T) {
	fulfilled := &atomic.Int32{}
	core, turns, _ := imageBridgeCore(t, armedFactory(fulfilled), 3)
	response := httptest.NewRecorder()
	core.ServeHTTP(response, loopbackRequest(http.MethodPost, "/v1/responses",
		strings.NewReader(`{"model":"public","stream":true,"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}]}`)))
	if fulfilled.Load() != 0 || turns.Load() != 1 {
		t.Fatalf("fulfilled=%d turns=%d", fulfilled.Load(), turns.Load())
	}
}

// The bridge answers over SSE. A client that asked for JSON cannot be served
// that, so the refusal is explicit rather than a silently different shape.
func TestANonStreamingImageRequestIsRefused(t *testing.T) {
	fulfilled := &atomic.Int32{}
	core, turns, _ := imageBridgeCore(t, armedFactory(fulfilled), 3)
	response := httptest.NewRecorder()
	core.ServeHTTP(response, loopbackRequest(http.MethodPost, "/v1/responses",
		strings.NewReader(`{"model":"public","stream":false,"tools":[{"type":"image_generation"}],"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"draw"}]}]}`)))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", response.Code)
	}
	if !strings.Contains(response.Body.String(), "image bridge requires stream=true") {
		t.Fatalf("body = %s", response.Body.String())
	}
	// Refused BEFORE anything was spent.
	if turns.Load() != 0 || fulfilled.Load() != 0 {
		t.Fatalf("a refused request still spent: turns=%d fulfilled=%d", turns.Load(), fulfilled.Load())
	}
}

// Compaction clears tools but leaves the image declaration behind. Arming there
// would answer with an ordinary completion where the client expects a synthetic
// compaction item (#424).
//
// Driven through the real dispatch rather than the predicate, so the exclusion
// is proven where it matters: no fulfilment, and exactly one ordinary forward.
func TestARoutedCompactionTurnIsNotBridged(t *testing.T) {
	fulfilled := &atomic.Int32{}
	core, turns, _ := imageBridgeCore(t, armedFactory(fulfilled), 3)
	response := httptest.NewRecorder()
	core.ServeHTTP(response, loopbackRequest(http.MethodPost, "/v1/responses",
		strings.NewReader(compactionImageToolBody)))
	if fulfilled.Load() != 0 {
		t.Fatalf("a compaction turn was bridged and paid for: %d", fulfilled.Load())
	}
	if turns.Load() != 1 {
		t.Fatalf("upstream turns = %d, want the single normal forward", turns.Load())
	}
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}
}

// The same turn WITHOUT the compaction marker must be bridged, or the test
// above would pass for the wrong reason — a body the parser simply rejected.
func TestTheSameTurnWithoutCompactionIsBridged(t *testing.T) {
	fulfilled := &atomic.Int32{}
	core, _, _ := imageBridgeCore(t, armedFactory(fulfilled), 3)
	body := strings.Replace(compactionImageToolBody, `{"type":"compaction_trigger"},`, "", 1)
	if body == compactionImageToolBody {
		t.Fatal("the compaction marker was not removed; the control case is not a control")
	}
	core.ServeHTTP(httptest.NewRecorder(), loopbackRequest(http.MethodPost, "/v1/responses", strings.NewReader(body)))
	if fulfilled.Load() != 1 {
		t.Fatalf("the control turn was not bridged: %d", fulfilled.Load())
	}
}

// The canonical ChatGPT backend compacts natively and never routes a compaction
// turn through the sidecars, so it must not be excluded by this check.
func TestTheCanonicalBackendIsNotTreatedAsRoutedCompaction(t *testing.T) {
	core := NewResponsesCore(ResponsesCoreConfig{
		Registry: coreRegistry{}, ResolveAdapter: func(*types.ResolvedModel, *types.Transport, *types.AuthContext, http.Header) (types.Adapter, error) {
			return nil, nil
		},
		CanonicalOpenAIRoute: func(*types.ResolvedModel) bool { return true },
	})
	if core.routedCompaction(&types.NormalizedRequest{CompactionRequest: true}, nil) {
		t.Fatal("the canonical backend's compaction turn was excluded as routed")
	}
}

// The call site cannot be reached from every angle by a behaviour test, and its
// removal is exactly the failure this port has shipped five times. Pin it, and
// pin that it comes BEFORE forward — after it, a paid upstream request has
// already gone out.
func TestTheBridgeIsDispatchedBeforeTheNormalForward(t *testing.T) {
	source, err := os.ReadFile("responses_core_port.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(source)
	dispatch := strings.Index(text, "core.runImageBridge(ctx, cancel, w, request.Header, parsed")
	if dispatch < 0 {
		t.Fatal("ServeHTTP no longer dispatches the image bridge; the feature would be unreachable")
	}
	forward := strings.Index(text, "adapter, response, auth, resolved, pick, err := core.forward(")
	if forward < 0 {
		t.Fatal("the normal forward call could not be located")
	}
	if dispatch > forward {
		t.Fatal("the bridge is dispatched after forward; a paid upstream turn would already have been spent")
	}
}

// A stalled upstream must not hang the handler. Without OnCancel the stream
// returns on its stall timeout while the loop is still blocked, and the handler
// waits forever on a channel that can never close — one wedged provider would
// leak a goroutine and a connection per request.
func TestAStalledBridgeTurnDoesNotHangTheHandler(t *testing.T) {
	release := make(chan struct{})
	defer close(release)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()
	turns := &atomic.Int32{}
	stall := 0.05
	core := NewResponsesCore(ResponsesCoreConfig{
		Registry: coreRegistry{endpoint: upstream.URL}, StallTimeout: &stall,
		ResolveAdapter: func(_ *types.ResolvedModel, transport *types.Transport, _ *types.AuthContext, _ http.Header) (types.Adapter, error) {
			return imageBridgeAdapter{endpoint: transport.BaseURL, turns: turns}, nil
		},
		ImageMaxRounds: 3,
		ImageBridge: func(*types.NormalizedRequest, string) (images.Plan, images.Fulfiller, bool) {
			return images.Plan{Model: "m", ToolNames: []string{"image_gen"}},
				func(ctx context.Context, _ images.ImageCall) images.ImageCallResult {
					// A paid call that never answers, which is what a wedged
					// provider looks like from here.
					select {
					case <-release:
					case <-ctx.Done():
					}
					return images.ImageCallResult{OK: true, Model: "m", Files: []string{"/a.png"}, Count: 1}
				}, true
		},
	})

	done := make(chan struct{})
	go func() {
		defer close(done)
		core.ServeHTTP(httptest.NewRecorder(), loopbackRequest(http.MethodPost, "/v1/responses", strings.NewReader(imageToolBody)))
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the handler never returned after the stall timeout; it is deadlocked on the loop")
	}
}

// Cursor and Kiro attach a conversation id to their terminal event. Dropping it
// makes the next turn start a NEW upstream conversation while looking like a
// continuation — the model loses its context and nobody sees an error.
func TestABridgedAnswerCarriesProviderContinuationState(t *testing.T) {
	state := NewResponseStateStore("")
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()
	turns := &atomic.Int32{}
	fulfilled := &atomic.Int32{}
	core := NewResponsesCore(ResponsesCoreConfig{
		Registry: coreRegistry{endpoint: upstream.URL}, ResponseState: state,
		ResolveAdapter: func(_ *types.ResolvedModel, transport *types.Transport, _ *types.AuthContext, _ http.Header) (types.Adapter, error) {
			return providerStateAdapter{imageBridgeAdapter{endpoint: transport.BaseURL, turns: turns}}, nil
		},
		ImageBridge: armedFactory(fulfilled), ImageMaxRounds: 3,
	})

	response := httptest.NewRecorder()
	core.ServeHTTP(response, loopbackRequest(http.MethodPost, "/v1/responses", strings.NewReader(imageToolBody)))
	if fulfilled.Load() != 1 {
		t.Fatalf("the turn was not bridged: %d", fulfilled.Load())
	}
	responseID := completedResponseID(t, response.Body.String())
	_, _, providerState, ok := state.Expand(map[string]any{"previous_response_id": responseID, "input": "next"})
	if !ok {
		t.Fatal("the bridged response was not stored")
	}
	cursor, _ := providerState["cursor"]
	if cursor == nil || cursor["conversationId"] != "conv-42" {
		t.Fatalf("provider continuation state was dropped: %#v", providerState)
	}
}

// providerStateAdapter attaches continuation state to its terminal event, the
// way Cursor and Kiro do.
type providerStateAdapter struct{ imageBridgeAdapter }

func (a providerStateAdapter) ParseStream(ctx context.Context, body io.ReadCloser) <-chan types.AdapterEvent {
	source := a.imageBridgeAdapter.ParseStream(ctx, body)
	out := make(chan types.AdapterEvent, 4)
	go func() {
		defer close(out)
		for event := range source {
			if event.Type == types.EventDone {
				event.ProviderState = types.ProviderContinuationState{"cursor": {"conversationId": "conv-42"}}
			}
			out <- event
		}
	}()
	return out
}
