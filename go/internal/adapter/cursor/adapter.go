package cursor

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

// AdapterConfig is the production-facing Cursor adapter configuration. The
// server owns the HTTP client; this config owns Cursor's bidirectional stream.
type AdapterConfig struct {
	BaseURL           string
	Token             string
	ClientVersion     string
	SessionID         string
	Headers           map[string]string
	HeartbeatInterval time.Duration
	MaxFrameSize      int
	Interaction       InteractionHandler
	NativeExecutor    *NativeExecutor
}

// Adapter bridges Cursor's bidirectional Connect stream into the common
// request/parser adapter contract used by the Go server.
type Adapter struct {
	config AdapterConfig

	mu     sync.Mutex
	active *adapterTurn
	usage  *ContextUsageTracker
}

type adapterTurn struct {
	ctx    context.Context
	cancel context.CancelFunc
	writer *io.PipeWriter
	run    AgentRunRequest
	parser *EventParser

	writeMu         sync.Mutex
	once            sync.Once
	finalizeMu      sync.Mutex
	pendingFinalize *time.Timer
}

var _ types.Adapter = (*Adapter)(nil)

// NewAdapter constructs the Cursor adapter entry point intended for provider
// registration and CLI factories.
func NewAdapter(config AdapterConfig) (*Adapter, error) {
	if strings.TrimSpace(config.Token) == "" {
		return nil, fmt.Errorf("Cursor access token is required")
	}
	if config.BaseURL == "" {
		config.BaseURL = "https://api2.cursor.sh"
	}
	parsed, err := url.Parse(config.BaseURL)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" {
		return nil, fmt.Errorf("invalid Cursor base URL %q", config.BaseURL)
	}
	if config.ClientVersion == "" {
		config.ClientVersion = cursorClientVersion
	}
	if config.SessionID == "" {
		config.SessionID = newID()
	}
	if config.HeartbeatInterval <= 0 {
		config.HeartbeatInterval = cursorHeartbeatInterval
	}
	if config.MaxFrameSize <= 0 {
		config.MaxFrameSize = DefaultMaxFrameSize
	}
	config.Headers = cloneAdapterHeaders(config.Headers)
	return &Adapter{config: config, usage: NewContextUsageTracker()}, nil
}

func (a *Adapter) BuildRequest(ctx context.Context, request *types.NormalizedRequest) (*http.Request, error) {
	built, err := BuildAgentRunRequest(request)
	if err != nil {
		return nil, err
	}
	payload, err := MarshalAgentClientRun(built.Run)
	if err != nil {
		return nil, fmt.Errorf("marshal Cursor run request: %w", err)
	}
	reader, writer := io.Pipe()
	turnCtx, cancel := context.WithCancel(ctx)
	parserOptions := eventParserOptionsForRun(built.Run)
	if a.usage != nil {
		controls := a.usage.ControlsForConversation(built.Run.ConversationID, built.Run.ContextUsageReset, !built.Run.DisableContextUsageStore)
		parserOptions.CarryForwardTokens = controls.CarryForwardTokens
		parserOptions.RecordContextTokens = controls.RecordContextTokens
	}
	turn := &adapterTurn{
		ctx: turnCtx, cancel: cancel, writer: writer, run: built.Run,
		parser: NewEventParser(parserOptions),
	}

	a.mu.Lock()
	if a.active != nil {
		a.mu.Unlock()
		cancel()
		_ = reader.Close()
		_ = writer.Close()
		return nil, fmt.Errorf("Cursor adapter already has an active turn")
	}
	a.active = turn
	a.mu.Unlock()

	endpoint := strings.TrimRight(a.config.BaseURL, "/") + cursorRunPath
	httpRequest, err := http.NewRequestWithContext(turnCtx, http.MethodPost, endpoint, reader)
	if err != nil {
		a.releaseTurn(turn)
		return nil, err
	}
	applyCursorHeaders(httpRequest.Header, a.config)

	go func() {
		if err := turn.writePayload(payload); err != nil {
			turn.shutdownWithError(err)
			return
		}
		ticker := time.NewTicker(a.config.HeartbeatInterval)
		defer ticker.Stop()
		for {
			select {
			case <-turnCtx.Done():
				return
			case <-ticker.C:
				if err := turn.writePayload(marshalClientHeartbeat()); err != nil {
					turn.shutdownWithError(err)
					return
				}
			}
		}
	}()
	return httpRequest, nil
}

func (a *Adapter) ParseStream(ctx context.Context, body io.ReadCloser) <-chan types.AdapterEvent {
	out := make(chan types.AdapterEvent, 16)
	turn := a.currentTurn()
	go func() {
		defer close(out)
		if turn == nil {
			sendCursorAdapterEvent(ctx, out, types.AdapterEvent{Type: types.EventError, Error: "Cursor adapter has no active turn", StatusCode: http.StatusBadGateway})
			return
		}
		defer a.releaseTurn(turn)
		if body == nil {
			sendCursorAdapterEvent(ctx, out, types.AdapterEvent{Type: types.EventError, Error: "Cursor response has no body", StatusCode: http.StatusBadGateway})
			return
		}
		defer body.Close()
		stopCancelClose := make(chan struct{})
		defer close(stopCancelClose)
		go func() {
			select {
			case <-ctx.Done():
				_ = body.Close()
			case <-stopCancelClose:
			}
		}()
		err := a.consumeFrames(ctx, body, turn, func(event types.AdapterEvent) error {
			if !sendCursorAdapterEvent(ctx, out, event) {
				return ctx.Err()
			}
			return nil
		})
		if err != nil && !errors.Is(err, context.Canceled) {
			sendCursorAdapterEvent(ctx, out, types.AdapterEvent{Type: types.EventError, Error: err.Error(), StatusCode: http.StatusBadGateway})
		}
	}()
	return out
}

func (a *Adapter) ParseUnary(ctx context.Context, body []byte) ([]types.AdapterEvent, error) {
	turn := a.currentTurn()
	if turn == nil {
		return nil, fmt.Errorf("Cursor adapter has no active turn")
	}
	defer a.releaseTurn(turn)
	var events []types.AdapterEvent
	err := a.consumeFrames(ctx, bytes.NewReader(body), turn, func(event types.AdapterEvent) error {
		events = append(events, event)
		return nil
	})
	return events, err
}

func (a *Adapter) consumeFrames(ctx context.Context, reader io.Reader, turn *adapterTurn, emit func(types.AdapterEvent) error) error {
	frames := 0
	for {
		frame, err := ReadFrame(reader, a.config.MaxFrameSize)
		if err != nil {
			if errors.Is(err, io.EOF) && frames == 0 {
				return io.ErrUnexpectedEOF
			}
			if (errors.Is(err, io.EOF) || errors.Is(err, context.Canceled)) && turn.parser.Terminated() {
				return nil
			}
			return err
		}
		frames++
		if frame.Compressed() {
			return fmt.Errorf("Cursor compressed Connect frames are unsupported")
		}
		if frame.EndStream() {
			if err := ParseEndStreamTrailer(frame.Payload); err != nil {
				return err
			}
			if turn.parser.Terminated() {
				return nil
			}
			return fmt.Errorf("Cursor stream ended without terminal event")
		}
		server, err := UnmarshalAgentServerMessage(frame.Payload)
		if err != nil {
			return err
		}
		switch server.Kind {
		case ServerInteractionQuery:
			var reply []byte
			visibleText := ""
			if a.config.Interaction != nil {
				reply, err = a.config.Interaction(ctx, server.Payload)
			} else {
				reply, visibleText, err = marshalInteractionReply(server.Payload)
			}
			if err != nil {
				return err
			}
			if len(reply) > 0 {
				if err := turn.writePayload(reply); err != nil {
					return fmt.Errorf("write Cursor interaction reply: %w", err)
				}
			}
			if visibleText != "" {
				if err := emit(types.AdapterEvent{Type: types.EventTextDelta, Text: visibleText}); err != nil {
					return err
				}
			}
			if err := emit(types.AdapterEvent{Type: types.EventHeartbeat}); err != nil {
				return err
			}
			continue
		case ServerKV:
			reply, err := marshalKVReply(server.Payload, turn.run.Blobs)
			if err != nil {
				return err
			}
			if err := turn.writePayload(reply); err != nil {
				return fmt.Errorf("write Cursor KV reply: %w", err)
			}
			continue
		case ServerExec:
			execRequest, decodeErr := UnmarshalExecServerMessage(server.Payload)
			if decodeErr != nil {
				return decodeErr
			}
			execRequest.ClientToolDefinitions = turn.run.Tools
			clientEvents, handled, drained, handleErr := turn.parser.HandleClientToolExec(execRequest)
			if handleErr != nil {
				return handleErr
			}
			if handled {
				for _, event := range clientEvents {
					if err := emit(event); err != nil {
						return err
					}
				}
				if drained {
					turn.scheduleClientToolFinalize(func() {
						events := turn.parser.FinalizeClientToolsIfDrained()
						for _, event := range events {
							if emit(event) != nil {
								return
							}
						}
						if len(events) > 0 {
							turn.cancel()
						}
					})
				}
				continue
			}
			if a.config.NativeExecutor == nil {
				continue
			}
			for _, execResponse := range a.config.NativeExecutor.Execute(ctx, execRequest) {
				reply, marshalErr := MarshalExecClientMessage(execResponse)
				if marshalErr != nil {
					return marshalErr
				}
				if writeErr := turn.writePayload(reply); writeErr != nil {
					return fmt.Errorf("write Cursor native exec reply: %w", writeErr)
				}
			}
			if err := emit(types.AdapterEvent{Type: types.EventHeartbeat}); err != nil {
				return err
			}
			continue
		}
		events, err := turn.parser.Parse(frame.Payload)
		if err != nil {
			return err
		}
		if turn.parser.OpenToolCount() > 0 {
			turn.cancelClientToolFinalize()
		}
		for _, event := range events {
			if err := emit(event); err != nil {
				return err
			}
		}
	}
}

func (a *Adapter) currentTurn() *adapterTurn {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.active
}

func (a *Adapter) releaseTurn(turn *adapterTurn) {
	if turn != nil {
		turn.shutdownWithError(nil)
	}
	a.mu.Lock()
	if a.active == turn {
		a.active = nil
	}
	a.mu.Unlock()
}

func (t *adapterTurn) writePayload(payload []byte) error {
	frame, err := EncodeFrame(ConnectFrame{Payload: payload})
	if err != nil {
		return err
	}
	t.writeMu.Lock()
	defer t.writeMu.Unlock()
	select {
	case <-t.ctx.Done():
		return t.ctx.Err()
	default:
	}
	_, err = t.writer.Write(frame)
	return err
}

func (t *adapterTurn) scheduleClientToolFinalize(finalize func()) {
	grace := t.run.ClientToolFinalizeGrace
	if grace <= 0 {
		grace = cursorClientToolFinalizeGrace
	}
	t.finalizeMu.Lock()
	if t.pendingFinalize != nil {
		t.pendingFinalize.Stop()
	}
	var timer *time.Timer
	timer = time.AfterFunc(grace, func() {
		t.finalizeMu.Lock()
		if t.pendingFinalize != timer {
			t.finalizeMu.Unlock()
			return
		}
		t.pendingFinalize = nil
		t.finalizeMu.Unlock()
		finalize()
	})
	t.pendingFinalize = timer
	t.finalizeMu.Unlock()
}

func (t *adapterTurn) cancelClientToolFinalize() {
	t.finalizeMu.Lock()
	if t.pendingFinalize != nil {
		t.pendingFinalize.Stop()
		t.pendingFinalize = nil
	}
	t.finalizeMu.Unlock()
}

func (t *adapterTurn) shutdownWithError(err error) {
	t.once.Do(func() {
		t.cancelClientToolFinalize()
		t.cancel()
		if err != nil {
			_ = t.writer.CloseWithError(err)
		} else {
			_ = t.writer.Close()
		}
	})
}

func applyCursorHeaders(headers http.Header, config AdapterConfig) {
	headers.Set("Content-Type", "application/connect+proto")
	headers.Set("Connect-Protocol-Version", "1")
	headers.Set("TE", "trailers")
	headers.Set("Authorization", "Bearer "+config.Token)
	headers.Set("X-Ghost-Mode", "true")
	headers.Set("X-Cursor-Client-Version", config.ClientVersion)
	headers.Set("X-Cursor-Client-Type", "cli")
	headers.Set("X-Request-Id", newID())
	headers.Set("X-Session-Id", config.SessionID)
	for key, value := range config.Headers {
		if strings.TrimSpace(key) != "" {
			headers.Set(key, value)
		}
	}
}

func cloneAdapterHeaders(values map[string]string) map[string]string {
	if len(values) == 0 {
		return nil
	}
	clone := make(map[string]string, len(values))
	for key, value := range values {
		clone[key] = value
	}
	return clone
}

func sendCursorAdapterEvent(ctx context.Context, out chan<- types.AdapterEvent, event types.AdapterEvent) bool {
	select {
	case out <- event:
		return true
	case <-ctx.Done():
		return false
	}
}
