package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/chat"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

const CompactResponseMaxBytes int64 = 32 << 20

type CompactRoute struct {
	Model     string
	Native    bool
	Endpoint  string
	Headers   http.Header
	Timeout   time.Duration
	Transport HTTPDoer
}

type CompactRouteResolver func(model string, incoming http.Header) (CompactRoute, error)

type CompactSummarizer interface {
	Compact(context.Context, *types.CompactionRequest) (*types.CompactionResult, error)
}

type CompactCoordinator struct {
	Resolve   CompactRouteResolver
	Summarize CompactSummarizer
}

func BufferCompactResponse(ctx context.Context, response *http.Response, limit int64) ([]byte, error) {
	if response == nil || response.Body == nil {
		return nil, nil
	}
	if limit <= 0 {
		limit = CompactResponseMaxBytes
	}
	if response.ContentLength > limit {
		_ = response.Body.Close()
		return nil, fmt.Errorf("compact response exceeded %d bytes", limit)
	}
	defer response.Body.Close()
	reader := io.LimitReader(response.Body, limit+1)
	payload, err := io.ReadAll(reader)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, fmt.Errorf("read compact response: %w", err)
	}
	if int64(len(payload)) > limit {
		return nil, fmt.Errorf("compact response exceeded %d bytes", limit)
	}
	return payload, nil
}

func (c CompactCoordinator) ServeHTTP(w http.ResponseWriter, request *http.Request) {
	var body struct {
		Model    string            `json:"model"`
		Input    []json.RawMessage `json:"input"`
		ThreadID string            `json:"thread_id"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, request.Body, 64<<20))
	if decoder.Decode(&body) != nil || strings.TrimSpace(body.Model) == "" {
		writeJSONError(w, http.StatusBadRequest, "invalid_request_error", "compaction request requires a valid model")
		return
	}
	if c.Resolve == nil {
		writeJSONError(w, http.StatusServiceUnavailable, "server_not_configured", "compact routing is not configured")
		return
	}
	route, err := c.Resolve(body.Model, request.Header.Clone())
	if err != nil {
		writeJSONError(w, http.StatusNotFound, "invalid_request_error", err.Error())
		return
	}
	if route.Model == "" {
		route.Model = body.Model
	}
	if route.Native {
		c.forwardNative(w, request, route, body.Input, body.ThreadID)
		return
	}
	if c.Summarize == nil {
		writeJSONError(w, http.StatusNotImplemented, "endpoint_not_configured", "compact summarizer is not configured")
		return
	}
	result, err := c.Summarize.Compact(request.Context(), &types.CompactionRequest{Model: route.Model, Input: body.Input, ThreadID: body.ThreadID})
	if err != nil || result == nil {
		if err == nil {
			err = fmt.Errorf("compactor returned no result")
		}
		writeJSONError(w, http.StatusBadGateway, "upstream_error", err.Error())
		return
	}
	output := result.Output
	if len(output) == 0 {
		if strings.TrimSpace(result.Summary) == "" {
			writeJSONError(w, http.StatusBadGateway, "invalid_response_error", "compaction turn produced an empty summary")
			return
		}
		output = chat.BuildCompactReplay(chat.ExtractCompactUserMessages(body.Input), result.Summary)
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"output": output})
}

func (c CompactCoordinator) forwardNative(w http.ResponseWriter, incoming *http.Request, route CompactRoute, input []json.RawMessage, threadID string) {
	payload, _ := json.Marshal(map[string]any{"model": route.Model, "input": input})
	upstream, err := http.NewRequestWithContext(incoming.Context(), http.MethodPost, route.Endpoint, bytes.NewReader(payload))
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, "upstream_error", err.Error())
		return
	}
	upstream.Header = route.Headers.Clone()
	if upstream.Header == nil {
		upstream.Header = make(http.Header)
	}
	upstream.Header.Set("Content-Type", "application/json")
	response, err := FetchWithHeaderTimeout(incoming.Context(), route.Transport, upstream, route.Timeout, false)
	if err != nil {
		status := http.StatusBadGateway
		kind := "upstream_error"
		if incoming.Context().Err() != nil {
			status, kind = 499, "client_cancelled"
		}
		writeJSONError(w, status, kind, err.Error())
		return
	}
	buffered, err := BufferCompactResponse(incoming.Context(), response, CompactResponseMaxBytes)
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, "compact_response_too_large", err.Error())
		return
	}
	w.Header().Set("Content-Type", response.Header.Get("Content-Type"))
	w.WriteHeader(response.StatusCode)
	_, _ = w.Write(buffered)
}
