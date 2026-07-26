package lib

import (
	"context"
	"errors"
	"io"
	"math/rand/v2"
	"net"
	"net/http"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	defaultRetryAttempts = 3
	defaultSlowAttempt   = 15 * time.Second
)

type RetryOptions struct {
	Attempts    int
	BaseDelay   time.Duration
	MaxDelay    time.Duration
	SlowAttempt time.Duration
	Now         func() time.Time
	Sleep       func(context.Context, time.Duration) error
	// ResetOnly retries connection-reset-shaped transport failures but returns
	// completed HTTP responses unchanged.
	ResetOnly bool
}

type ReplayableRequest func(context.Context, bool) (*http.Response, error)

func IsTransientUpstreamStatus(status int) bool {
	return status == 500 || status == 502 || status == 503 || status == 504 || status == 520 || status == 521 || status == 522
}

func IsConnectionResetError(err error) bool {
	if err == nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return false
	}
	if errors.Is(err, syscall.ECONNRESET) || errors.Is(err, syscall.EPIPE) || errors.Is(err, io.ErrUnexpectedEOF) {
		return true
	}
	var netError net.Error
	if errors.As(err, &netError) && netError.Timeout() {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "socket connection was closed unexpectedly") || strings.Contains(message, "connection reset by peer")
}

func RetryBackoff(attempt int, headers http.Header, baseDelay, maxDelay time.Duration, now time.Time) time.Duration {
	if baseDelay <= 0 {
		baseDelay = 400 * time.Millisecond
	}
	if maxDelay <= 0 {
		maxDelay = 5 * time.Second
	}
	if delay, ok := retryAfter(headers.Get("Retry-After"), now); ok {
		return min(delay, maxDelay)
	}
	delay := baseDelay
	for range attempt {
		if delay >= maxDelay/2 {
			delay = maxDelay
			break
		}
		delay *= 2
	}
	delay = min(delay, maxDelay)
	return time.Duration(float64(delay) * (0.8 + rand.Float64()*0.4))
}

func DoWithUpstreamRetry(ctx context.Context, send ReplayableRequest, options RetryOptions) (*http.Response, error) {
	attempts := options.Attempts
	if attempts < 1 {
		attempts = defaultRetryAttempts
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	sleep := options.Sleep
	if sleep == nil {
		sleep = sleepContext
	}
	slowAttempt := options.SlowAttempt
	if slowAttempt <= 0 {
		slowAttempt = defaultSlowAttempt
	}
	var lastErr error
	for attempt := 0; attempt < attempts; attempt++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		started := now()
		response, err := send(ctx, attempt > 0)
		elapsed := now().Sub(started)
		if err == nil && response == nil {
			return nil, errors.New("upstream retry returned nil response without error")
		}
		if err == nil && (options.ResetOnly || !IsTransientUpstreamStatus(response.StatusCode) || elapsed > slowAttempt || attempt == attempts-1) {
			return response, nil
		}
		if err != nil && (!IsConnectionResetError(err) || attempt == attempts-1) {
			return nil, err
		}
		lastErr = err
		headers := http.Header(nil)
		if response != nil {
			headers = response.Header
			if response.Body != nil {
				_ = response.Body.Close()
			}
		}
		if err := sleep(ctx, RetryBackoff(attempt, headers, options.BaseDelay, options.MaxDelay, now())); err != nil {
			return nil, err
		}
	}
	return nil, lastErr
}

func retryAfter(raw string, now time.Time) (time.Duration, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0, false
	}
	if seconds, err := strconv.ParseFloat(raw, 64); err == nil {
		return max(0, time.Duration(seconds*float64(time.Second))), true
	}
	date, err := http.ParseTime(raw)
	if err != nil {
		return 0, false
	}
	return max(0, date.Sub(now)), true
}

func sleepContext(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
