package cursor

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
)

type discoveryRoundTripFunc func(*http.Request) (*http.Response, error)

func (f discoveryRoundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func TestDiscoverModelsRetriesOneTransientTransportFailure(t *testing.T) {
	var attempts atomic.Int32
	payload := appendMessage(nil, 1, appendString(nil, 1, "gpt-5.6-sol-high"))
	client := &http.Client{Transport: discoveryRoundTripFunc(func(req *http.Request) (*http.Response, error) {
		if attempts.Add(1) == 1 {
			return nil, errors.New("connection reset by peer")
		}
		if got := req.Header.Get("Content-Type"); got != "application/proto" {
			t.Fatalf("content-type = %q", got)
		}
		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(string(payload)))}, nil
	})}

	models, err := discoverModels(context.Background(), client, "https://cursor.test", "token", discoveryOptions{retryDelay: 0})
	if err != nil {
		t.Fatal(err)
	}
	if attempts.Load() != 2 || len(models) != 1 || models[0] != "gpt-5.6-sol-high" {
		t.Fatalf("attempts = %d, models = %#v", attempts.Load(), models)
	}
}

func TestDiscoverModelsDoesNotRetryAuthenticationFailure(t *testing.T) {
	var attempts atomic.Int32
	client := &http.Client{Transport: discoveryRoundTripFunc(func(*http.Request) (*http.Response, error) {
		attempts.Add(1)
		return &http.Response{StatusCode: http.StatusUnauthorized, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("unauthorized"))}, nil
	})}

	_, err := discoverModels(context.Background(), client, "https://cursor.test", "token", discoveryOptions{retryDelay: 0})
	var cursorErr *CursorError
	if !errors.As(err, &cursorErr) || cursorErr.Kind != ErrorAuth {
		t.Fatalf("error = %#v", err)
	}
	if attempts.Load() != 1 {
		t.Fatalf("auth attempts = %d, want 1", attempts.Load())
	}
}

func TestNormalizeAndFilterCursorModelsAgainstLiveEffortVariants(t *testing.T) {
	models := NormalizeCursorModels([]CursorModelInfo{
		{ID: " gpt-5.6-sol ", SupportsReasoningEffort: true, InputModalities: []string{"text", "image", "text"}},
		{ID: "auto"},
		{ID: "missing"},
		{ID: "gpt-5.6-sol"},
		{ID: ""},
	})
	if len(models) != 3 || models[0].ID != "auto" || models[1].ID != "gpt-5.6-sol" {
		t.Fatalf("normalized models = %#v", models)
	}
	if models[1].ContextWindow != 1_000_000 || len(models[1].InputModalities) != 2 {
		t.Fatalf("normalized gpt model = %#v", models[1])
	}
	filtered := FilterCursorConfiguredModelsByLiveDiscovery(models, []string{"cursor-gpt-5.6-sol-high", "missing-preview"})
	if len(filtered) != 2 || filtered[0].ID != "auto" || filtered[1].ID != "gpt-5.6-sol" {
		t.Fatalf("filtered models = %#v", filtered)
	}
	if IsCursorModelAvailableForAccount("missing", []string{"missing-preview"}) {
		t.Fatal("noncanonical suffix admitted configured model")
	}
}
