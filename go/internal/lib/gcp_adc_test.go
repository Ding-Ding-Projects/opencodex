package lib

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) { return fn(request) }

func adcTestResolver(t *testing.T, credentials map[string]string, handler roundTripFunc) *ADCResolver {
	t.Helper()
	path := filepath.Join(t.TempDir(), "adc.json")
	data, err := json.Marshal(credentials)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	env := map[string]string{"GOOGLE_APPLICATION_CREDENTIALS": path}
	resolver := NewADCResolver()
	resolver.Client = &http.Client{Transport: handler}
	resolver.Env = func(key string) string { return env[key] }
	resolver.Now = func() time.Time { return time.Unix(1_700_000_000, 0) }
	return resolver
}

func TestADCAuthorizedUserExchangeAndCache(t *testing.T) {
	var calls atomic.Int32
	resolver := adcTestResolver(t, map[string]string{
		"type": "authorized_user", "client_id": "client", "client_secret": "secret", "refresh_token": "refresh",
	}, func(request *http.Request) (*http.Response, error) {
		calls.Add(1)
		body, _ := io.ReadAll(request.Body)
		for _, expected := range []string{"client_id=client", "client_secret=secret", "refresh_token=refresh", "grant_type=refresh_token"} {
			if !strings.Contains(string(body), expected) {
				t.Fatalf("request body %q missing %q", body, expected)
			}
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"access_token":"token-1","expires_in":3600}`)), Header: make(http.Header)}, nil
	})

	for range 2 {
		token, err := resolver.AccessToken(context.Background())
		if err != nil || token != "token-1" {
			t.Fatalf("AccessToken() = %q, %v", token, err)
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("token endpoint calls = %d, want 1", calls.Load())
	}
}

func TestADCConcurrentCallersShareRefresh(t *testing.T) {
	var calls atomic.Int32
	started := make(chan struct{})
	release := make(chan struct{})
	resolver := adcTestResolver(t, map[string]string{
		"type": "authorized_user", "client_id": "client", "client_secret": "secret", "refresh_token": "refresh",
	}, func(*http.Request) (*http.Response, error) {
		calls.Add(1)
		close(started)
		<-release
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"access_token":"shared","expires_in":3600}`)), Header: make(http.Header)}, nil
	})

	var wg sync.WaitGroup
	results := make(chan string, 8)
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			token, err := resolver.AccessToken(context.Background())
			if err != nil {
				results <- err.Error()
				return
			}
			results <- token
		}()
	}
	<-started
	close(release)
	wg.Wait()
	close(results)
	for result := range results {
		if result != "shared" {
			t.Fatalf("result = %q, want shared", result)
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("token endpoint calls = %d, want 1", calls.Load())
	}
}

func TestADCMetadataFallbackAndHeader(t *testing.T) {
	resolver := NewADCResolver()
	resolver.Env = func(string) string { return "" }
	resolver.Home = func() (string, error) { return t.TempDir(), nil }
	resolver.Client = &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.String() != googleMetadataURL || request.Header.Get("Metadata-Flavor") != "Google" {
			t.Fatalf("unexpected metadata request: %s headers=%v", request.URL, request.Header)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"access_token":"metadata-token","expires_in":300}`)), Header: make(http.Header)}, nil
	})}
	token, err := resolver.AccessToken(context.Background())
	if err != nil || token != "metadata-token" {
		t.Fatalf("AccessToken() = %q, %v", token, err)
	}
}

func TestADCFailuresDoNotLeakCredentialValues(t *testing.T) {
	resolver := adcTestResolver(t, map[string]string{
		"type": "authorized_user", "client_id": "client", "client_secret": "SUPER-SECRET", "refresh_token": "REFRESH-SECRET",
	}, func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 401, Body: io.NopCloser(strings.NewReader(`{"error":"contains REFRESH-SECRET"}`)), Header: make(http.Header)}, nil
	})
	_, err := resolver.AccessToken(context.Background())
	if err == nil {
		t.Fatal("expected token exchange failure")
	}
	if strings.Contains(err.Error(), "SECRET") {
		t.Fatalf("error leaked credential: %v", err)
	}
}

func TestADCRetriesTransientTokenStatus(t *testing.T) {
	var calls atomic.Int32
	var sleeps atomic.Int32
	resolver := adcTestResolver(t, map[string]string{
		"type": "authorized_user", "client_id": "client", "client_secret": "secret", "refresh_token": "refresh",
	}, func(*http.Request) (*http.Response, error) {
		if calls.Add(1) == 1 {
			return &http.Response{StatusCode: 503, Body: io.NopCloser(strings.NewReader("unavailable")), Header: make(http.Header)}, nil
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"access_token":"retried","expires_in":3600}`)), Header: make(http.Header)}, nil
	})
	resolver.Sleep = func(context.Context, time.Duration) error { sleeps.Add(1); return nil }
	token, err := resolver.AccessToken(context.Background())
	if err != nil || token != "retried" {
		t.Fatalf("AccessToken() = %q, %v", token, err)
	}
	if calls.Load() != 2 || sleeps.Load() != 1 {
		t.Fatalf("calls=%d sleeps=%d", calls.Load(), sleeps.Load())
	}
}
