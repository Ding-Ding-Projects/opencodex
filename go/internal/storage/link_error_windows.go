//go:build windows

package storage

// isUnsupportedLinkError keeps the conservative Windows behavior.
//
// The link error codes this platform reports could not be verified without a
// Windows host, so every non-EEXIST failure is still treated as an unsupported
// filesystem. That ends in a refusal, never in an overwrite, which is the safe
// side of an unverified branch.
func isUnsupportedLinkError(err error) bool {
	return true
}
