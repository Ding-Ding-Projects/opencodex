//go:build !windows

package server

import "syscall"

func unlinkResponseStateTemp(path string) error {
	return syscall.Unlink(path)
}
