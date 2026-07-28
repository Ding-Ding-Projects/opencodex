package images

// SSRF controls for provider-returned image URLs, ported from the
// resolvePublicAddresses half of src/lib/destination-policy.ts and the
// pinnedHttpsGet transport in src/images/artifacts.ts.
//
// A provider hands us a URL and we fetch it. That is an SSRF primitive unless
// every step refuses by default, so this file resolves DNS exactly once,
// refuses anything that is not a public address, and then PINS that address for
// the connection. Re-resolving at connect time is what a rebinding answer
// exploits, and keeping the hostname only for SNI and Host is what makes the
// pin safe to use.

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"

	ocxlib "github.com/lidge-jun/opencodex-go/internal/lib"
)

// PinnedAddress is a validated peer to connect to.
type PinnedAddress struct {
	Address string
	Family  int
}

// IPLookup resolves a hostname. Injectable so tests never touch real DNS.
type IPLookup func(ctx context.Context, host string) ([]net.IP, error)

// ResolvePublicAddresses validates a URL and returns the addresses to pin.
//
// DNS failure is treated as UNSAFE rather than retried or ignored: this is a
// runtime fetch of an untrusted URL, so an unverifiable destination is refused.
func ResolvePublicAddresses(ctx context.Context, rawURL string, lookup IPLookup) (string, []PinnedAddress, error) {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || parsed.Hostname() == "" {
		return "", nil, errors.New("image URL is not a valid URL")
	}
	hostname := strings.ToLower(strings.TrimSuffix(parsed.Hostname(), "."))
	if hostname == "" {
		return "", nil, errors.New("image URL has no hostname")
	}

	// A hostname that is itself unsafe, such as localhost or a metadata name,
	// is refused before any resolution happens.
	if kind, detail := ocxlib.ClassifyDestinationHost(hostname); kind != "public" && kind != "hostname" {
		return "", nil, fmt.Errorf("image URL targets %s", detail)
	}

	// A literal IP needs no DNS round trip, and pinning the literal itself
	// removes the only window a rebind could use.
	if literal := net.ParseIP(hostname); literal != nil {
		return hostname, []PinnedAddress{{Address: hostname, Family: ipFamily(literal)}}, nil
	}

	if lookup == nil {
		lookup = defaultIPLookup
	}
	addresses, err := lookup(ctx, hostname)
	if err != nil || len(addresses) == 0 {
		return "", nil, fmt.Errorf("image URL hostname %s could not be resolved", hostname)
	}

	pinned := make([]PinnedAddress, 0, len(addresses))
	for _, address := range addresses {
		// Classified from the ADDRESS itself rather than from anything the
		// resolver claimed about it, so a mislabelled family cannot skip the
		// private-range checks.
		kind, detail := ocxlib.ClassifyDestinationIP(address)
		if kind != "public" {
			return "", nil, fmt.Errorf("image URL hostname %s resolves to %s (%s)", hostname, detail, address)
		}
		pinned = append(pinned, PinnedAddress{Address: address.String(), Family: ipFamily(address)})
	}
	return hostname, pinned, nil
}

func ipFamily(ip net.IP) int {
	if ip.To4() != nil {
		return 4
	}
	return 6
}

func defaultIPLookup(ctx context.Context, host string) ([]net.IP, error) {
	return net.DefaultResolver.LookupIP(ctx, "ip", host)
}

// PickPinnedAddress prefers IPv4, matching the oracle, so a host with a broken
// IPv6 path is not preferred into a failure.
func PickPinnedAddress(addresses []PinnedAddress) (PinnedAddress, bool) {
	if len(addresses) == 0 {
		return PinnedAddress{}, false
	}
	for _, address := range addresses {
		if address.Family == 4 {
			return address, true
		}
	}
	return addresses[0], true
}

// RequireHTTPSImageURL refuses any scheme other than HTTPS.
//
// Plain HTTP is refused along with everything else: an image fetched over a
// channel an attacker can rewrite is worth no more than one fetched from an
// attacker's host directly.
func RequireHTTPSImageURL(rawURL string) error {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return errors.New("image URL is not a valid URL")
	}
	if parsed.Scheme != "https" {
		return fmt.Errorf("image URL must use HTTPS, got %s:", parsed.Scheme)
	}
	return nil
}
