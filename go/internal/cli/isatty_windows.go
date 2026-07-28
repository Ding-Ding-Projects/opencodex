//go:build windows

package cli

import "golang.org/x/sys/windows"

// isatty reports whether the handle is a console.
//
// GetConsoleMode succeeds only for a real console handle, so a redirected
// stdin (a pipe or NUL) correctly answers false.
func isatty(fd uintptr) bool {
	var mode uint32
	return windows.GetConsoleMode(windows.Handle(fd), &mode) == nil
}
