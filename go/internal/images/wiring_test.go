package images

import (
	"net"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/config"
)

// The config stores maxRounds as *int; the clamp takes the *float64 the
// oracle's flooring semantics require. Until these two met, a configured
// budget could not reach anything that spends money.
func TestTheConfiguredRoundBudgetIsResolvedAndClamped(t *testing.T) {
	if got := ResolveMaxRounds(nil); got != DefaultMaxRounds {
		t.Fatalf("absent config = %d, want the default %d", got, DefaultMaxRounds)
	}
	if got := ResolveMaxRounds(&config.ImagesConfig{}); got != DefaultMaxRounds {
		t.Fatalf("absent maxRounds = %d, want the default %d", got, DefaultMaxRounds)
	}
	for _, testCase := range []struct {
		configured int
		want       int
	}{
		// An explicit 0 is a real setting: spend nothing, still answer.
		{configured: 0, want: 0},
		{configured: 2, want: 2},
		{configured: 10000, want: MaxRoundsHardLimit},
		{configured: -5, want: 0},
	} {
		rounds := testCase.configured
		if got := ResolveMaxRounds(&config.ImagesConfig{MaxRounds: &rounds}); got != testCase.want {
			t.Fatalf("maxRounds %d resolved to %d, want %d", testCase.configured, got, testCase.want)
		}
	}
}

// The pinning is the DNS-rebinding defence: the name is resolved and validated
// once, above this function, and the connection must not be able to reach any
// other address afterwards. This proves the dial really goes to the pinned
// address rather than re-resolving the hostname.
func TestTheDownloaderDialsThePinnedAddressNotTheHostname(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("body"))
	}))
	defer server.Close()
	host, port, err := net.SplitHostPort(server.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}

	// A hostname that does not resolve anywhere. If the downloader used it,
	// the dial would fail; reaching the server proves the pin was used.
	status, body, err := PinnedDownloader(http.DefaultClient)(
		t.Context(),
		"http://unresolvable.invalid:"+port+"/image.png",
		PinnedAddress{Address: host},
	)
	if err != nil {
		t.Fatalf("the download did not use the pinned address: %v", err)
	}
	defer body.Close()
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
}

// A redirect is a second destination nobody validated. It must come back as a
// status for download.go to refuse, not be followed.
func TestTheDownloaderDoesNotFollowRedirects(t *testing.T) {
	var reached int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		reached++
		if request.URL.Path == "/start" {
			http.Redirect(w, request, "/elsewhere", http.StatusFound)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	host, port, err := net.SplitHostPort(server.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}

	status, body, err := PinnedDownloader(http.DefaultClient)(
		t.Context(),
		"http://"+net.JoinHostPort(host, port)+"/start",
		PinnedAddress{Address: host},
	)
	if err != nil {
		t.Fatalf("download: %v", err)
	}
	defer body.Close()
	if status != http.StatusFound {
		t.Fatalf("status = %d, want the redirect surfaced as %d", status, http.StatusFound)
	}
	if reached != 1 {
		t.Fatalf("the downloader followed the redirect: %d requests", reached)
	}
}

// The assembled fulfiller must satisfy the driver's contract: report failure in
// the result rather than returning an error, so a bad argument becomes
// something the model can read instead of killing the turn.
func TestTheAssembledFulfillerReportsFailureInTheResult(t *testing.T) {
	fulfill := NewFulfiller(http.DefaultClient, t.TempDir(), Plan{Model: "m"})
	result := fulfill(t.Context(), ImageCall{ID: "c", Name: "image_gen", Args: `{}`})
	if result.OK || result.Error != "missing prompt" {
		t.Fatalf("result = %#v", result)
	}
	// Never nil: the driver serializes Files directly into a tool result, and
	// a nil slice would reach the model as JSON null rather than an empty list.
	if result.Files == nil {
		t.Fatal("a refused call produced a nil file list")
	}
	// A refusal must not have spent anything upstream, which is observable
	// here as the model name being carried through without a prompt.
	if result.Model != "m" || result.Prompt != "" {
		t.Fatalf("result = %#v", result)
	}
}
