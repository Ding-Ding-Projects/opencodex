package server

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/bridge"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

// responsesLogSession connects the advanced request-log model to the actual
// Responses lifecycle. It stores metadata only: no body, header, credential,
// account, or thread identifier is retained.
type responsesLogSession struct {
	mu        sync.Mutex
	store     *RequestLogStore
	started   time.Time
	requestID string
	context   RequestLogContext
	terminal  ResponsesTerminalStatus
	finished  bool
}

func newResponsesLogSession(store *RequestLogStore, started time.Time, requestedModel string, resolved *types.ResolvedModel, adapter string) *responsesLogSession {
	s := &responsesLogSession{store: store, started: started, requestID: NextRequestLogID(started)}
	s.context.Surface = "responses"
	s.context.RequestedModel = requestedModel
	if resolved != nil {
		s.context.Provider, s.context.Model = resolved.Provider, resolved.Model
		s.context.ResolvedModel = resolved.Model
	}
	s.context.ProviderAdapter = adapter
	return s
}

func (s *responsesLogSession) ensureAttempt(provider, model, adapter string) {
	if s == nil || s.store == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if active := s.context.ActiveAttempt; active != nil && active.Provider == provider && active.Model == model && active.Adapter == adapter {
		return
	}
	if s.context.ActiveAttempt != nil && s.context.ActiveAttempt.Status == 0 {
		s.context.ActiveAttempt.Finish(http.StatusBadGateway, time.Since(s.context.ActiveAttemptStartedAt), s.context.Usage)
	}
	attempt := BeginRequestAttempt(len(s.context.Attempts)+1, provider, model, adapter)
	attempt.NoteSend("")
	s.context.Attempts = append(s.context.Attempts, attempt)
	s.context.ActiveAttempt = &s.context.Attempts[len(s.context.Attempts)-1]
	s.context.ActiveAttemptStartedAt = time.Now()
	s.context.Provider, s.context.Model, s.context.ProviderAdapter = provider, model, adapter
}

func (s *responsesLogSession) noteRecovery(kind string) {
	if s == nil || s.store == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.context.ActiveAttempt != nil {
		s.context.ActiveAttempt.NoteSend(kind)
	}
}

func (s *responsesLogSession) finishAttempt(status int) {
	if s == nil || s.store == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.context.ActiveAttempt != nil && s.context.ActiveAttempt.Status == 0 {
		s.context.ActiveAttempt.Finish(status, time.Since(s.context.ActiveAttemptStartedAt), s.context.Usage)
	}
}

func (s *responsesLogSession) observe(event types.AdapterEvent) {
	if s == nil || s.store == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	switch event.Type {
	case types.EventTextDelta, types.EventReasoning, types.EventThinkingDelta, types.EventToolCall, types.EventToolCallStart:
		RecordFirstOutput(&s.context, s.started, time.Now())
	}
	if event.Usage != nil {
		usage := *event.Usage
		s.context.Usage = &usage
	}
	switch event.Type {
	case types.EventDone:
		s.terminal = ResponsesCompleted
	case types.EventIncomplete:
		s.terminal = ResponsesIncomplete
		if event.Error != "" {
			s.context.UpstreamError = event.Error
		} else {
			s.context.UpstreamError = event.Message
		}
		if event.StatusCode != 0 {
			s.context.TerminalHTTPStatus = event.StatusCode
		}
	case types.EventError:
		s.terminal = ResponsesFailed
		s.context.UpstreamError = event.Error
		if event.StatusCode != 0 {
			s.context.TerminalHTTPStatus = event.StatusCode
		}
	}
}

func (s *responsesLogSession) observeSlice(events []types.AdapterEvent) {
	for _, event := range events {
		s.observe(event)
	}
}

func (s *responsesLogSession) firstOutput() {
	if s == nil || s.store == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	RecordFirstOutput(&s.context, s.started, time.Now())
}

func (s *responsesLogSession) usage(value *types.Usage) {
	if s == nil || s.store == nil || value == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	copy := *value
	s.context.Usage = &copy
}

func (s *responsesLogSession) rawTerminal(status ResponsesTerminalStatus, httpStatus int) {
	if s == nil || s.store == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.terminal = status
	if httpStatus >= 400 {
		s.context.TerminalHTTPStatus = httpStatus
	}
}

func (s *responsesLogSession) finishStream(ctx context.Context, streamErr error) {
	if s == nil || s.store == nil {
		return
	}
	status, terminal, reason := http.StatusOK, s.terminal, RequestLogTerminal
	message := ""
	if streamErr != nil {
		message = streamErr.Error()
	}
	switch {
	case errors.Is(context.Cause(ctx), bridge.UpstreamStallError):
		status, terminal, reason, message = http.StatusBadGateway, ResponsesIncomplete, RequestLogBodyStall, bridge.UpstreamStallError.Error()
	case ctx.Err() != nil:
		status, terminal, reason = 499, ResponsesIncomplete, RequestLogClientCancel
	case terminal == ResponsesFailed:
		status = http.StatusBadGateway
	case terminal == ResponsesIncomplete:
		status = http.StatusBadGateway
	case terminal == "":
		status, terminal = http.StatusBadGateway, ResponsesIncomplete
	}
	s.finish(status, terminal, reason, message)
}

func (s *responsesLogSession) finish(status int, terminal ResponsesTerminalStatus, reason RequestLogCloseReason, message string) {
	if s == nil || s.store == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.finished {
		return
	}
	s.finished = true
	if message != "" && s.context.UpstreamError == "" {
		s.context.UpstreamError = normalizeUpstreamDisconnectMessage(message)
	}
	entry := FinalRequestLogEntry(s.requestID, s.started, time.Now(), &s.context, status, terminal, reason)
	s.store.Add(entry)
}
