package server

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

type doerFunc func(*http.Request) (*http.Response, error)

func (f doerFunc) Do(request *http.Request) (*http.Response, error) { return f(request) }

func TestSafeHostLabel(t *testing.T) {
	if got := SafeHostLabel("https://user:secret@example.com:8443/v1"); got != "example.com:8443" {
		t.Fatalf("label = %q", got)
	}
	if got := SafeHostLabel("not a URL"); got != "upstream" {
		t.Fatalf("invalid label = %q", got)
	}
}

func TestFetchWithHeaderTimeoutDoesNotCancelReturnedBody(t *testing.T) {
	request, _ := http.NewRequest(http.MethodGet, "https://example.com/responses", nil)
	doer := doerFunc(func(request *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader("stream remains readable"))}, nil
	})
	response, err := FetchWithHeaderTimeout(context.Background(), doer, request, time.Second, true)
	if err != nil {
		t.Fatal(err)
	}
	payload, err := io.ReadAll(response.Body)
	if err != nil || string(payload) != "stream remains readable" {
		t.Fatalf("body = %q, err = %v", payload, err)
	}
}

func TestFetchWithHeaderTimeoutAndIdentityEncoding(t *testing.T) {
	request, _ := http.NewRequest(http.MethodPost, "https://example.com/responses", nil)
	doer := doerFunc(func(request *http.Request) (*http.Response, error) {
		if request.Header.Get("Accept-Encoding") != "identity" {
			t.Fatalf("Accept-Encoding = %q", request.Header.Get("Accept-Encoding"))
		}
		<-request.Context().Done()
		return nil, request.Context().Err()
	})
	_, err := FetchWithHeaderTimeout(context.Background(), doer, request, 5*time.Millisecond, true)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("error = %v", err)
	}
	if request.Header.Get("Accept-Encoding") != "" {
		t.Fatal("caller request was mutated")
	}
}
