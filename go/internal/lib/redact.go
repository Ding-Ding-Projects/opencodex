package lib

import (
	"net/http"
	"net/url"
	"regexp"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/config"
)

const RedactedSecret = config.RedactedSecret

var (
	copilotTokenPattern = regexp.MustCompile(`\btid=[A-Za-z0-9-]+(?:;[A-Za-z0-9_.-]+=[^;\s"']*)+(?::[A-Za-z0-9+/=_-]+)?`)
	awsARNPattern       = regexp.MustCompile(`\barn:aws:[A-Za-z0-9_-]+:[A-Za-z0-9-]*:\d{12}:[A-Za-z0-9_/:+=,.@-]+\b`)
	posixHomePattern    = regexp.MustCompile(`(/(?:Users|home)/)[^/]+`)
	windowsHomePattern  = regexp.MustCompile(`(?i)([A-Za-z]:\\Users\\)[^\\/]+`)
	sensitiveSegment    = regexp.MustCompile(`(?i)(^|[\\/])([^\\/]*(?:secret|password|passwd|token|api[-_]?key|apikey|credential|email)[^\\/]*)([\\/]|$)`)
)

func RedactSecretString(value string) string {
	value = copilotTokenPattern.ReplaceAllString(value, RedactedSecret)
	value = awsARNPattern.ReplaceAllString(value, RedactedSecret)
	return config.RedactString(value)
}

func RedactSecrets(value any) any {
	switch typed := value.(type) {
	case string:
		return RedactSecretString(typed)
	case map[string]any:
		result := make(map[string]any, len(typed))
		for key, entry := range typed {
			if config.IsSensitiveKey(key) {
				result[key] = RedactedSecret
			} else {
				result[key] = RedactSecrets(entry)
			}
		}
		return result
	case []any:
		result := make([]any, len(typed))
		for i, entry := range typed {
			result[i] = RedactSecrets(entry)
		}
		return result
	default:
		return value
	}
}

func RedactHeaders(headers http.Header) map[string]string {
	result := make(map[string]string, len(headers))
	for key, values := range headers {
		key = strings.ToLower(key)
		if config.IsSensitiveKey(key) {
			result[key] = RedactedSecret
		} else {
			result[key] = RedactSecretString(strings.Join(values, ", "))
		}
	}
	return result
}

func RedactURLForLog(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return RedactSecretString(strings.SplitN(raw, "?", 2)[0])
	}
	parsed.User = nil
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String()
}

func RedactUserPath(path string) string {
	path = windowsHomePattern.ReplaceAllString(path, `${1}[USER]`)
	path = posixHomePattern.ReplaceAllString(path, `${1}[USER]`)
	for sensitiveSegment.MatchString(path) {
		path = sensitiveSegment.ReplaceAllString(path, `${1}[REDACTED]${3}`)
	}
	return RedactSecretString(path)
}
