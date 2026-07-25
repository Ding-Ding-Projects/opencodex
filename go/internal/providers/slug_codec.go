package providers

import "strings"

const SlugAliasSeparator = "-"

func EncodeRoutedModelID(id string) string  { return strings.ReplaceAll(id, "/", SlugAliasSeparator) }
func RoutedSlug(provider, id string) string { return provider + "/" + EncodeRoutedModelID(id) }
func DecodeRoutedModelID(requested string, knownIDs []string) string {
	match := ""
	for _, id := range knownIDs {
		if id == requested {
			return requested
		}
		if strings.Contains(id, "/") && EncodeRoutedModelID(id) == requested {
			if match != "" && match != id {
				return requested
			}
			match = id
		}
	}
	if match != "" {
		return match
	}
	return requested
}
func SlugEquals(stored, provider, id string) bool {
	return stored == provider+"/"+id || stored == RoutedSlug(provider, id)
}
func SlugsEquivalent(a, b string) bool {
	if a == b {
		return true
	}
	pa, pb := strings.IndexByte(a, '/'), strings.IndexByte(b, '/')
	if pa <= 0 || pb <= 0 || a[:pa] != b[:pb] {
		return false
	}
	return EncodeRoutedModelID(a[pa+1:]) == EncodeRoutedModelID(b[pb+1:])
}
