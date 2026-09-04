package lib

import (
	"net/http"
	"strings"
	"testing"
)

func TestRedactionSurfaces(t *testing.T) {
	secret := "sk-abcdefghijk"
	if got := RedactSecretString("Bearer abcdefghijk " + secret); strings.Contains(got, secret) || !strings.Contains(got, RedactedSecret) {
		t.Fatalf("redacted string = %q", got)
	}
	headers := RedactHeaders(http.Header{"Authorization": {"Bearer abcdefghijk"}, "X-Trace": {secret}})
	if headers["authorization"] != RedactedSecret || strings.Contains(headers["x-trace"], secret) {
		t.Fatalf("headers = %#v", headers)
	}
	if got := RedactURLForLog("https://user:pass@example.com/v1?api_key=secret#frag"); got != "https://example.com/v1" {
		t.Fatalf("URL = %q", got)
	}
	if got := RedactUserPath("/Users/jun/token-cache/file"); strings.Contains(got, "jun") || strings.Contains(got, "token-cache") {
		t.Fatalf("path = %q", got)
	}
}
