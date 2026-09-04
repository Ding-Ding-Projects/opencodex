package oauth

import (
	"fmt"
	"strings"
	"testing"
)

func TestLogOAuthEventMasksAccountAndDropsSecretFields(t *testing.T) {
	var lines []string
	original := oauthInfof
	oauthInfof = func(format string, values ...any) { lines = append(lines, fmt.Sprintf(format, values...)) }
	t.Cleanup(func() { oauthInfof = original })

	LogOAuthEvent("OAuth refresh started", map[string]any{
		"provider": "kiro", "accountId": "acct_abcdefghijklmnopqrstuvwxyz", "until": "2026-07-23T14:30:00Z", "safe": "visible",
		"token": "secret-token", "accessToken": "secret-access", "refresh_token": "secret-refresh",
		"accessTOKEN": "secret-uppercase", "id-token": "secret-id", "client_secret": "secret-client", "oauthCode": "secret-code",
	})

	if len(lines) != 1 {
		t.Fatalf("lines=%#v", lines)
	}
	line := lines[0]
	for _, expected := range []string{"[opencodex] OAuth refresh started", "provider=kiro", "account=account-…wxyz", "safe=visible", "until=2026-07-23T14:30:00Z"} {
		if !strings.Contains(line, expected) {
			t.Fatalf("log lacks %q: %s", expected, line)
		}
	}
	if strings.Contains(line, "acct_abcdefghijklmnopqrstuvwxyz") || strings.Contains(line, "secret-") {
		t.Fatalf("log leaked sensitive data: %s", line)
	}
}
