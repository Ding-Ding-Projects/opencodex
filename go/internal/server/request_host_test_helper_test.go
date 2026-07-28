package server

import (
	"io"
	"net/http"
	"net/http/httptest"
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
	// Only override the synthetic default. A test that deliberately sets a
	// remote Host keeps it.
	if request.Host == "example.com" {
		request.Host = "127.0.0.1:10100"
	}
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
}
