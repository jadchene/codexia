package main

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
)

// Set by the build script from package.json.
var version = "development"

// Wrapping stdout/stderr forces pipes even when the parent is a console.
// Electron's GUI subsystem must receive pipe handles for reliable CLI output.
type pipeWriter struct{ io.Writer }

func main() { os.Exit(run(os.Args[1:])) }

func run(args []string) int {
	if len(args) == 1 && (args[0] == "--version" || args[0] == "-v" || args[0] == "version") {
		fmt.Printf("Codexia %s\n", version)
		return 0
	}
	launcher, err := os.Executable()
	if err == nil {
		launcher, err = filepath.EvalSymlinks(launcher)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "Cannot resolve CLI installation:", err)
		return 1
	}
	executable := filepath.Join(filepath.Dir(launcher), "Codexia.exe")
	childArgs := []string{"--cli"}
	if interactive() {
		childArgs = append(childArgs, "--cli-interactive")
	}
	childArgs = append(childArgs, args...)
	child := exec.Command(executable, childArgs...)
	// Preserve the caller's working directory, but never use it for discovery.
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if !strings.EqualFold(key, "ELECTRON_RUN_AS_NODE") {
			child.Env = append(child.Env, entry)
		}
	}
	configureChild(child)
	child.Stdout = pipeWriter{os.Stdout}
	child.Stderr = pipeWriter{os.Stderr}
	stdin, err := child.StdinPipe()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer stdin.Close()
	interrupts := make(chan os.Signal, 1)
	signal.Notify(interrupts, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(interrupts)
	if err = child.Start(); err != nil {
		fmt.Fprintln(os.Stderr, "Cannot start same-directory Codexia:", err)
		return 1
	}
	// Do not attach stdin through Cmd.Stdin: Wait would then wait forever for
	// console input after a short-lived child (e.g. --help) has already exited.
	go func() { _, _ = io.Copy(stdin, os.Stdin); _ = stdin.Close() }()
	done := make(chan error, 1)
	go func() { done <- child.Wait() }()
	select {
	case <-interrupts:
		// Only terminate this CLI child, never the desktop reached through IPC.
		_ = child.Process.Kill()
		<-done
		return 130
	case err = <-done:
		if err == nil {
			return 0
		}
		if exit, ok := err.(*exec.ExitError); ok && exit.ExitCode() >= 0 {
			return exit.ExitCode()
		}
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
}
