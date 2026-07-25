package server

import (
	"context"
	"io"
	"net/http"
	"sync"
)

// DrainAdmissionMiddleware rejects new API work after graceful drain begins
// while keeping health probes and the idempotent stop endpoint available.
func DrainAdmissionMiddleware(next http.Handler, lifecycle *Lifecycle) http.Handler {
	if lifecycle == nil {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if !lifecycle.IsDraining() || isPublicHealthPath(request.URL.Path) || request.URL.Path == "/api/stop" {
			next.ServeHTTP(w, request)
			return
		}
		w.Header().Set("Retry-After", "5")
		writeJSONError(w, http.StatusServiceUnavailable, "server_draining", "server is draining")
	})
}

type trackedResponseBody struct {
	body   io.ReadCloser
	done   func()
	cancel context.CancelCauseFunc
	onDone func()
	once   sync.Once
}

// TrackResponseBody registers a long-lived body until EOF, close, or read
// failure. Closing it also cancels the request context, matching stream cancel.
func TrackResponseBody(parent context.Context, lifecycle *Lifecycle, body io.ReadCloser, onDone func()) (context.Context, io.ReadCloser) {
	if lifecycle == nil {
		lifecycle = NewLifecycle()
	}
	tracked, done := lifecycle.Track(parent)
	ctx, cancel := context.WithCancelCause(tracked)
	return ctx, &trackedResponseBody{body: body, done: done, cancel: cancel, onDone: onDone}
}

func (body *trackedResponseBody) Read(buffer []byte) (int, error) {
	n, err := body.body.Read(buffer)
	if err != nil {
		body.finish(err)
	}
	return n, err
}

func (body *trackedResponseBody) Close() error {
	err := body.body.Close()
	body.finish(context.Canceled)
	return err
}

func (body *trackedResponseBody) finish(cause error) {
	body.once.Do(func() {
		body.cancel(cause)
		body.done()
		if body.onDone != nil {
			body.onDone()
		}
	})
}

// DrainHTTPServer stops new work, waits for tracked turns, flushes state, and
// then invokes net/http graceful shutdown.
func DrainHTTPServer(ctx context.Context, server *http.Server, lifecycle *Lifecycle, flush func() error) error {
	if lifecycle != nil {
		if err := lifecycle.Drain(ctx); err != nil && ctx.Err() == nil {
			return err
		}
	}
	if flush != nil {
		if err := flush(); err != nil {
			return err
		}
	}
	if server == nil {
		return nil
	}
	return server.Shutdown(ctx)
}
