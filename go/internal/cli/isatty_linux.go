//go:build linux || solaris || aix || zos

package cli

import "golang.org/x/sys/unix"

// Linux and friends spell the terminal-attributes ioctl TCGETS.
const ioctlReadTermios = unix.TCGETS
