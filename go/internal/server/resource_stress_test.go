package server

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

type discardResponseWriter struct{ header http.Header }

func (writer *discardResponseWriter) Header() http.Header {
	if writer.header == nil {
		writer.header = make(http.Header)
	}
	return writer.header
}
func (*discardResponseWriter) Write(payload []byte) (int, error) { return len(payload), nil }
func (*discardResponseWriter) WriteHeader(int)                   {}

type resourceStreamAdapter struct {
	endpoint string
	chunks   int
	payload  string
}

func (adapter resourceStreamAdapter) BuildRequest(ctx context.Context, request *types.NormalizedRequest) (*http.Request, error) {
	return http.NewRequestWithContext(ctx, http.MethodPost, adapter.endpoint, strings.NewReader(string(request.RawBody)))
}
func (adapter resourceStreamAdapter) ParseStream(context.Context, io.ReadCloser) <-chan types.AdapterEvent {
	events := make(chan types.AdapterEvent, adapter.chunks+1)
	for range adapter.chunks {
		events <- types.AdapterEvent{Type: types.EventTextDelta, Text: adapter.payload}
	}
	events <- types.AdapterEvent{Type: types.EventDone}
	close(events)
	return events
}
func (adapter resourceStreamAdapter) ParseUnary(context.Context, []byte) ([]types.AdapterEvent, error) {
	return []types.AdapterEvent{{Type: types.EventTextDelta, Text: adapter.payload}, {Type: types.EventDone}}, nil
}

func newResourceCore(upstreamURL string, chunks int, payload string, client *http.Client) *ResponsesCore {
	return NewResponsesCore(ResponsesCoreConfig{
		Registry: coreRegistry{endpoint: upstreamURL}, Client: client,
		ResolveAdapter: func(_ *types.ResolvedModel, transport *types.Transport, _ *types.AuthContext, _ http.Header) (types.Adapter, error) {
			return resourceStreamAdapter{endpoint: transport.BaseURL, chunks: chunks, payload: payload}, nil
		},
	})
}

func serveResourceStream(core *ResponsesCore) {
	request := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"public","stream":true}`))
	core.ServeHTTP(&discardResponseWriter{}, request)
}

func TestResponsesStreamingDoesNotRetainHeapOrGoroutines(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: ignored\n\n")
	}))
	defer upstream.Close()
	transport := &http.Transport{DisableKeepAlives: true}
	defer transport.CloseIdleConnections()
	core := newResourceCore(upstream.URL, 64, strings.Repeat("x", 4096), &http.Client{Transport: transport})

	for range 4 {
		serveResourceStream(core)
	}
	runtime.GC()
	var before runtime.MemStats
	runtime.ReadMemStats(&before)
	baselineGoroutines := runtime.NumGoroutine()

	for range 6 {
		var group sync.WaitGroup
		group.Add(24)
		for range 24 {
			go func() {
				defer group.Done()
				serveResourceStream(core)
			}()
		}
		group.Wait()
	}
	transport.CloseIdleConnections()
	deadline := time.Now().Add(2 * time.Second)
	for runtime.NumGoroutine() > baselineGoroutines+4 && time.Now().Before(deadline) {
		runtime.GC()
		time.Sleep(10 * time.Millisecond)
	}
	runtime.GC()
	var after runtime.MemStats
	runtime.ReadMemStats(&after)
	if got := runtime.NumGoroutine(); got > baselineGoroutines+4 {
		t.Fatalf("stream goroutines did not return: baseline=%d after=%d", baselineGoroutines, got)
	}
	const retainedHeapLimit = 12 << 20
	if after.HeapAlloc > before.HeapAlloc+retainedHeapLimit {
		t.Fatalf("stream heap retained too much: before=%d after=%d delta=%d limit=%d", before.HeapAlloc, after.HeapAlloc, after.HeapAlloc-before.HeapAlloc, retainedHeapLimit)
	}
}

func TestServerCloseReleasesWatchdogGoroutines(t *testing.T) {
	baseline := runtime.NumGoroutine()
	for range 64 {
		proxy := New(Config{})
		proxy.Close()
	}
	deadline := time.Now().Add(time.Second)
	for runtime.NumGoroutine() > baseline+2 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if got := runtime.NumGoroutine(); got > baseline+2 {
		t.Fatalf("server watchdog goroutines leaked: baseline=%d after=%d", baseline, got)
	}
}

func BenchmarkResponsesBufferedRequest(b *testing.B) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{}`)
	}))
	defer upstream.Close()
	core := newResourceCore(upstream.URL, 0, "ok", upstream.Client())
	body := []byte(`{"model":"public","stream":false}`)
	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		request := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(string(body)))
		core.ServeHTTP(&discardResponseWriter{}, request)
	}
}
