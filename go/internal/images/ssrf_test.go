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

// IPv6 is an ALLOWLIST of global unicast, not a blocklist of known-bad ranges.
//
// A blocklist admitted NAT64, which wraps an arbitrary IPv4 — loopback
// included — inside an address that looks unfamiliar rather than unsafe. Every
// case here was measured against the oracle.
func TestResolvePublicAddressesUsesAnIPv6Allowlist(t *testing.T) {
	for _, testCase := range []struct{ url, want string }{
		// IPv4-mapped, both spellings the oracle handles, must be judged as
		// the IPv4 they carry.
		{"https://[::ffff:127.0.0.1]/x", "image URL targets loopback address"},
		{"https://[::ffff:10.0.0.1]/x", "image URL targets private-network address"},
		// NAT64 wrapping loopback: refused as non-global.
		{"https://[64:ff9b::7f00:1]/x", "image URL targets non-global address"},
		{"https://[fc00::1]/x", "image URL targets private-network address"},
		{"https://[fe80::1]/x", "image URL targets link-local address"},
		{"https://[2001:db8::1]/x", "image URL targets documentation address"},
	} {
		_, _, err := ResolvePublicAddresses(context.Background(), testCase.url, noLookup(t))
		if err == nil || err.Error() != testCase.want {
			t.Fatalf("%s: err = %v, oracle returns %q", testCase.url, err, testCase.want)
		}
	}

	// Global unicast is allowed, including 6to4, which the oracle also permits
	// because it falls inside 2000::/3.
	for _, allowed := range []string{"https://[2606:4700::1111]/x", "https://[2002:7f00:1::]/x"} {
		if _, _, err := ResolvePublicAddresses(context.Background(), allowed, noLookup(t)); err != nil {
			t.Fatalf("%s was refused: %v", allowed, err)
		}
	}
}

// The allowlist applies to RESOLVED addresses too, not only to literals, since
// that is the path a rebinding answer would take.
func TestResolvedIPv6IsAllowlistedToo(t *testing.T) {
	nat64 := func(context.Context, string) ([]net.IP, error) {
		return []net.IP{net.ParseIP("64:ff9b::7f00:1")}, nil
	}
	_, _, err := ResolvePublicAddresses(context.Background(), "https://images.example/x.png", nat64)
	if err == nil || !strings.Contains(err.Error(), "non-global address") {
		t.Fatalf("err = %v, want a non-global refusal", err)
	}
	mapped := func(context.Context, string) ([]net.IP, error) {
		return []net.IP{net.ParseIP("::ffff:169.254.169.254")}, nil
	}
	if _, _, err := ResolvePublicAddresses(context.Background(), "https://images.example/x.png", mapped); err == nil ||
		!strings.Contains(err.Error(), "metadata") {
		t.Fatalf("mapped metadata err = %v", err)
	}
}

// The whole of 0.0.0.0/8 is unusable as a destination, not just 0.0.0.0
// itself. Go's IsUnspecified covers only the exact address, so 0.0.0.1 would
// otherwise be treated as a public peer. Measured against the oracle, which
// refuses the entire block.
func TestResolvePublicAddressesRefusesTheWholeZeroBlock(t *testing.T) {
	for _, raw := range []string{"https://0.0.0.0/x", "https://0.0.0.1/x", "https://0.255.255.255/x"} {
		_, _, err := ResolvePublicAddresses(context.Background(), raw, noLookup(t))
		if err == nil || err.Error() != "image URL targets unspecified address" {
			t.Fatalf("%s: err = %v, oracle refuses the whole 0.0.0.0/8 block", raw, err)
		}
	}
	// A resolved answer in that block is refused too.
	zeroBlock := func(context.Context, string) ([]net.IP, error) {
		return []net.IP{net.ParseIP("0.0.0.1")}, nil
	}
	if _, _, err := ResolvePublicAddresses(context.Background(), "https://images.example/x", zeroBlock); err == nil {
		t.Fatal("a resolved 0.0.0.0/8 answer was accepted")
	}
}

// Userinfo is accepted, matching the oracle for IMAGE urls specifically.
//
// The provider-config policy rejects it because an operator writing a base URL
// with embedded credentials is a misconfiguration; a provider returning an
// image URL with them is not this layer's decision to override, and diverging
// here would refuse images the oracle fetches. Pinned so the difference from
// the config policy is deliberate and visible rather than an oversight.
func TestResolvePublicAddressesAcceptsUserinfoLikeTheOracle(t *testing.T) {
	host, pinned, err := ResolvePublicAddresses(context.Background(), "https://user:pass@8.8.8.8/x", noLookup(t))
	if err != nil || host != "8.8.8.8" || len(pinned) != 1 {
		t.Fatalf("host = %q pinned = %#v err = %v", host, pinned, err)
	}
}
