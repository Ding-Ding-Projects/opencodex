package cursor

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

func TestNewAdapterBuildsProductionConnectRequest(t *testing.T) {
	adapter, err := NewAdapter(AdapterConfig{
		BaseURL: "https://cursor.example/base/",
		Token:   "cursor-token",
		Headers: map[string]string{"X-Test": "value"},
	})
	if err != nil {
		t.Fatal(err)
	}
	request, err := adapter.BuildRequest(context.Background(), cursorNormalizedRequest("hello"))
	if err != nil {
		t.Fatal(err)
	}
	defer request.Body.Close()
	defer adapter.releaseTurn(adapter.currentTurn())
	if got := request.URL.String(); got != "https://cursor.example/base/agent.v1.AgentService/Run" {
		t.Fatalf("request URL = %q", got)
	}
	for name, want := range map[string]string{
		"Content-Type":             "application/connect+proto",
		"Connect-Protocol-Version": "1",
		"Authorization":            "Bearer cursor-token",
		"X-Cursor-Client-Type":     "cli",
		"X-Test":                   "value",
	} {
		if got := request.Header.Get(name); got != want {
			t.Errorf("%s = %q, want %q", name, got, want)
		}
	}
	frame, err := ReadFrame(request.Body, DefaultMaxFrameSize)
	if err != nil {
		t.Fatal(err)
	}
	fields, err := parseFields(frame.Payload)
	if err != nil {
		t.Fatal(err)
	}
	if len(fields) != 1 || fields[0].Number != 1 {
		t.Fatalf("initial client frame = %#v", fields)
	}
}

func TestNewIDProducesRFC4122Version4Shape(t *testing.T) {
	id := newID()
	if len(id) != 36 || id[8] != '-' || id[13] != '-' || id[18] != '-' || id[23] != '-' {
		t.Fatalf("newID() = %q", id)
	}
	if id[14] != '4' || !strings.ContainsRune("89ab", rune(id[19])) {
		t.Fatalf("newID() version or variant bits = %q", id)
	}
}

func TestAdapterParseStreamMapsFramesAndReconnectsNextTurn(t *testing.T) {
	adapter, err := NewAdapter(AdapterConfig{
		BaseURL:           "https://cursor.example",
		Token:             "cursor-token",
		HeartbeatInterval: time.Hour,
	})
	if err != nil {
		t.Fatal(err)
	}

	firstRequest, err := adapter.BuildRequest(context.Background(), cursorNormalizedRequest("first"))
	if err != nil {
		t.Fatal(err)
	}
	initial, err := ReadFrame(firstRequest.Body, DefaultMaxFrameSize)
	if err != nil || len(initial.Payload) == 0 {
		t.Fatalf("initial frame = %#v, %v", initial, err)
	}

	textUpdate := appendMessage(nil, 1, appendString(nil, 1, "hello"))
	terminal := appendMessage(nil, 1, appendMessage(nil, 14, nil))
	streamBody := connectFrames(t,
		ConnectFrame{Payload: appendMessage(nil, 1, textUpdate)},
		ConnectFrame{Payload: terminal},
		ConnectFrame{Flags: ConnectFlagEndStream, Payload: []byte(`{}`)},
	)
	events := collectCursorAdapterEvents(adapter.ParseStream(context.Background(), io.NopCloser(bytes.NewReader(streamBody))))
	if len(events) != 2 || events[0].Type != types.EventTextDelta || events[0].Text != "hello" || events[1].Type != types.EventDone {
		t.Fatalf("events = %#v", events)
	}
	_ = firstRequest.Body.Close()

	secondRequest, err := adapter.BuildRequest(context.Background(), cursorNormalizedRequest("second"))
	if err != nil {
		t.Fatalf("adapter did not open a fresh stream after terminal turn: %v", err)
	}
	defer secondRequest.Body.Close()
	defer adapter.releaseTurn(adapter.currentTurn())
	secondInitial, err := ReadFrame(secondRequest.Body, DefaultMaxFrameSize)
	if err != nil || len(secondInitial.Payload) == 0 {
		t.Fatalf("second initial frame = %#v, %v", secondInitial, err)
	}
	if firstRequest.Header.Get("X-Session-Id") != secondRequest.Header.Get("X-Session-Id") {
		t.Fatal("stable Cursor session id changed across transport reconnect")
	}
	if firstRequest.Header.Get("X-Request-Id") == secondRequest.Header.Get("X-Request-Id") {
		t.Fatal("Cursor request id was reused across transport reconnect")
	}
}

func TestAdapterParseStreamRejectsTruncatedAndCompressedFrames(t *testing.T) {
	for _, test := range []struct {
		name string
		body []byte
		want string
	}{
		{name: "truncated payload", body: []byte{0, 0, 0, 0, 5, 1, 2}, want: "unexpected EOF"},
		{name: "compressed", body: connectFrames(t, ConnectFrame{Flags: ConnectFlagCompressed, Payload: []byte{1}}), want: "compressed Connect frames"},
	} {
		t.Run(test.name, func(t *testing.T) {
			adapter, err := NewAdapter(AdapterConfig{BaseURL: "https://cursor.example", Token: "token", HeartbeatInterval: time.Hour})
			if err != nil {
				t.Fatal(err)
			}
			request, err := adapter.BuildRequest(context.Background(), cursorNormalizedRequest("hello"))
			if err != nil {
				t.Fatal(err)
			}
			defer request.Body.Close()
			if _, err := ReadFrame(request.Body, DefaultMaxFrameSize); err != nil {
				t.Fatal(err)
			}
			events := collectCursorAdapterEvents(adapter.ParseStream(context.Background(), io.NopCloser(bytes.NewReader(test.body))))
			if len(events) != 1 || events[0].Type != types.EventError || !bytes.Contains([]byte(events[0].Error), []byte(test.want)) {
				t.Fatalf("events = %#v, want error containing %q", events, test.want)
			}
		})
	}
}

func TestAdapterParseStreamRejectsMissingAndOversizedFrames(t *testing.T) {
	oversized := make([]byte, 5)
	binary.BigEndian.PutUint32(oversized[1:], uint32(DefaultMaxFrameSize+1))
	for _, test := range []struct {
		name string
		body io.ReadCloser
		want string
	}{
		{name: "missing body", want: "no body"},
		{name: "empty body", body: io.NopCloser(bytes.NewReader(nil)), want: "unexpected EOF"},
		{name: "oversized frame", body: io.NopCloser(bytes.NewReader(oversized)), want: "exceeds limit"},
	} {
		t.Run(test.name, func(t *testing.T) {
			adapter, err := NewAdapter(AdapterConfig{BaseURL: "https://cursor.example", Token: "token", HeartbeatInterval: time.Hour})
			if err != nil {
				t.Fatal(err)
			}
			request, err := adapter.BuildRequest(context.Background(), cursorNormalizedRequest("hello"))
			if err != nil {
				t.Fatal(err)
			}
			defer request.Body.Close()
			events := collectCursorAdapterEvents(adapter.ParseStream(context.Background(), test.body))
			if len(events) != 1 || events[0].Type != types.EventError || !strings.Contains(events[0].Error, test.want) {
				t.Fatalf("events = %#v, want error containing %q", events, test.want)
			}
		})
	}
}

func TestAdapterIgnoresUnknownServerEventAndStillTerminates(t *testing.T) {
	adapter, err := NewAdapter(AdapterConfig{BaseURL: "https://cursor.example", Token: "token", HeartbeatInterval: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	request, err := adapter.BuildRequest(context.Background(), cursorNormalizedRequest("hello"))
	if err != nil {
		t.Fatal(err)
	}
	defer request.Body.Close()
	unknown := appendMessage(nil, 1, appendMessage(nil, 99, []byte("future")))
	terminal := appendMessage(nil, 1, appendMessage(nil, 14, nil))
	body := connectFrames(t,
		ConnectFrame{Payload: unknown},
		ConnectFrame{Payload: terminal},
		ConnectFrame{Flags: ConnectFlagEndStream, Payload: []byte(`{}`)},
	)
	events := collectCursorAdapterEvents(adapter.ParseStream(context.Background(), io.NopCloser(bytes.NewReader(body))))
	if len(events) != 1 || events[0].Type != types.EventDone {
		t.Fatalf("events = %#v", events)
	}
}

func TestAdapterBridgesResponsesClientToolAndFinalizesAfterGrace(t *testing.T) {
	adapter, err := NewAdapter(AdapterConfig{BaseURL: "https://cursor.example", Token: "token", HeartbeatInterval: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	normalized := cursorNormalizedRequest("read a file")
	normalized.Context.Tools = []types.Tool{{Namespace: "workspace", Name: "read_file", Parameters: map[string]any{"type": "object"}}}
	request, err := adapter.BuildRequest(context.Background(), normalized)
	if err != nil {
		t.Fatal(err)
	}
	defer request.Body.Close()
	turn := adapter.currentTurn()
	turn.run.ClientToolFinalizeGrace = 10 * time.Millisecond

	responseReader, responseWriter := io.Pipe()
	events := adapter.ParseStream(context.Background(), responseReader)
	value, _ := MarshalValue("README.md")
	entry := appendString(nil, 1, "path")
	entry = appendBytes(entry, 2, value)
	args := appendString(nil, 1, "workspace__read_file")
	args = appendMessage(args, 2, entry)
	args = appendString(args, 3, "call_1")
	args = appendString(args, 4, ResponsesToolProvider)
	args = appendString(args, 5, "workspace__read_file")
	exec := appendVarintField(nil, 1, 7)
	exec = appendMessage(exec, 11, args)
	exec = appendString(exec, 15, "exec_1")
	frame, err := EncodeFrame(ConnectFrame{Payload: appendMessage(nil, 2, exec)})
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		_, _ = responseWriter.Write(frame)
	}()

	first := <-events
	if first.Type != types.EventToolCall || first.ToolCall == nil || first.ToolCall.ID != "call_1" || first.ToolCall.Name != "workspace__read_file" {
		t.Fatalf("tool event = %#v", first)
	}
	select {
	case done := <-events:
		if done.Type != types.EventDone {
			t.Fatalf("terminal event = %#v", done)
		}
	case <-time.After(time.Second):
		t.Fatal("client tool bridge did not finalize after grace")
	}
	_ = responseWriter.Close()
	for range events {
	}
}

func TestAdapterConcurrentTurnAdmissionIsRaceSafe(t *testing.T) {
	adapter, err := NewAdapter(AdapterConfig{BaseURL: "https://cursor.example", Token: "token", HeartbeatInterval: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	const workers = 24
	start := make(chan struct{})
	results := make(chan *http.Request, workers)
	errors := make(chan error, workers)
	var wait sync.WaitGroup
	for index := 0; index < workers; index++ {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			<-start
			request, buildErr := adapter.BuildRequest(context.Background(), cursorNormalizedRequest(fmt.Sprintf("turn-%d", index)))
			results <- request
			errors <- buildErr
		}(index)
	}
	close(start)
	wait.Wait()
	close(results)
	close(errors)

	var admitted []*http.Request
	for request := range results {
		if request != nil {
			admitted = append(admitted, request)
		}
	}
	rejected := 0
	for err := range errors {
		if err != nil {
			if !strings.Contains(err.Error(), "already has an active turn") {
				t.Fatalf("unexpected admission error: %v", err)
			}
			rejected++
		}
	}
	if len(admitted) != 1 || rejected != workers-1 {
		t.Fatalf("admitted=%d rejected=%d", len(admitted), rejected)
	}
	_ = admitted[0].Body.Close()
	adapter.releaseTurn(adapter.currentTurn())
}

func TestAdapterCancellationClosesBlockedUpstreamBody(t *testing.T) {
	adapter, err := NewAdapter(AdapterConfig{BaseURL: "https://cursor.example", Token: "token", HeartbeatInterval: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	request, err := adapter.BuildRequest(context.Background(), cursorNormalizedRequest("hello"))
	if err != nil {
		t.Fatal(err)
	}
	defer request.Body.Close()
	ctx, cancel := context.WithCancel(context.Background())
	body := &cursorBlockingBody{closed: make(chan struct{})}
	events := adapter.ParseStream(ctx, body)
	cancel()
	for range events {
	}
	select {
	case <-body.closed:
	case <-time.After(time.Second):
		t.Fatal("context cancellation did not close Cursor upstream body")
	}
}

type cursorBlockingBody struct {
	once   sync.Once
	closed chan struct{}
}

func (body *cursorBlockingBody) Read([]byte) (int, error) {
	<-body.closed
	return 0, io.EOF
}

func (body *cursorBlockingBody) Close() error {
	body.once.Do(func() { close(body.closed) })
	return nil
}

func TestAdapterEmitsHeartbeatAndWritesInteractionReply(t *testing.T) {
	replied := make(chan []byte, 1)
	adapter, err := NewAdapter(AdapterConfig{
		BaseURL: "https://cursor.example", Token: "token", HeartbeatInterval: time.Hour,
		Interaction: func(_ context.Context, query []byte) ([]byte, error) {
			replied <- append([]byte(nil), query...)
			return appendMessage(nil, 6, appendVarintField(nil, 1, 9)), nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	request, err := adapter.BuildRequest(context.Background(), cursorNormalizedRequest("hello"))
	if err != nil {
		t.Fatal(err)
	}
	defer request.Body.Close()
	if _, err := ReadFrame(request.Body, DefaultMaxFrameSize); err != nil {
		t.Fatal(err)
	}

	query := appendVarintField(nil, 1, 9)
	serverQuery := appendMessage(nil, 7, query)
	terminal := appendMessage(nil, 1, appendMessage(nil, 14, nil))
	body := connectFrames(t,
		ConnectFrame{Payload: serverQuery},
		ConnectFrame{Payload: terminal},
		ConnectFrame{Flags: ConnectFlagEndStream, Payload: []byte(`{}`)},
	)
	eventsCh := adapter.ParseStream(context.Background(), io.NopCloser(bytes.NewReader(body)))
	replyFrame, err := ReadFrame(request.Body, DefaultMaxFrameSize)
	if err != nil {
		t.Fatal(err)
	}
	replyFields, err := parseFields(replyFrame.Payload)
	if err != nil {
		t.Fatal(err)
	}
	if len(replyFields) != 1 || replyFields[0].Number != 6 {
		t.Fatalf("interaction reply = %#v", replyFields)
	}
	if got := <-replied; !bytes.Equal(got, query) {
		t.Fatalf("handler query = %x, want %x", got, query)
	}
	events := collectCursorAdapterEvents(eventsCh)
	if len(events) != 2 || events[0].Type != types.EventHeartbeat || events[1].Type != types.EventDone {
		t.Fatalf("events = %#v", events)
	}
}

func cursorNormalizedRequest(text string) *types.NormalizedRequest {
	content, _ := json.Marshal(text)
	return &types.NormalizedRequest{
		ModelID: "cursor/gpt-5.6-sol",
		Stream:  true,
		Context: types.RequestContext{
			SystemPrompt: []string{"You are helpful."},
			Messages:     []types.Message{{Role: "user", Content: content}},
		},
	}
}

func connectFrames(t *testing.T, frames ...ConnectFrame) []byte {
	t.Helper()
	var out []byte
	for _, frame := range frames {
		encoded, err := EncodeFrame(frame)
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, encoded...)
	}
	return out
}

func collectCursorAdapterEvents(stream <-chan types.AdapterEvent) []types.AdapterEvent {
	var events []types.AdapterEvent
	for event := range stream {
		events = append(events, event)
	}
	return events
}

var _ types.Adapter = (*Adapter)(nil)
