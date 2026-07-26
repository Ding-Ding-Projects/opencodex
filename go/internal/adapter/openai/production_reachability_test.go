package openai_test

import (
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	openai "github.com/lidge-jun/opencodex-go/internal/adapter/openai"
	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/registry"
	"github.com/lidge-jun/opencodex-go/internal/server"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

func TestProductionResponsesRouteAbortsOpenAIBacklog(t *testing.T) {
	upstreamStopped := make(chan bool, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v1/responses" || request.Header.Get("Authorization") != "Bearer production-key" {
			t.Errorf("OpenAI upstream request path=%q authorization=%q", request.URL.Path, request.Header.Get("Authorization"))
			return
		}
		cancelled := false
		defer func() { upstreamStopped <- cancelled }()
		w.Header().Set("Content-Type", "text/event-stream")
		flusher := w.(http.Flusher)
		delta := strings.Repeat("x", 4096)
		for index := 0; index < 100_000; index++ {
			if _, err := fmt.Fprintf(w, "data: {\"type\":\"response.output_text.delta\",\"delta\":\"%04d%s\"}\n\n", index, delta); err != nil {
				cancelled = true
				return
			}
			flusher.Flush()
			select {
			case <-request.Context().Done():
				cancelled = true
				return
			default:
			}
		}
	}))
	defer upstream.Close()

	provider := config.ProviderConfig{Adapter: "openai-responses", BaseURL: upstream.URL + "/v1"}
	reg := registry.New(registry.Provider{
		ID: "openai", BaseURL: provider.BaseURL, DefaultModel: "probe",
		Models: []registry.ModelDefinition{{ID: "probe"}},
	})
	proxy := server.New(server.Config{
		Registry: reg,
		Client:   upstream.Client(),
		ResolveAdapter: func(_ *types.ResolvedModel, _ *types.Transport, _ *types.AuthContext, incoming http.Header) (types.Adapter, error) {
			adapter := openai.NewResponsesAdapter(provider, "production-key", nil)
			adapter.IncomingHeaders = incoming
			return adapter, nil
		},
	})
	defer proxy.Close()

	writer := newBlockedResponseWriter()
	done := make(chan struct{})
	go func() {
		defer close(done)
		request := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(
			`{"model":"openai/probe","input":"hello","stream":true}`,
		))
		proxy.Handler().ServeHTTP(writer, request)
	}()

	select {
	case <-writer.writeStarted:
	case <-time.After(5 * time.Second):
		t.Fatal("production route never began streaming to the stalled consumer")
	}
	select {
	case cancelled := <-upstreamStopped:
		if !cancelled {
			t.Fatal("OpenAI upstream completed instead of being cancelled at the queue bound")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("OpenAI queue bound did not close the upstream body")
	}
	close(writer.release)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("production handler did not release after backlog cancellation")
	}
	if writer.status != http.StatusOK || !bytes.Contains(writer.body.Bytes(), []byte("consumer backlog exceeded")) {
		t.Fatalf("OpenAI backlog response status=%d body tail=%q", writer.status, tailBytes(writer.body.Bytes(), 512))
	}
}

type blockedResponseWriter struct {
	header       http.Header
	status       int
	body         bytes.Buffer
	writeStarted chan struct{}
	release      chan struct{}
	once         sync.Once
}

func newBlockedResponseWriter() *blockedResponseWriter {
	return &blockedResponseWriter{header: make(http.Header), writeStarted: make(chan struct{}), release: make(chan struct{})}
}

func (writer *blockedResponseWriter) Header() http.Header { return writer.header }

func (writer *blockedResponseWriter) WriteHeader(status int) { writer.status = status }

func (writer *blockedResponseWriter) Write(payload []byte) (int, error) {
	writer.once.Do(func() { close(writer.writeStarted) })
	<-writer.release
	if writer.status == 0 {
		writer.status = http.StatusOK
	}
	return writer.body.Write(payload)
}

func (*blockedResponseWriter) Flush() {}

func tailBytes(value []byte, limit int) []byte {
	if len(value) <= limit {
		return value
	}
	return value[len(value)-limit:]
}
