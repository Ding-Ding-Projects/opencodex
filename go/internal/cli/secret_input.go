package cli

import (
	"bufio"
	"io"
	"os"
	"strings"
	"time"
)

// suppliedOption is an option value plus WHICH spelling supplied it.
//
// The distinction matters for credentials: `--code=<secret>` and `--code
// <secret>` both put the value in the process list, but only the caller knows
// which they typed, and the warning names the exposure without repeating the
// value.
type suppliedOption struct {
	value  string
	inline bool
}

// takeOptionWithSyntax accepts `--flag value` and `--flag=value`, reporting
// which was used.
//
// The equals form is ACCEPTED rather than rejected. Rejecting it would route
// the value through rejectArgs, and a caller who typed `--code=<secret>` would
// see their credential echoed back on stderr. Accepting it lets the command
// warn about the shell-history exposure without repeating the value.
func takeOptionWithSyntax(args *[]string, flag string) (suppliedOption, bool, error) {
	occurrences := 0
	for _, arg := range *args {
		if arg == flag || strings.HasPrefix(arg, flag+"=") {
			occurrences++
		}
	}
	// Taking only the first occurrence would leave the second value in the
	// leftovers for rejectArgs to report. Say what is wrong without repeating
	// either value.
	if occurrences > 1 {
		return suppliedOption{}, false, usageError("", "%s was given more than once", flag)
	}
	for index, arg := range *args {
		if !strings.HasPrefix(arg, flag+"=") {
			continue
		}
		value := arg[len(flag)+1:]
		*args = removeRange(*args, index, index+1)
		if value == "" {
			return suppliedOption{}, false, usageError("", "%s requires a value", flag)
		}
		return suppliedOption{value: value, inline: true}, true, nil
	}
	value, ok, err := takeOption(args, flag)
	if err != nil || !ok {
		return suppliedOption{}, false, err
	}
	return suppliedOption{value: value}, true, nil
}

// secretLineTimeout matches the oracle's 120s stdin deadline.
const secretLineTimeout = 120 * time.Second

// readSecretLine reads ONE line from stdin without it ever reaching argv.
//
// Resolve on the first newline, on end-of-stream, or fail on the deadline. A
// stream that already ended emits nothing more, so waiting out the full
// timeout and then blaming a slow paste would be wrong: `echo … | something |
// ocx account code <p>` arrives that way.
func readSecretLine(input io.Reader, label string) (string, error) {
	if input == nil {
		input = os.Stdin
	}
	type result struct {
		line string
		err  error
	}
	done := make(chan result, 1)
	go func() {
		reader := bufio.NewReader(input)
		line, err := reader.ReadString('\n')
		if err != nil && err != io.EOF {
			done <- result{err: err}
			return
		}
		done <- result{line: strings.TrimSpace(strings.TrimRight(line, "\r\n"))}
	}()
	select {
	case out := <-done:
		if out.err != nil {
			return "", out.err
		}
		if out.line == "" {
			return "", usageError("", "%s input was empty", label)
		}
		return out.line, nil
	case <-time.After(secretLineTimeout):
		return "", usageError("", "timed out waiting for %s on stdin", label)
	}
}

// isTerminal reports whether the reader is an INTERACTIVE terminal, so the
// caller knows whether a "paste it here" prompt makes sense.
//
// The character-device test alone is not enough: /dev/null is a character
// device too, so `ocx account code p --code - </dev/null` printed a prompt
// asking the user to paste into a stream that was already at EOF. The oracle
// checks `input.isTTY`, which /dev/null does not satisfy.
func isTerminal(input io.Reader) bool {
	file, isFile := input.(*os.File)
	if !isFile {
		return false
	}
	info, err := file.Stat()
	if err != nil {
		return false
	}
	if info.Mode()&os.ModeCharDevice == 0 {
		return false
	}
	// A real terminal answers TCGETS; /dev/null and /dev/zero do not.
	return isatty(file.Fd())
}
