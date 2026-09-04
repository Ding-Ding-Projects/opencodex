//go:build !windows

package cli

import "golang.org/x/sys/unix"

// isatty reports whether the descriptor is a real terminal.
//
// os.ModeCharDevice is not sufficient on its own: /dev/null and /dev/zero are
// character devices too. Only a terminal answers the terminal-attributes
// ioctl, which is the same test isatty(3) performs.
func isatty(fd uintptr) bool {
	_, err := unix.IoctlGetTermios(int(fd), ioctlReadTermios)
	return err == nil
}
