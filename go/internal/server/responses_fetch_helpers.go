package server

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"sync"
	"time"
)

type HTTPDoer interface {
	Do(*http.Request) (*http.Response, error)
}

func SafeHostLabel(rawURL string) string {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Host == "" {
		return "upstream"
	}
	return parsed.Host
}

// FetchWithHeaderTimeout bounds the time to response headers. The returned body
// remains governed by the caller context, allowing long-lived SSE streams.
func FetchWithHeaderTimeout(ctx context.Context, doer HTTPDoer, request *http.Request, timeout time.Duration, preferIdentityEncoding bool) (*http.Response, error) {
	if doer == nil {
		doer = http.DefaultClient
	}
	if preferIdentityEncoding && request.Header.Get("Accept-Encoding") == "" {
		request = request.Clone(request.Context())
		request.Header.Set("Accept-Encoding", "identity")
	}
	if timeout <= 0 {
		return doer.Do(request.Clone(ctx))
	}
	headerCtx, cancel := context.WithCancelCause(ctx)
	timedOut := make(chan struct{})
	timer := time.AfterFunc(timeout, func() {
		cancel(context.DeadlineExceeded)
		close(timedOut)
	})
	response, err := doer.Do(request.Clone(headerCtx))
	if !timer.Stop() {
		<-timedOut
	}
	if err != nil {
		cause := context.Cause(headerCtx)
		cancel(err)
		if errors.Is(cause, context.DeadlineExceeded) {
			return nil, context.DeadlineExceeded
		}
		return nil, err
	}
	if errors.Is(context.Cause(headerCtx), context.DeadlineExceeded) {
		if response.Body != nil {
			_ = response.Body.Close()
		}
		return nil, context.DeadlineExceeded
	}
	if response.Body == nil {
		cancel(nil)
		return response, nil
	}
	response.Body = &headerTimeoutBody{ReadCloser: response.Body, cancel: cancel}
	return response, nil
}

type headerTimeoutBody struct {
	io.ReadCloser
	cancel context.CancelCauseFunc
	once   sync.Once
}

func (body *headerTimeoutBody) Read(buffer []byte) (int, error) {
	n, err := body.ReadCloser.Read(buffer)
	if err != nil {
		body.once.Do(func() { body.cancel(err) })
	}
	return n, err
}

func (body *headerTimeoutBody) Close() error {
	err := body.ReadCloser.Close()
	body.once.Do(func() { body.cancel(context.Canceled) })
	return err
}
