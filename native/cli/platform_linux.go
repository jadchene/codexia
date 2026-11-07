package main

import (
	"os"
	"os/exec"
)

// Linux builds exercise the same launcher and process forwarding in integration tests.
func interactive() bool {
	info, err := os.Stdin.Stat()
	return err == nil && info.Mode()&os.ModeCharDevice != 0
}

func configureChild(child *exec.Cmd) {}
