package main

import (
	"os"
	"os/exec"
	"syscall"
)

func interactive() bool {
	var mode uint32
	return syscall.GetConsoleMode(syscall.Handle(os.Stdin.Fd()), &mode) == nil
}

func configureChild(child *exec.Cmd) {
	// Keep the CLI in the user's console and give Electron only the pipe handles.
	child.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
}
