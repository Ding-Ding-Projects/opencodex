package claude

import (
	"context"
	"io"
	"os/exec"
	"time"
)

const (
	keychainService      = "Claude Code-credentials"
	keychainItemNotFound = 44
	keychainTimeout      = 1500 * time.Millisecond
)

type keychainCommand func(context.Context, string, []string, io.Reader, io.Writer, io.Writer) (int, error)

func probeDarwinKeychain(run keychainCommand) AuthPresence {
	ctx, cancel := context.WithTimeout(context.Background(), keychainTimeout)
	defer cancel()
	status, err := run(ctx, "security", []string{"find-generic-password", "-s", keychainService}, nil, io.Discard, io.Discard)
	if err != nil || ctx.Err() != nil {
		return AuthUnknown
	}
	switch status {
	case 0:
		return AuthPresent
	case keychainItemNotFound:
		return AuthAbsent
	default:
		return AuthUnknown
	}
}

func runKeychainCommand(ctx context.Context, name string, args []string, stdin io.Reader, stdout, stderr io.Writer) (int, error) {
	command := exec.CommandContext(ctx, name, args...)
	command.Stdin, command.Stdout, command.Stderr = stdin, stdout, stderr
	err := command.Run()
	if err == nil {
		return 0, nil
	}
	if exit, ok := err.(*exec.ExitError); ok {
		return exit.ExitCode(), nil
	}
	return -1, err
}
