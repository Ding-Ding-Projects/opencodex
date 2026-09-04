package providers

import (
	"regexp"
	"strings"
)

var codexAccountLogLabelRE = regexp.MustCompile(`^p[a-f0-9]{6}$`)

func canonicalUsageProviderLabel(p string) string {
	if p == "chatgpt" || p == "openai-multi" {
		return "openai"
	}
	return p
}
func BaseProviderLabel(provider string) string {
	canonical := canonicalUsageProviderLabel(provider)
	if canonical != provider {
		return canonical
	}
	cut := strings.LastIndex(provider, "-")
	if cut <= 0 {
		return canonical
	}
	suffix := provider[cut+1:]
	if suffix == "main" || codexAccountLogLabelRE.MatchString(suffix) {
		return canonicalUsageProviderLabel(provider[:cut])
	}
	return provider
}
