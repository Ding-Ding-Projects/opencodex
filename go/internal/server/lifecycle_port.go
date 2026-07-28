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
		writeClassifiedJSONError(w, http.StatusServiceUnavailable, "server_error", "Service shutting down")
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
//
// `closer` is the owning Server's cleanup and runs AFTER Shutdown returns, on
// this goroutine, so the call does not come back while the memory watchdog is
// still sampling or response state is still unflushed. Registering it with
// RegisterOnShutdown cannot give that guarantee: net/http starts each
// registered callback as `go f()`, and its documentation says the callback
// "should not wait for shutdown to complete".
//
// The order is deliberate. Cleanup runs after the drain rather than before it,
// because stopping the watchdog first would discard the samples covering the
// shutdown itself, and flushing first would miss whatever the still-draining
// requests went on to write.
func DrainHTTPServer(ctx context.Context, server *http.Server, lifecycle *Lifecycle, flush func() error, closer ...func()) error {
	runClosers := func() {
		// Cleanup runs even when the drain failed: leaving the watchdog
		// sampling because shutdown reported an error is strictly worse.
		for _, close := range closer {
			if close != nil {
				close()
			}
		}
	}
	if lifecycle != nil {
		if err := lifecycle.Drain(ctx); err != nil && ctx.Err() == nil {
			runClosers()
			return err
		}
	}
	if flush != nil {
		if err := flush(); err != nil {
			runClosers()
			return err
		}
	}
	if server == nil {
		runClosers()
		return nil
	}
	err := server.Shutdown(ctx)
	runClosers()
	return err
}
