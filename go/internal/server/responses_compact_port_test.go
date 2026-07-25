package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

type compactSummarizerFunc func(context.Context, *types.CompactionRequest) (*types.CompactionResult, error)

func (f compactSummarizerFunc) Compact(ctx context.Context, request *types.CompactionRequest) (*types.CompactionResult, error) {
	return f(ctx, request)
}

func TestCompactCoordinatorRoutedFallback(t *testing.T) {
	coordinator := CompactCoordinator{
		Resolve: func(string, http.Header) (CompactRoute, error) { return CompactRoute{Model: "wire-model"}, nil },
		Summarize: compactSummarizerFunc(func(_ context.Context, request *types.CompactionRequest) (*types.CompactionResult, error) {
			if request.Model != "wire-model" {
				t.Fatalf("model = %q", request.Model)
			}
			return &types.CompactionResult{Summary: "checkpoint"}, nil
		}),
	}
	request := httptest.NewRequest(http.MethodPost, "/v1/responses/compact", strings.NewReader(`{"model":"public","input":[{"type":"message","role":"user","content":"keep"}]}`))
	response := httptest.NewRecorder()
	coordinator.ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "checkpoint") || !strings.Contains(response.Body.String(), "keep") {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
}

func TestCompactCoordinatorNativeForward(t *testing.T) {
	var received map[string]any
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		_ = json.NewDecoder(request.Body).Decode(&received)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"output":[{"type":"compaction"}]}`)
	}))
	defer upstream.Close()
	coordinator := CompactCoordinator{Resolve: func(string, http.Header) (CompactRoute, error) {
		return CompactRoute{Model: "native-wire", Native: true, Endpoint: upstream.URL}, nil
	}}
	request := httptest.NewRequest(http.MethodPost, "/v1/responses/compact", strings.NewReader(`{"model":"public","input":[]}`))
	response := httptest.NewRecorder()
	coordinator.ServeHTTP(response, request)
	if response.Code != http.StatusOK || received["model"] != "native-wire" {
		t.Fatalf("response = %d %s, body = %#v", response.Code, response.Body.String(), received)
	}
}

func TestBufferCompactResponseRejectsDeclaredOversize(t *testing.T) {
	response := &http.Response{Body: io.NopCloser(strings.NewReader("small")), ContentLength: 10}
	if _, err := BufferCompactResponse(context.Background(), response, 5); err == nil {
		t.Fatal("expected declared-length rejection")
	}
}
