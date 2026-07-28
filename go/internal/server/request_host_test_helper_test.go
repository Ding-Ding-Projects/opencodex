package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

// httptest.NewRequest fills an absent Host with "example.com".
//
// That is a synthetic value no real client ever sends: net/http populates
// r.Host from the connection, so a request reaching a loopback-bound proxy
// arrives as 127.0.0.1:<port>. Verified with a live httptest.Server, which
// reports r.Host="127.0.0.1:58987".
//
// It matters because the loopback Host gate refuses "example.com", and
// correctly so: the oracle refuses it too. Before this helper existed, the Go
// gate carried a `config.Port > 0` condition that skipped the check entirely
// whenever a test left Port unset -- which silently disabled the gate for most
// of this package's tests and hid the fact that they were sending an
// impossible Host.
//
// loopbackRequest builds the request the production path actually sees.
// The signature mirrors httptest.NewRequest so the call sites are a
// drop-in replacement.
func loopbackRequest(method, target string, body io.Reader) *http.Request {
	request := httptest.NewRequest(method, target, body)
	// The substitution is keyed on the TARGET carrying no authority, not on
	// the resulting Host string.
	//
	// Matching `Host == "example.com"` after the fact cannot tell httptest's
	// synthetic filler from a test that deliberately requested
	// `http://example.com/...`, and would rewrite that one to loopback too --
	// turning an assertion that a remote Host is REFUSED into one that passes
	// for the wrong reason. A reviewer flagged exactly that trap.
	if parsed, err := url.Parse(target); err == nil && parsed.Host != "" {
		return request // the caller named an authority, so it is theirs
	}
	request.Host = "127.0.0.1:10100"
	return request
}

// The helper must not paper over the gate: a deliberately remote Host has to
// stay remote, or a test asserting rejection would silently start passing for
// the wrong reason.
func TestLoopbackRequestHelperPreservesADeliberateHost(t *testing.T) {
	request := httptest.NewRequest("GET", "http://attacker.test/v1/models", nil)
	if request.Host != "attacker.test" {
		t.Fatalf("precondition: Host = %q", request.Host)
	}
	if got := loopbackRequest("GET", "http://attacker.test/v1/models", nil); got.Host != "attacker.test" {
		t.Fatalf("the helper overwrote a deliberate Host: %q", got.Host)
	}
	if got := loopbackRequest("GET", "/healthz", nil); got.Host != "127.0.0.1:10100" {
		t.Fatalf("the helper did not replace the synthetic default: %q", got.Host)
	}
	// The case the reviewer named: an explicit example.com must survive,
	// because the oracle refuses it and a test may be asserting that.
	if got := loopbackRequest("GET", "http://example.com/v1/models", nil); got.Host != "example.com" {
		t.Fatalf("a deliberate example.com Host was rewritten to %q", got.Host)
	}
}
