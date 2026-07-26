package oauth

import (
	"fmt"
	"log"
	"sort"
	"strings"
	"unicode"

	ocxlib "github.com/lidge-jun/opencodex-go/internal/lib"
)

var oauthInfof = log.Printf

var forbiddenOAuthLogFields = map[string]struct{}{
	"access": {}, "refresh": {}, "authorization": {}, "code": {}, "token": {},
	"access_token": {}, "refresh_token": {}, "id_token": {}, "client_secret": {},
	"oauth_code": {}, "clientsecret": {},
}

func normalizeOAuthLogField(key string) string {
	var out strings.Builder
	var previous rune
	for i, r := range key {
		original := r
		if r == '-' {
			r = '_'
			original = r
		}
		if unicode.IsUpper(r) {
			if i > 0 && (unicode.IsLower(previous) || unicode.IsDigit(previous)) {
				out.WriteByte('_')
			}
			r = unicode.ToLower(r)
		}
		out.WriteRune(r)
		previous = original
	}
	return strings.ToLower(out.String())
}

func forbiddenOAuthLogField(key string) bool {
	normalized := normalizeOAuthLogField(key)
	if _, forbidden := forbiddenOAuthLogFields[normalized]; forbidden {
		return true
	}
	return strings.HasSuffix(normalized, "_token") || strings.HasSuffix(normalized, "_secret") || strings.HasSuffix(normalized, "_code")
}

// LogOAuthEvent emits a compact diagnostic while excluding token-like fields
// and masking the persisted account identifier. Callers must use stable event
// names rather than placing provider responses in event.
func LogOAuthEvent(event string, fields map[string]any) {
	provider := safeOAuthLogValue(fields["provider"])
	parts := []string{"[opencodex] " + safeOAuthLogValue(event), "provider=" + provider}
	if account := safeOAuthLogValue(fields["accountId"]); account != "" {
		parts = append(parts, "account="+ocxlib.MaskAccountID(account))
	}
	keys := make([]string, 0, len(fields))
	for key, value := range fields {
		if key == "provider" || key == "accountId" || value == nil || forbiddenOAuthLogField(key) {
			continue
		}
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		parts = append(parts, key+"="+safeOAuthLogValue(fields[key]))
	}
	oauthInfof("%s", strings.Join(parts, " "))
}

func safeOAuthLogValue(value any) string {
	return strings.NewReplacer("\r", " ", "\n", " ").Replace(fmt.Sprint(value))
}
