//go:build windows

package cli

import (
	"os/exec"
	"syscall"

	"golang.org/x/sys/windows"
)

func configureUpdateWorkerProcess(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: windows.CREATE_NEW_PROCESS_GROUP | windows.DETACHED_PROCESS,
	}
}
