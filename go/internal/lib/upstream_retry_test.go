package lib

import (
	"context"
	"io"
	"net/http"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestDoWithUpstreamRetryRecoversResetAndTransient(t *testing.T) {
	attempts := 0
	response, err := DoWithUpstreamRetry(context.Background(), func(_ context.Context, recovery bool) (*http.Response, error) {
		attempts++
		if attempts == 1 {
			return nil, syscall.ECONNRESET
		}
		if attempts == 2 {
			return &http.Response{StatusCode: 503, Header: http.Header{}, Body: io.NopCloser(strings.NewReader("retry"))}, nil
		}
		if !recovery {
			t.Fatal("retry did not request recovery transport")
		}
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader("ok"))}, nil
	}, RetryOptions{Attempts: 3, Sleep: func(context.Context, time.Duration) error { return nil }})
	if err != nil || response.StatusCode != 200 || attempts != 3 {
		t.Fatalf("response=%v attempts=%d err=%v", response, attempts, err)
	}
}

func TestDoWithUpstreamRetryDoesNotRetryCancellation(t *testing.T) {
	attempts := 0
	_, err := DoWithUpstreamRetry(context.Background(), func(context.Context, bool) (*http.Response, error) { attempts++; return nil, context.Canceled }, RetryOptions{Attempts: 3})
	if err == nil || attempts != 1 {
		t.Fatalf("attempts=%d err=%v", attempts, err)
	}
}
