package oauth

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"
	"time"
)

func TestDeviceFlowPendingSlowDownThenSuccess(t *testing.T) {
	var mu sync.Mutex
	var polls int
	var pollForms []url.Values
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/device":
			_, _ = w.Write([]byte(`{"device_code":"secret-device","user_code":"ABCD","verification_uri":"https://example.com/device","expires_in":60,"interval":2}`))
		case "/token":
			if err := r.ParseForm(); err != nil {
				t.Error(err)
			}
			mu.Lock()
			polls++
			pollForms = append(pollForms, r.PostForm)
			current := polls
			mu.Unlock()
			switch current {
			case 1:
				_, _ = w.Write([]byte(`{"error":"authorization_pending"}`))
			case 2:
				_, _ = w.Write([]byte(`{"error":"slow_down","interval":9}`))
			default:
				_, _ = w.Write([]byte(`{"access_token":"access","refresh_token":"refresh","expires_in":3600}`))
			}
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	now := time.Unix(1000, 0)
	var waits []time.Duration
	flow := NewDeviceFlow(server.Client(), DeviceFlowConfig{
		ClientID: "client", Scope: "read", DeviceAuthorizationURL: server.URL + "/device", TokenURL: server.URL + "/token",
		MinimumPollInterval: time.Second, ExpirySkew: 5 * time.Minute, AllowInsecureEndpoints: true,
	})
	flow.Now = func() time.Time { return now }
	flow.Wait = func(_ context.Context, duration time.Duration) error {
		waits = append(waits, duration)
		now = now.Add(duration)
		return nil
	}
	authorization, err := flow.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	credential, err := flow.Poll(context.Background(), authorization)
	if err != nil {
		t.Fatal(err)
	}
	if credential.Access != "access" || credential.Refresh != "refresh" || credential.Source != SourceOAuth {
		t.Fatalf("credential = %#v", credential)
	}
	wantWaits := []time.Duration{2 * time.Second, 2 * time.Second, 9 * time.Second}
	if len(waits) != len(wantWaits) {
		t.Fatalf("waits = %v", waits)
	}
	for index := range wantWaits {
		if waits[index] != wantWaits[index] {
			t.Fatalf("waits[%d] = %v, want %v", index, waits[index], wantWaits[index])
		}
	}
	if pollForms[0].Get("device_code") != "secret-device" || pollForms[0].Get("grant_type") != deviceGrantType {
		t.Fatalf("poll form = %v", pollForms[0])
	}
}

func TestDeviceFlowRejectsUnsafeVerificationURI(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"device_code":"secret","user_code":"ABCD","verification_uri":"http://evil.example/device","expires_in":60}`))
	}))
	defer server.Close()
	flow := NewDeviceFlow(server.Client(), DeviceFlowConfig{ClientID: "client", DeviceAuthorizationURL: server.URL, TokenURL: server.URL, AllowInsecureEndpoints: true})
	if _, err := flow.Start(context.Background()); err == nil {
		t.Fatal("expected unsafe verification URI to fail")
	}
}

func TestDeviceFlowCancellation(t *testing.T) {
	flow := NewDeviceFlow(nil, DeviceFlowConfig{ClientID: "client", DeviceAuthorizationURL: "https://example.com/device", TokenURL: "https://example.com/token"})
	flow.Now = func() time.Time { return time.Unix(1000, 0) }
	flow.Wait = func(ctx context.Context, _ time.Duration) error { return ctx.Err() }
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := flow.Poll(ctx, DeviceAuthorization{DeviceCode: "secret", ExpiresAt: time.Unix(1100, 0), Interval: time.Second})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Poll error = %v, want context canceled", err)
	}
}

func TestDeviceFlowAccessDeniedRedactsDeviceCode(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"error":"access_denied","error_description":"secret-device was denied"}`))
	}))
	defer server.Close()
	now := time.Unix(1000, 0)
	flow := NewDeviceFlow(server.Client(), DeviceFlowConfig{ClientID: "client", DeviceAuthorizationURL: server.URL, TokenURL: server.URL, AllowInsecureEndpoints: true})
	flow.Now = func() time.Time { return now }
	flow.Wait = func(_ context.Context, duration time.Duration) error { now = now.Add(duration); return nil }
	_, err := flow.Poll(context.Background(), DeviceAuthorization{DeviceCode: "secret-device", ExpiresAt: now.Add(time.Minute), Interval: time.Second})
	var denied *DeviceAuthorizationError
	if !errors.As(err, &denied) || denied.Code != "access_denied" || denied.Description != "[REDACTED] was denied" {
		t.Fatalf("Poll error = %#v", err)
	}
}

func TestDeviceFlowRejectsOversizedResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(make([]byte, maxDeviceResponseBytes+1))
	}))
	defer server.Close()
	flow := NewDeviceFlow(server.Client(), DeviceFlowConfig{ClientID: "client", DeviceAuthorizationURL: server.URL, TokenURL: server.URL, AllowInsecureEndpoints: true})
	if _, err := flow.Start(context.Background()); err == nil {
		t.Fatal("expected oversized response to fail")
	}
}
