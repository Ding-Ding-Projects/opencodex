package update

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"strings"
	"time"
)

// PromptDeps is everything the prompt needs from the outside, so the gates can
// be driven in a test without a terminal, a real config dir, or a real install.
type PromptDeps struct {
	In  io.Reader
	Out io.Writer
	// CachePath is the version cache file. The cli package owns config-dir
	// resolution, so it hands the assembled path down rather than update
	// growing its own notion of where the config lives.
	CachePath string
	// Current is the running version. A development build never prompts.
	Current string
	// Interactive reports whether both stdin and stdout are terminals, matching
	// the oracle's two-sided check (src/update/notify.ts:121).
	Interactive bool
	// Service marks a service-manager run. Kept separate from Interactive: a
	// supervisor can hand a process a terminal, and prompting there would block
	// startup forever on a read nobody answers.
	Service bool
	// Installer decides which command the prompt offers to run.
	Installer Installer
	// RunUpdate performs the install. Nil disables option 1, which is what a
	// test wants: it can drive the prompt without installing anything.
	RunUpdate func(Command) error
	// Exit ends the process after a successful update. Nil skips the exit so a
	// test survives its own prompt.
	Exit func(code int)
	Now  func() time.Time
}

// MaybeShowUpdatePrompt offers an upgrade before the proxy takes any resources.
//
// The oracle calls this before choosing a port (src/cli/index.ts:183) for a
// reason recorded at src/update/notify.ts:219: choosing "Update now" installs
// globally and exits, so a live process must never hold a port while it
// overwrites its own binary.
//
// It never returns an error and never panics out: a broken update check must
// not be able to stop the proxy from starting.
func MaybeShowUpdatePrompt(deps PromptDeps) {
	defer func() { _ = recover() }()

	if !eligible(deps) {
		return
	}
	channel := DefaultChannel(deps.Current)
	cache, err := ReadVersionCache(deps.CachePath, channel)
	if err != nil || cache == nil {
		// No cache also covers the first run. The oracle yields there via the
		// star-prompt marker; Go has no star prompt, so the absent cache is the
		// yield.
		return
	}
	latest := UpgradeVersion(cache, deps.Current, channel)
	if latest == "" {
		return
	}

	if _, err := io.WriteString(deps.Out, renderUpdatePrompt(deps, channel, latest)); err != nil {
		return
	}
	choice := readChoice(deps.In)

	switch choice {
	case "3":
		DismissVersion(cache, latest)
		_ = WriteVersionCache(deps.CachePath, *cache)
	case "1":
		if deps.RunUpdate == nil {
			return
		}
		if err := deps.RunUpdate(InstallCommand(deps.Installer, channel, latest)); err != nil {
			fmt.Fprintf(deps.Out, "\n  update failed: %v\n", err)
			return
		}
		io.WriteString(deps.Out, "\nRestart the proxy:  ocx start\n")
		if deps.Exit != nil {
			deps.Exit(0)
		}
	}
	// "2" and anything else: continue this run unchanged.
}

func eligible(deps PromptDeps) bool {
	if deps.Service || !deps.Interactive {
		return false
	}
	if deps.In == nil || deps.Out == nil || deps.CachePath == "" {
		return false
	}
	current := strings.TrimSpace(deps.Current)
	if current == "" || current == "?" || isDevelopmentVersion(current) {
		return false
	}
	return true
}

// A source or development build has nothing to upgrade to.
func isDevelopmentVersion(version string) bool {
	return strings.Contains(version, "-dev") || strings.Contains(version, "+")
}

func readChoice(in io.Reader) string {
	line, err := bufio.NewReader(in).ReadString('\n')
	if err != nil && line == "" {
		return ""
	}
	answer := strings.TrimSpace(line)
	if answer == "" {
		return "1"
	}
	return answer
}

func renderUpdatePrompt(deps PromptDeps, channel Channel, latest string) string {
	command := InstallCommand(deps.Installer, channel, latest).String()
	if command == "" {
		command = "ocx update"
	}
	return strings.Join([]string{
		"",
		"  \x1b[38;5;141m✨ Update available!\x1b[0m  \x1b[2m" + deps.Current + " -> " + latest + "\x1b[0m",
		"",
		"  \x1b[2mRelease notes:\x1b[0m " + ReleaseNotesURL,
		"",
		"  1) Update now (runs `" + command + "`)",
		"  2) Skip",
		"  3) Skip until next version",
		"",
		"  [1/2/3] (default 1): ",
	}, "\n")
}

// TerminalInteractive reports whether both ends are terminals, the same
// two-sided condition the oracle uses before it will prompt.
func TerminalInteractive(in, out *os.File) bool {
	return isTerminal(in) && isTerminal(out)
}

func isTerminal(file *os.File) bool {
	if file == nil {
		return false
	}
	info, err := file.Stat()
	if err != nil {
		return false
	}
	return info.Mode()&os.ModeCharDevice != 0
}
