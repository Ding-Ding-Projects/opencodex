package server

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestDrainAdmissionMiddlewareRejectsNewWorkButKeepsHealthAndStop(t *testing.T) {
	lifecycle := NewLifecycle()
	handler := DrainAdmissionMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }), lifecycle)
	lifecycle.BeginDrain()
	for _, test := range []struct {
		path string
		want int
	}{
		{path: "/v1/responses", want: http.StatusServiceUnavailable},
		{path: "/v1/chat/completions", want: http.StatusServiceUnavailable},
		{path: "/api/providers", want: http.StatusServiceUnavailable},
		{path: "/healthz", want: http.StatusNoContent},
		{path: "/health/startup", want: http.StatusNoContent},
		{path: "/api/stop", want: http.StatusNoContent},
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, test.path, nil))
		if response.Code != test.want {
			t.Errorf("%s status = %d, want %d", test.path, response.Code, test.want)
		}
	}
}

func TestTrackResponseBodyReleasesOnEOF(t *testing.T) {
	lifecycle := NewLifecycle()
	var done atomic.Int32
	ctx, body := TrackResponseBody(context.Background(), lifecycle, io.NopCloser(strings.NewReader("x")), func() { done.Add(1) })
	if lifecycle.Active() != 1 {
		t.Fatalf("active = %d", lifecycle.Active())
	}
	data, err := io.ReadAll(body)
	if err != nil || string(data) != "x" {
		t.Fatalf("read = %q, %v", data, err)
	}
	if lifecycle.Active() != 0 || done.Load() != 1 || ctx.Err() == nil {
		t.Fatalf("active=%d done=%d ctx=%v", lifecycle.Active(), done.Load(), ctx.Err())
	}
	_ = body.Close()
	if done.Load() != 1 {
		t.Fatal("onDone must be one-shot")
	}
}

func TestDrainHTTPServerFlushesWithoutServer(t *testing.T) {
	lifecycle := NewLifecycle()
	var flushed atomic.Bool
	if err := DrainHTTPServer(context.Background(), nil, lifecycle, func() error { flushed.Store(true); return nil }); err != nil {
		t.Fatal(err)
	}
	if !lifecycle.IsDraining() || !flushed.Load() {
		t.Fatal("drain and flush did not run")
	}
}
