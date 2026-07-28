package cli

import (
	"fmt"
	"strconv"
	"strings"
)

// CLIUsageError carries the usage text alongside the message, mirroring the
// TypeScript CliUsageError in src/cli/runtime-api.ts.
type CLIUsageError struct {
	Message string
	Usage   string
}

func (e *CLIUsageError) Error() string { return e.Message }

func usageError(usage, format string, args ...any) error {
	return &CLIUsageError{Message: fmt.Sprintf(format, args...), Usage: usage}
}

// secretOptions lists options whose VALUE is a credential. A parse error must
// never print one, so both `--flag value` and `--flag=value` spellings are
// masked before any message repeats the arguments back.
var secretOptions = []string{"--code"}

// takeFlag removes a boolean flag from args and reports whether it was present.
func takeFlag(args *[]string, flag string) bool {
	for index, arg := range *args {
		if arg == flag {
			*args = append((*args)[:index], (*args)[index+1:]...)
			return true
		}
	}
	return false
}

// takeOption removes `--flag value` and returns the value.
//
// A value starting with `--` is rejected rather than consumed: the oracle
// treats it as a missing value, which keeps `--flag --other` from silently
// swallowing the next flag.
func takeOption(args *[]string, flag string) (string, bool, error) {
	for index, arg := range *args {
		if arg != flag {
			continue
		}
		if index+1 >= len(*args) || strings.HasPrefix((*args)[index+1], "--") {
			return "", false, usageError("", "%s requires a value", flag)
		}
		value := (*args)[index+1]
		*args = append((*args)[:index], (*args)[index+2:]...)
		return value, true, nil
	}
	return "", false, nil
}

// takeBooleanOption parses the oracle's on/off vocabulary.
func takeBooleanOption(args *[]string, flag string) (bool, bool, error) {
	raw, ok, err := takeOption(args, flag)
	if err != nil || !ok {
		return false, false, err
	}
	switch strings.ToLower(raw) {
	case "on", "true", "yes", "1", "enabled":
		return true, true, nil
	case "off", "false", "no", "0", "disabled":
		return false, true, nil
	}
	return false, false, usageError("", "%s must be on or off", flag)
}

// takeIntegerOption parses an integer option, optionally bounded below.
func takeIntegerOption(args *[]string, flag string, min *int) (int, bool, error) {
	raw, ok, err := takeOption(args, flag)
	if err != nil || !ok {
		return 0, false, err
	}
	cleaned := strings.NewReplacer("_", "", ",", "").Replace(raw)
	value, convErr := strconv.Atoi(cleaned)
	if convErr != nil || (min != nil && value < *min) {
		if min != nil {
			return 0, false, usageError("", "%s must be an integer >= %d", flag, *min)
		}
		return 0, false, usageError("", "%s must be an integer", flag)
	}
	return value, true, nil
}

// csvValues splits a comma-separated option into trimmed, de-duplicated parts,
// preserving first-seen order like the oracle's `new Set(...)` round trip.
func csvValues(value string) []string {
	seen := make(map[string]struct{})
	out := []string{}
	for _, part := range strings.Split(value, ",") {
		trimmed := strings.TrimSpace(part)
		if trimmed == "" {
			continue
		}
		if _, duplicate := seen[trimmed]; duplicate {
			continue
		}
		seen[trimmed] = struct{}{}
		out = append(out, trimmed)
	}
	return out
}

// rejectArgs fails when anything is left over, masking credential values first.
func rejectArgs(args []string, usage string, redactValues bool) error {
	if len(args) == 0 {
		return nil
	}
	return usageError(usage, "Unexpected argument(s): %s", strings.Join(redactSecretArgs(args, redactValues), " "))
}

// redactSecretArgs masks credential values before they are reported back.
//
// Both spellings have to be covered, and the space-separated one spans two
// tokens: mistyping a command that does not parse `--code` leaves the flag AND
// its value in the leftovers, and reporting them verbatim writes the credential
// to stderr. The token after the option is redacted whatever it looks like,
// because the shell hands over whatever was typed: `--code --SECRET` and
// `--code -- SECRET` both otherwise put the credential straight in the message.
func redactSecretArgs(args []string, redactValues bool) []string {
	out := make([]string, 0, len(args))
	for index := 0; index < len(args); index++ {
		arg := args[index]
		if inline, ok := inlineSecretOption(arg); ok {
			out = append(out, inline+"=<redacted>")
			continue
		}
		if isSecretOption(arg) {
			out = append(out, arg)
			valueIndex := index + 1
			if valueIndex < len(args) && args[valueIndex] == "--" {
				out = append(out, "--")
				valueIndex++
			}
			if valueIndex < len(args) {
				out = append(out, "<redacted>")
				index = valueIndex
			}
			continue
		}
		if redactValues && !strings.HasPrefix(arg, "-") {
			out = append(out, "<redacted>")
			continue
		}
		out = append(out, arg)
	}
	return out
}

func isSecretOption(arg string) bool {
	for _, option := range secretOptions {
		if arg == option {
			return true
		}
	}
	return false
}

func inlineSecretOption(arg string) (string, bool) {
	for _, option := range secretOptions {
		if strings.HasPrefix(arg, option+"=") {
			return option, true
		}
	}
	return "", false
}
