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

// The oracle's normalizePercent is a plain clamp with NO rescaling. These
// expectations were captured by running its exact expression:
//
//	42 -> 42, 0.42 -> 0.42, 1 -> 1, 150 -> 100, -5 -> 0, NaN -> undefined
//
// An earlier version of this port rescaled values in (0,1] by 100, which
// turned an account at 0.42% into one at 42% and changed which account
// rotation picked. A non-finite value is dropped rather than clamped, matching
// toFiniteNumber returning undefined.
func TestNormalizeQuotaPercent(t *testing.T) {
	value := func(v float64) *float64 { return &v }
	for _, testCase := range []struct {
		name string
		raw  *float64
		want *float64
	}{
		{name: "percentage passes through", raw: value(42), want: value(42)},
		{name: "a small value is NOT rescaled", raw: value(0.42), want: value(0.42)},
		{name: "one stays one", raw: value(1), want: value(1)},
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

// Expected epoch-millisecond values captured by RUNNING the oracle's
// normalizeResetAt expression from src/providers/quota.ts.
//
// The boundary cases are the point. The seconds-vs-millis cutoff is EXACTLY
// 10_000_000_000: 10000000000 is still treated as seconds and multiplied,
// while 10000000001 is already milliseconds. And "1771077734000" must be read
// as a numeric epoch string, because Date.parse rejects it — treating it as
// text would silently drop the reset time.
func TestNormalizeQuotaResetAtMatchesTheOracle(t *testing.T) {
	for _, testCase := range []struct {
		name string
		raw  any
		want int64 // oracle's epoch milliseconds; 0 means undefined
	}{
		{name: "epoch seconds", raw: float64(1800000000), want: 1800000000000},
		{name: "epoch millis", raw: float64(1800000000000), want: 1800000000000},
		{name: "exactly at the cutoff is seconds", raw: float64(10000000000), want: 10000000000000},
		{name: "one past the cutoff is millis", raw: float64(10000000001), want: 10000000001},
		{name: "numeric epoch string", raw: "1771077734000", want: 1771077734000},
		{name: "rfc3339", raw: "2026-07-28T12:00:00Z", want: 1785240000000},
		{name: "garbage", raw: "not a time", want: 0},
		{name: "empty", raw: "", want: 0},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			got := normalizeQuotaResetAt(testCase.raw)
			if testCase.want == 0 {
				if got != nil {
					t.Fatalf("got %v, oracle returns undefined", got)
				}
				return
			}
			if got == nil {
				t.Fatalf("got nil, oracle returns %d", testCase.want)
			}
			if got.UnixMilli() != testCase.want {
				t.Fatalf("got %d ms, oracle returns %d ms", got.UnixMilli(), testCase.want)
			}
		})
	}
}

// The oracle's toFiniteNumber accepts a numeric STRING, so utilization may
// arrive as "0.42". Decoding into *float64 made the whole response fail, which
// turned a known percentage into an unknown one and reshuffled rotation.
func TestAnthropicQuotaAcceptsAStringUtilization(t *testing.T) {
	cache, _ := quotaCacheAgainst(t, func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"five_hour":{"utilization":"0.42","resets_at":"1800000000"}}`))
	})
	got := cache.Refresh(context.Background(), "acct-1", "bearer", false)
	if !got.Known() {
		t.Fatalf("a string utilization was dropped: %#v", got)
	}
	// Plain clamp, no rescaling: the oracle returns 0.42 for 0.42.
	if *got.FiveHourPercent != 0.42 {
		t.Fatalf("percent = %v, oracle returns 0.42", *got.FiveHourPercent)
	}
	if got.FiveHourResetAt == nil || got.FiveHourResetAt.UnixMilli() != 1800000000000 {
		t.Fatalf("numeric reset string = %v, oracle returns 1800000000000 ms", got.FiveHourResetAt)
	}
}

// toFiniteNumber rejects a non-numeric string rather than coercing it to zero,
// which would make a drained account look empty.
func TestToFiniteNumberMatchesTheOracle(t *testing.T) {
	for _, testCase := range []struct {
		raw  any
		want *float64
	}{
		{raw: float64(42), want: func() *float64 { v := 42.0; return &v }()},
		{raw: "0.42", want: func() *float64 { v := 0.42; return &v }()},
		{raw: " 7 ", want: func() *float64 { v := 7.0; return &v }()},
		{raw: "", want: nil},
		{raw: "abc", want: nil},
		{raw: nil, want: nil},
		{raw: true, want: nil},
	} {
		got := toFiniteNumber(testCase.raw)
		if (got == nil) != (testCase.want == nil) {
			t.Fatalf("toFiniteNumber(%#v) = %v, want %v", testCase.raw, got, testCase.want)
		}
		if got != nil && *got != *testCase.want {
			t.Fatalf("toFiniteNumber(%#v) = %v, want %v", testCase.raw, *got, *testCase.want)
		}
	}
}

// A stalled upstream must not hold the in-flight entry open forever. Without a
// deadline one hung connection freezes quota refresh for the whole pool
// instead of degrading to the last-good reading.
func TestAnthropicQuotaProbeHasADeadline(t *testing.T) {
	block := make(chan struct{})
	t.Cleanup(func() { close(block) })
	cache, _ := quotaCacheAgainst(t, func(writer http.ResponseWriter, request *http.Request) {
		select {
		case <-block:
		case <-request.Context().Done():
		}
	})
	// Shorten the wait: the production deadline is 8s, but the point is that a
	// deadline EXISTS and the caller is released rather than blocked forever.
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	done := make(chan AccountQuota, 1)
	go func() { done <- cache.Refresh(ctx, "acct-1", "bearer", false) }()
	select {
	case got := <-done:
		if !got.Unavailable {
			t.Fatalf("a stalled probe must report unavailable: %#v", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Refresh never returned; the probe has no deadline")
	}
}
