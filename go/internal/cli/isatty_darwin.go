//go:build darwin || freebsd || netbsd || openbsd || dragonfly

package cli

import "golang.org/x/sys/unix"

// The BSD family spells the terminal-attributes ioctl TIOCGETA.
const ioctlReadTermios = unix.TIOCGETA
