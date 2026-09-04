//go:build windows

package server

import "golang.org/x/sys/windows"

func unlinkResponseStateTemp(path string) error {
	pointer, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	return windows.DeleteFile(pointer)
}
