package lib

import "strings"

func MaskEmail(value string) string {
	if value == "" {
		return ""
	}
	local, domain, found := strings.Cut(value, "@")
	if !found || local == "" || domain == "" {
		return value
	}
	switch len([]rune(local)) {
	case 1:
		return "*@" + domain
	case 2:
		return string([]rune(local)[0]) + "*@" + domain
	default:
		runes := []rune(local)
		return string(runes[0]) + "***" + string(runes[len(runes)-1]) + "@" + domain
	}
}
