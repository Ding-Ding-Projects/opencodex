package server

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	appconfig "github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

func TestMixedServerOperationsRemainResourceBounded(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: ignored\n\n")
	}))
	defer upstream.Close()
	transport := &http.Transport{MaxIdleConns: 32, MaxIdleConnsPerHost: 16, IdleConnTimeout: time.Second}
	defer transport.CloseIdleConnections()
	cfg := appconfig.Default()
	cfg.DefaultProvider = "provider"
	cfg.Providers = map[string]appconfig.ProviderConfig{
		"provider": {Adapter: "openai-chat", BaseURL: upstream.URL, DefaultModel: "wire", AllowPrivateNetwork: true},
	}
	proxy := New(Config{
		Registry: coreRegistry{endpoint: upstream.URL}, ManagementConfig: &cfg,
		Client: &http.Client{Transport: transport}, RefreshCatalog: func() error { return nil },
		ResolveAdapter: func(_ *types.ResolvedModel, resolved *types.Transport, _ *types.AuthContext, _ http.Header) (types.Adapter, error) {
			return resourceStreamAdapter{endpoint: resolved.BaseURL, chunks: 4, payload: "bounded"}, nil
		},
	})
	defer proxy.Close()
	server := httptest.NewServer(proxy.Handler())
	defer server.Close()
	client := server.Client()

	for range 32 {
		doMixedOperation(t, client, server.URL, 0)
	}
	runtime.GC()
	var before runtime.MemStats
	runtime.ReadMemStats(&before)
	baselineGoroutines, baselineFDs := runtime.NumGoroutine(), openFDCount()

	const requests = 2400
	var next atomic.Int64
	errors := make(chan error, 32)
	var workers sync.WaitGroup
	for range 24 {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for {
				index := int(next.Add(1) - 1)
				if index >= requests {
					return
				}
				if err := mixedOperation(client, server.URL, index); err != nil {
					errors <- err
					return
				}
			}
		}()
	}
	workers.Wait()
	close(errors)
	for err := range errors {
		t.Fatal(err)
	}
	transport.CloseIdleConnections()
	deadline := time.Now().Add(2 * time.Second)
	for runtime.NumGoroutine() > baselineGoroutines+8 && time.Now().Before(deadline) {
		runtime.GC()
		time.Sleep(10 * time.Millisecond)
	}
	runtime.GC()
	var after runtime.MemStats
	runtime.ReadMemStats(&after)
	afterGoroutines, afterFDs := runtime.NumGoroutine(), openFDCount()
	t.Logf("mixed-load resources requests=%d heap=%d->%d goroutines=%d->%d fds=%d->%d", requests, before.HeapAlloc, after.HeapAlloc, baselineGoroutines, afterGoroutines, baselineFDs, afterFDs)
	if afterGoroutines > baselineGoroutines+8 {
		t.Fatalf("mixed load retained goroutines: before=%d after=%d", baselineGoroutines, afterGoroutines)
	}
	if delta := int64(after.HeapAlloc) - int64(before.HeapAlloc); delta > 24<<20 {
		t.Fatalf("mixed load retained heap: before=%d after=%d delta=%d", before.HeapAlloc, after.HeapAlloc, delta)
	}
	if baselineFDs >= 0 && afterFDs > baselineFDs+8 {
		t.Fatalf("mixed load retained file descriptors: before=%d after=%d", baselineFDs, afterFDs)
	}
}

func doMixedOperation(t *testing.T, client *http.Client, baseURL string, index int) {
	t.Helper()
	if err := mixedOperation(client, baseURL, index); err != nil {
		t.Fatal(err)
	}
}

func mixedOperation(client *http.Client, baseURL string, index int) error {
	method, path, body := http.MethodGet, "/healthz", ""
	switch index % 4 {
	case 1, 2:
		method, path, body = http.MethodPost, "/v1/responses", `{"model":"public","stream":true,"input":"load"}`
	case 3:
		method, path = http.MethodPut, "/api/model-visibility"
		body = `{"scope":"models","provider":"provider","enabled":true,"targets":[{"id":"wire"}]}`
	}
	request, err := http.NewRequestWithContext(context.Background(), method, baseURL+path, strings.NewReader(body))
	if err != nil {
		return err
	}
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	_, readErr := io.Copy(io.Discard, response.Body)
	closeErr := response.Body.Close()
	if readErr != nil {
		return readErr
	}
	if closeErr != nil {
		return closeErr
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return &mixedStatusError{method: method, path: path, status: response.StatusCode}
	}
	return nil
}

type mixedStatusError struct {
	method, path string
	status       int
}

func (e *mixedStatusError) Error() string {
	return e.method + " " + e.path + " returned " + intString(e.status)
}

func openFDCount() int {
	directory, err := os.Open("/dev/fd")
	if err != nil {
		return -1
	}
	defer directory.Close()
	names, err := directory.Readdirnames(-1)
	if err != nil {
		return -1
	}
	return len(names)
}
