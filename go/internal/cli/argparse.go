package cli

import (
	"fmt"
	"math"
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

// BareUsageError is a usage failure the oracle reports from its dispatcher
// instead of from runCliAction: `ocx route <not-combo>` and `ocx integration
// <not-claude-or-grok>` print ONE usage line with no "Error:" prefix and exit
// 2 (src/cli/index.ts). Routing them through CLIUsageError would add both a
// prefix line and a multi-line usage block the TypeScript CLI never prints.
type BareUsageError struct {
	Usage string
}

func (e *BareUsageError) Error() string { return e.Usage }

func bareUsageError(usage string) error {
	return &BareUsageError{Usage: usage}
}

// secretOptions lists options whose VALUE is a credential. A parse error must
// never print one, so both `--flag value` and `--flag=value` spellings are
// masked before any message repeats the arguments back.
var secretOptions = []string{"--code"}

// takeFlag removes a boolean flag from args and reports whether it was present.
//
// The shortened slice is a fresh allocation rather than an in-place append: an
// in-place shift rewrites the caller's backing array, so a sibling slice over
// the same array silently observes reordered arguments even though its own
// length never changed.
func takeFlag(args *[]string, flag string) bool {
	for index, arg := range *args {
		if arg == flag {
			*args = removeRange(*args, index, index+1)
			return true
		}
	}
	return false
}

// removeRange returns a copy of values without [from, to).
func removeRange(values []string, from, to int) []string {
	out := make([]string, 0, len(values)-(to-from))
	out = append(out, values[:from]...)
	return append(out, values[to:]...)
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
		*args = removeRange(*args, index, index+2)
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

// jsNumber reproduces the ECMAScript Number(string) conversion the oracle
// relies on. Go's ParseFloat is close but not the same function: it rejects the
// empty string, the `0x`/`0o`/`0b` radix prefixes, and the literal `Infinity`,
// while accepting Go-only spellings. Approximating it means the Go CLI silently
// accepts or rejects values the TypeScript CLI does not.
func jsNumber(raw string) (float64, bool) {
	// The ECMAScript StrWhiteSpace set, not Go's: it includes the Unicode Zs
	// category, U+0085 is excluded, and U+00A0/U+FEFF are included.
	trimmed := strings.TrimFunc(raw, isECMAScriptWhitespace)
	// Number("") and Number("   ") are both 0, not NaN.
	if trimmed == "" {
		return 0, true
	}
	// Radix literals admit NO sign at all in ECMAScript: both Number("-0x10")
	// and Number("+0x10") are NaN, so this check precedes sign handling.
	for _, radix := range []struct {
		prefix string
		base   int
	}{{"0x", 16}, {"0X", 16}, {"0o", 8}, {"0O", 8}, {"0b", 2}, {"0B", 2}} {
		if digits, found := strings.CutPrefix(trimmed, radix.prefix); found {
			if digits == "" {
				return 0, false
			}
			value, err := strconv.ParseUint(digits, radix.base, 64)
			if err != nil {
				return 0, false
			}
			return float64(value), true
		}
	}
	sign := 1.0
	unsigned := trimmed
	if rest, found := strings.CutPrefix(trimmed, "+"); found {
		unsigned = rest
	} else if rest, found := strings.CutPrefix(trimmed, "-"); found {
		unsigned, sign = rest, -1
	}
	if unsigned == "Infinity" {
		return sign * math.Inf(1), true
	}
	// A radix prefix behind a sign is NaN, and so is any other Go-only
	// spelling ParseFloat would otherwise accept.
	if strings.ContainsAny(unsigned, "xXoObB") {
		return 0, false
	}
	value, err := strconv.ParseFloat(trimmed, 64)
	if err != nil {
		// Out of range still yields ±Inf, matching Number("1e400").
		if numErr, ok := err.(*strconv.NumError); ok && numErr.Err == strconv.ErrRange {
			return value, true
		}
		return 0, false
	}
	return value, true
}

// takeIntegerOption parses an integer option, optionally bounded below.
//
// The oracle strips `_` and `,`, runs the result through Number(), then demands
// Number.isInteger. Infinity therefore fails the integer check rather than
// saturating, which is why the range guard below rejects rather than clamps: an
// out-of-range value must not silently become math.MaxInt.
func takeIntegerOption(args *[]string, flag string, min *int) (int, bool, error) {
	raw, ok, err := takeOption(args, flag)
	if err != nil || !ok {
		return 0, false, err
	}
	reject := func() (int, bool, error) {
		if min != nil {
			return 0, false, usageError("", "%s must be an integer >= %d", flag, *min)
		}
		return 0, false, usageError("", "%s must be an integer", flag)
	}
	parsed, valid := jsNumber(strings.NewReplacer("_", "", ",", "").Replace(raw))
	if !valid || math.IsNaN(parsed) || math.IsInf(parsed, 0) || parsed != math.Trunc(parsed) {
		return reject()
	}
	// Number.isInteger accepts magnitudes beyond int64; converting those is
	// implementation-defined in Go, so refuse instead of wrapping. The bound is
	// written as 2^63 rather than math.MaxInt64 because float64(math.MaxInt64)
	// rounds UP to exactly 2^63, so a `>` comparison against it lets 2^63
	// through and int(parsed) is then undefined.
	const twoToThe63 = float64(1<<62) * 2
	if parsed >= twoToThe63 || parsed < -twoToThe63 {
		return reject()
	}
	value := int(parsed)
	if min != nil && value < *min {
		return reject()
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

// isECMAScriptWhitespace reports whether r is trimmed by Number(string).
//
// The set is StrWhiteSpace from the spec: the Unicode Zs category plus tab,
// line feed, vertical tab, form feed, carriage return, line/paragraph
// separator, and the byte order mark. Notably U+0085 NEXT LINE is NOT in it,
// even though Go's unicode.IsSpace accepts it.
func isECMAScriptWhitespace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0x00a0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

// encodeURIComponent matches the JavaScript function of the same name.
//
// url.QueryEscape is NOT equivalent: it encodes a space as "+", which is
// correct for form bodies but wrong inside a query VALUE, and it escapes the
// sub-delimiters JavaScript leaves alone. A combo id containing a space would
// therefore be looked up under a different key than the oracle uses.
func encodeURIComponent(value string) string {
	const unreserved = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"
	var out strings.Builder
	for _, b := range []byte(value) {
		if strings.IndexByte(unreserved, b) >= 0 {
			out.WriteByte(b)
			continue
		}
		out.WriteString(fmt.Sprintf("%%%02X", b))
	}
	return out.String()
}
