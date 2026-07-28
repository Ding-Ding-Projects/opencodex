package oauth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func quotaCacheAgainst(t *testing.T, handler http.HandlerFunc) (*AnthropicQuotaCache, *time.Time) {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	clock := time.Date(2026, 7, 28, 12, 0, 0, 0, time.UTC)
	cache := NewAnthropicQuotaCache()
	cache.Client = server.Client()
	cache.Now = func() time.Time { return clock }
	// Point the probe at the stub by overriding the transport rather than the
	// constant, so the production URL stays exercised.
	cache.Client = &http.Client{Transport: rewriteTransport{target: server.URL}}
	return cache, &clock
}

type rewriteTransport struct{ target string }

func (r rewriteTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	rewritten := request.Clone(request.Context())
	parsed, err := http.NewRequest(request.Method, r.target+request.URL.Path, nil)
	if err != nil {
		return nil, err
	}
	rewritten.URL = parsed.URL
	rewritten.Host = parsed.Host
	return http.DefaultTransport.RoundTrip(rewritten)
}

// A successful probe caches the percentage, and a second call inside the TTL
// does NOT hit the network again: the endpoint rate-limits, so N pollers must
// cost one call.
func TestAnthropicQuotaCachesWithinTTL(t *testing.T) {
	var calls atomic.Int64
	cache, clock := quotaCacheAgainst(t, func(writer http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"five_hour":{"utilization":42,"resets_at":1800000000}}`))
	})
	first := cache.Refresh(context.Background(), "acct-1", "bearer", false)
	if !first.Known() || *first.FiveHourPercent != 42 {
		t.Fatalf("first probe = %#v", first)
	}
	if first.FiveHourResetAt == nil {
		t.Fatal("resets_at was not parsed")
	}
	cache.Refresh(context.Background(), "acct-1", "bearer", false)
	if calls.Load() != 1 {
		t.Fatalf("probed %d times inside the TTL, want 1", calls.Load())
	}
	// Past the TTL it probes again.
	*clock = clock.Add(11 * time.Minute)
	cache.Refresh(context.Background(), "acct-1", "bearer", false)
	if calls.Load() != 2 {
		t.Fatalf("probed %d times after the TTL expired, want 2", calls.Load())
	}
}

// A failed probe PRESERVES the last good reading and marks it stale. Dropping
// it would make a healthy account look unknown and reshuffle every session on
// one transient 429.
func TestAnthropicQuotaPreservesLastGoodOnFailure(t *testing.T) {
	var fail atomic.Bool
	cache, clock := quotaCacheAgainst(t, func(writer http.ResponseWriter, _ *http.Request) {
		if fail.Load() {
			writer.WriteHeader(http.StatusTooManyRequests)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"five_hour":{"utilization":17}}`))
	})
	if got := cache.Refresh(context.Background(), "acct-1", "bearer", false); *got.FiveHourPercent != 17 {
		t.Fatalf("first probe = %#v", got)
	}
	fail.Store(true)
	*clock = clock.Add(11 * time.Minute)
	after := cache.Refresh(context.Background(), "acct-1", "bearer", false)
	if !after.Unavailable {
		t.Fatal("a failed probe must be marked unavailable")
	}
	if !after.Known() || *after.FiveHourPercent != 17 {
		t.Fatalf("the last good reading was lost: %#v", after)
	}
}

// Concurrent callers join ONE in-flight probe.
func TestAnthropicQuotaDeduplicatesInFlightProbes(t *testing.T) {
	var calls atomic.Int64
	release := make(chan struct{})
	cache, _ := quotaCacheAgainst(t, func(writer http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		<-release // hold the probe open so the others must join it
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"five_hour":{"utilization":5}}`))
	})
	var waiting sync.WaitGroup
	for i := 0; i < 5; i++ {
		waiting.Add(1)
		go func() {
			defer waiting.Done()
			cache.Refresh(context.Background(), "acct-1", "bearer", false)
		}()
	}
	time.Sleep(50 * time.Millisecond)
	close(release)
	waiting.Wait()
	if calls.Load() != 1 {
		t.Fatalf("five concurrent callers made %d upstream calls, want 1", calls.Load())
	}
}

// The selection path reads the cache synchronously and must never block on a
// network call. Lookup on an unprobed account returns immediately.
func TestAnthropicQuotaLookupNeverProbes(t *testing.T) {
	var calls atomic.Int64
	cache, _ := quotaCacheAgainst(t, func(writer http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		writer.WriteHeader(http.StatusOK)
	})
	if _, found := cache.Lookup("never-probed"); found {
		t.Fatal("Lookup invented an entry")
	}
	// Unknown scores as 100 so an unprobed account does not look emptiest and
	// attract every new session.
	if score := cache.UsageScore("never-probed"); score != 100 {
		t.Fatalf("unknown usage scored %v, want 100", score)
	}
	if calls.Load() != 0 {
		t.Fatalf("the selection path made %d network calls; it must make none", calls.Load())
	}
}

// Utilization arrives as a fraction in some responses and a percentage in
// others; a non-finite value is dropped rather than clamped, because NaN
// becoming 0 would make a drained account look empty.
func TestNormalizeQuotaPercent(t *testing.T) {
	value := func(v float64) *float64 { return &v }
	for _, testCase := range []struct {
		name string
		raw  *float64
		want *float64
	}{
		{name: "percentage", raw: value(42), want: value(42)},
		{name: "fraction is scaled", raw: value(0.42), want: value(42)},
		{name: "one is a fraction", raw: value(1), want: value(100)},
		{name: "over 100 clamps", raw: value(150), want: value(100)},
		{name: "negative clamps", raw: value(-5), want: value(0)},
		{name: "absent stays absent", raw: nil, want: nil},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			got := normalizeQuotaPercent(testCase.raw)
			if (got == nil) != (testCase.want == nil) {
				t.Fatalf("got %v, want %v", got, testCase.want)
			}
			if got != nil && *got != *testCase.want {
				t.Fatalf("got %v, want %v", *got, *testCase.want)
			}
		})
	}
}

// resets_at has been observed as epoch seconds, epoch millis and RFC 3339.
func TestNormalizeQuotaResetAt(t *testing.T) {
	if got := normalizeQuotaResetAt(float64(1800000000)); got == nil || got.Year() != 2027 {
		t.Fatalf("epoch seconds = %v", got)
	}
	if got := normalizeQuotaResetAt(float64(1800000000000)); got == nil || got.Year() != 2027 {
		t.Fatalf("epoch millis = %v", got)
	}
	if got := normalizeQuotaResetAt("2026-07-28T12:00:00Z"); got == nil || got.Year() != 2026 {
		t.Fatalf("rfc3339 = %v", got)
	}
	if got := normalizeQuotaResetAt("not a time"); got != nil {
		t.Fatalf("garbage parsed to %v", got)
	}
}
