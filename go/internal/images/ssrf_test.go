package images

// Differential against resolvePublicAddresses in src/lib/destination-policy.ts
// and the HTTPS gate in src/images/artifacts.ts. Every expectation was captured
// by RUNNING the oracle.

import (
	"context"
	"errors"
	"net"
	"strings"
	"testing"
)

func noLookup(t *testing.T) IPLookup {
	t.Helper()
	return func(context.Context, string) ([]net.IP, error) {
		t.Fatal("a literal address triggered DNS; the literal must be pinned directly")
		return nil, nil
	}
}

// Oracle: every unsafe literal is refused BEFORE any DNS happens, and the
// refusal names what it refused so an operator can tell a misconfiguration from
// an attack.
func TestResolvePublicAddressesRefusesUnsafeLiterals(t *testing.T) {
	for _, testCase := range []struct{ url, want string }{
		{"https://127.0.0.1/x.png", "image URL targets loopback address"},
		{"https://10.0.0.1/x.png", "image URL targets private-network address"},
		{"https://192.168.1.1/x.png", "image URL targets private-network address"},
		{"https://169.254.169.254/x.png", "image URL targets blocked metadata endpoint"},
		{"https://[::1]/x.png", "image URL targets loopback address"},
		{"https://0.0.0.0/x.png", "image URL targets unspecified address"},
		// Carrier-grade NAT is private too, which is easy to miss.
		{"https://100.64.0.1/x.png", "image URL targets private-network address"},
		{"https://localhost/x.png", "image URL targets localhost destination"},
		{"https://metadata.google.internal/x", "image URL targets blocked metadata endpoint"},
	} {
		_, _, err := ResolvePublicAddresses(context.Background(), testCase.url, noLookup(t))
		if err == nil || err.Error() != testCase.want {
			t.Fatalf("%s: err = %v, oracle returns %q", testCase.url, err, testCase.want)
		}
	}
}

// A public literal is pinned directly with no DNS round trip, which removes the
// only window a rebind could use.
func TestResolvePublicAddressesPinsAPublicLiteral(t *testing.T) {
	host, pinned, err := ResolvePublicAddresses(context.Background(), "https://8.8.8.8/x.png", noLookup(t))
	if err != nil {
		t.Fatal(err)
	}
	if host != "8.8.8.8" || len(pinned) != 1 || pinned[0].Address != "8.8.8.8" || pinned[0].Family != 4 {
		t.Fatalf("host = %q pinned = %#v", host, pinned)
	}
}

// An unparseable URL is refused, and a URL with no host is refused rather than
// being treated as relative.
func TestResolvePublicAddressesRefusesMalformedURLs(t *testing.T) {
	for _, raw := range []string{"not a url", "https:///x.png", ""} {
		if _, _, err := ResolvePublicAddresses(context.Background(), raw, noLookup(t)); err == nil {
			t.Fatalf("%q was accepted", raw)
		}
	}
}

// DNS failure is UNSAFE, not retryable: an unverifiable destination for an
// untrusted URL has to be refused.
func TestResolvePublicAddressesFailsClosedOnDNSFailure(t *testing.T) {
	failing := func(context.Context, string) ([]net.IP, error) { return nil, errors.New("nxdomain") }
	_, _, err := ResolvePublicAddresses(context.Background(), "https://images.example/x.png", failing)
	if err == nil || !strings.Contains(err.Error(), "could not be resolved") {
		t.Fatalf("err = %v", err)
	}
	// An empty answer is the same refusal, not an empty success.
	empty := func(context.Context, string) ([]net.IP, error) { return nil, nil }
	if _, _, err := ResolvePublicAddresses(context.Background(), "https://images.example/x.png", empty); err == nil {
		t.Fatal("an empty DNS answer was accepted")
	}
}

// A resolved private address is refused even though the hostname looked fine,
// which is the actual rebinding defence.
func TestResolvePublicAddressesRefusesPrivateResolution(t *testing.T) {
	private := func(context.Context, string) ([]net.IP, error) {
		return []net.IP{net.ParseIP("10.1.2.3")}, nil
	}
	_, _, err := ResolvePublicAddresses(context.Background(), "https://images.example/x.png", private)
	if err == nil || !strings.Contains(err.Error(), "private-network address") {
		t.Fatalf("err = %v", err)
	}

	// ONE bad address among good ones still refuses the whole set: connecting
	// to any of them would be enough.
	mixed := func(context.Context, string) ([]net.IP, error) {
		return []net.IP{net.ParseIP("8.8.8.8"), net.ParseIP("127.0.0.1")}, nil
	}
	if _, _, err := ResolvePublicAddresses(context.Background(), "https://images.example/x.png", mixed); err == nil {
		t.Fatal("a mixed public/loopback answer was accepted")
	}
}

// A fully public answer is pinned in full.
func TestResolvePublicAddressesPinsPublicAnswers(t *testing.T) {
	lookup := func(context.Context, string) ([]net.IP, error) {
		return []net.IP{net.ParseIP("2001:4860:4860::8888"), net.ParseIP("8.8.4.4")}, nil
	}
	host, pinned, err := ResolvePublicAddresses(context.Background(), "https://images.example/x.png", lookup)
	if err != nil || host != "images.example" || len(pinned) != 2 {
		t.Fatalf("host = %q pinned = %#v err = %v", host, pinned, err)
	}
	if pinned[0].Family != 6 || pinned[1].Family != 4 {
		t.Fatalf("families = %d/%d", pinned[0].Family, pinned[1].Family)
	}
	// IPv4 is preferred for the connection, so a broken IPv6 path is not
	// chosen ahead of a working one.
	chosen, ok := PickPinnedAddress(pinned)
	if !ok || chosen.Address != "8.8.4.4" {
		t.Fatalf("chosen = %#v", chosen)
	}
}

// Only HTTPS is allowed. Plain HTTP is refused along with everything else: an
// image fetched over a rewritable channel is worth no more than one fetched
// from the attacker's own host.
func TestRequireHTTPSImageURL(t *testing.T) {
	if err := RequireHTTPSImageURL("https://images.example/x.png"); err != nil {
		t.Fatalf("https was refused: %v", err)
	}
	for _, raw := range []string{
		"http://images.example/x.png",
		"ftp://images.example/x.png",
		"file:///etc/passwd",
		"data:image/png;base64,AAAA",
	} {
		if err := RequireHTTPSImageURL(raw); err == nil {
			t.Fatalf("%q was accepted", raw)
		}
	}
}
