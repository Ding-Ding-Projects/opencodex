package chat

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

func TestCompactionEnvelopeAndReplay(t *testing.T) {
	encoded := EncodeCompactionSummary("checkpoint")
	decoded, ok := DecodeCompactionSummary(encoded)
	if !ok || decoded != "checkpoint" {
		t.Fatalf("decode = %q %v", decoded, ok)
	}
	if got := CompactionItemToText(encoded); !strings.HasSuffix(got, "\n\ncheckpoint") {
		t.Fatalf("text = %q", got)
	}

	input := []json.RawMessage{
		json.RawMessage(`{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ignore"}]}`),
		json.RawMessage(`{"type":"message","role":"user","content":[{"type":"input_text","text":"first"}]}`),
		json.RawMessage(`{"role":"user","content":"second"}`),
	}
	users := ExtractCompactUserMessages(input)
	if len(users) != 2 || users[0] != "first" || users[1] != "second" {
		t.Fatalf("users = %#v", users)
	}
	replay := BuildCompactReplay(users, "summary")
	if len(replay) != 3 || !strings.Contains(string(replay[2]), SummaryPrefix) {
		t.Fatalf("replay = %s", replay)
	}
}

func TestCompactNormalizedRequestIsolatesCursorState(t *testing.T) {
	request := compactNormalizedRequest("cursor/model", nil)
	if !request.CompactionRequest || !request.IsolateCursor {
		t.Fatalf("compaction cursor flags = %v/%v", request.CompactionRequest, request.IsolateCursor)
	}
}

func TestCompactionSummaryRejectsIncompleteTerminal(t *testing.T) {
	events := []types.AdapterEvent{
		{Type: types.EventHeartbeat, Text: "ignored heartbeat"},
		{Type: types.EventTextDelta, Text: "summary"},
		{Type: types.EventIncomplete, Text: "ignored incomplete"},
	}

	if summary, err := compactionSummary(events); err == nil || summary != "" || !strings.Contains(err.Error(), "did not complete") {
		t.Fatalf("summary = %q, err = %v", summary, err)
	}
}

func TestCompactionSummaryRejectsEmptyCompletedTurn(t *testing.T) {
	_, err := compactionSummary([]types.AdapterEvent{{Type: types.EventDone}})
	var validation *compactionResultError
	if !errors.As(err, &validation) || validation.kind != "invalid_response_error" {
		t.Fatalf("error = %#v", err)
	}
}

type fakeCompactor struct{}

func (fakeCompactor) Compact(context.Context, *types.CompactionRequest) (*types.CompactionResult, error) {
	return &types.CompactionResult{Summary: "short"}, nil
}

func TestCompactHandlerUsesCompactorReplay(t *testing.T) {
	handler := NewCompactHandler(HandlerConfig{Compactor: fakeCompactor{}})
	request := httptest.NewRequest(http.MethodPost, "/v1/responses/compact", strings.NewReader(`{"model":"m","input":[{"type":"message","role":"user","content":"keep"}]}`))
	response := httptest.NewRecorder()
	handler.Handle(response, request)
	if response.Code != 200 || !strings.Contains(response.Body.String(), `"keep"`) || !strings.Contains(response.Body.String(), "\\nshort") {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
}
