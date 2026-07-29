// Detect / optionally terminate long-lived Codex app-server processes that keep an
// in-memory model catalog after `ocx sync` rewrites on-disk files (#476).
//
// Matching is intentionally narrow: require `app-server` as the Codex subcommand
// (not merely as a substring in some later argument) or `codex-code-mode-host`.
// Never match broad `*codex*` patterns that hit unrelated tools such as
// `hermes-codex-bridge-mcp`. Port of src/codex/app-server-processes.ts.
package codex

import (
	"fmt"
	"os"
	"os/exec"
	"path"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const StaleCodexAppServerHint = "If Codex still shows an older model list, restart its long-lived app-server process after sync (ocx sync --restart-codex)."

// codexTargetTripleBody matches the Rust-style target triple on official platform-baked
// Codex binaries (x86_64-unknown-linux-musl, aarch64-apple-darwin, …). Deliberately not a
// broad `codex-*` wildcard: arch-vendor-os with an optional env segment.
const codexTargetTripleBody = `[a-z0-9_]+-[a-z0-9_]+-[a-z0-9_]+(?:-[a-z0-9_]+)?`

var (
	// WindowsCodexBasenameCandidate is the narrow Win32_Process CommandLine pre-filter. It
	// allows an optional closing quote after the executable basename so quoted Program Files
	// paths still reach GetOwner.
	WindowsCodexBasenameCandidate = regexp.MustCompile(`(?i)(^|[/\\\s'"=])codex(-` + codexTargetTripleBody + `)?([.]exe|[.]cmd)?['"]?(\s|$)`)
	// WindowsCodexCodeModeHostCandidate matches the code-mode host by name.
	WindowsCodexCodeModeHostCandidate = regexp.MustCompile(`(?i)codex-code-mode-host`)
	codexTargetTripleBasename         = regexp.MustCompile(`^codex-` + codexTargetTripleBody + `(?:\.exe|\.cmd)?$`)
	unixProcStatusUID                 = regexp.MustCompile(`(?m)^Uid:\s+(\d+)`)
)

// IsWindowsCodexCandidateCommandLine reports whether a Windows CommandLine is worth paying
// GetOwner for; ownership scoping to the current user happens afterwards.
func IsWindowsCodexCandidateCommandLine(commandLine string) bool {
	return WindowsCodexBasenameCandidate.MatchString(commandLine) ||
		WindowsCodexCodeModeHostCandidate.MatchString(commandLine)
}

type CodexAppServerProcess struct {
	PID         int    `json:"pid"`
	CommandLine string `json:"commandLine"`
}

type ProcessSnapshot struct {
	PID         int
	CommandLine string
	UID         *int
	Owner       string
}

// AppServerProcessIO holds the injectable seams that make enumeration and termination
// testable without live processes.
type AppServerProcessIO struct {
	Platform      string
	GetUID        func() *int
	ListSnapshots func() []ProcessSnapshot
	IsAlive       func(pid int) bool
	Kill          func(pid int, signal syscall.Signal) error
	WaitExit      func(pid int, timeout time.Duration) bool
	Now           func() time.Time
}

// TokenizeCommandLine splits a process command line into argv-like tokens, handling simple quotes.
func TokenizeCommandLine(commandLine string) []string {
	tokens := []string{}
	var current strings.Builder
	var quote rune
	for _, char := range commandLine {
		if quote != 0 {
			if char == quote {
				quote = 0
			} else {
				current.WriteRune(char)
			}
			continue
		}
		if char == '"' || char == '\'' {
			quote = char
			continue
		}
		if char == ' ' || char == '\t' || char == '\n' || char == '\r' || char == '\v' || char == '\f' {
			if current.Len() > 0 {
				tokens = append(tokens, current.String())
				current.Reset()
			}
			continue
		}
		current.WriteRune(char)
	}
	if current.Len() > 0 {
		tokens = append(tokens, current.String())
	}
	return tokens
}

func tokenBasename(token string) string {
	return path.Base(strings.ReplaceAll(strings.ToLower(token), `\`, "/"))
}

func isCodexExecutableToken(token string) bool {
	base := tokenBasename(token)
	return base == "codex" || base == "codex.exe" || base == "codex.cmd" || codexTargetTripleBasename.MatchString(base)
}

func isCodeModeHostToken(token string) bool {
	base := tokenBasename(token)
	return base == "codex-code-mode-host" || base == "codex-code-mode-host.exe"
}

func isInterpreterToken(token string) bool {
	switch tokenBasename(token) {
	case "node", "node.exe", "bun", "bun.exe", "deno", "deno.exe":
		return true
	}
	return false
}

// codexGlobalOptionsWithValue lists the Codex global options that consume the following
// token when written without `=`. Explicit by design: unknown flags stay boolean so matching
// stays narrow.
var appServerGlobalOptionsWithValue = map[string]bool{
	"--enable": true, "--disable": true, "--config": true, "-c": true,
	"--profile": true, "-p": true, "--model": true, "-m": true,
	"--sandbox": true, "-s": true, "--ask-for-approval": true, "-a": true,
	"--local-provider": true, "--add-dir": true, "--cd": true, "-C": true,
	"--color": true, "--image": true, "-i": true, "--output-schema": true,
	"--output-last-message": true, "-o": true,
}

type cliOptionToken struct {
	name           string
	hasInlineValue bool
}

func splitCLIOptionToken(token string) (cliOptionToken, bool) {
	if !strings.HasPrefix(token, "-") || token == "-" || token == "--" {
		return cliOptionToken{}, false
	}
	if strings.HasPrefix(token, "--") {
		if equals := strings.Index(token, "="); equals >= 0 {
			return cliOptionToken{name: strings.ToLower(token[:equals]), hasInlineValue: true}, true
		}
		return cliOptionToken{name: strings.ToLower(token)}, true
	}
	// Short options keep their case: `-c` (config) is not `-C` (cd).
	if equals := strings.Index(token, "="); equals >= 0 {
		return cliOptionToken{name: token[:equals], hasInlineValue: true}, true
	}
	return cliOptionToken{name: token}, true
}

func advancePastCodexGlobalOption(tokens []string, index int) int {
	option, ok := splitCLIOptionToken(tokens[index])
	if !ok {
		return index + 1
	}
	next := index + 1
	if !option.hasInlineValue && appServerGlobalOptionsWithValue[option.name] &&
		next < len(tokens) && !strings.HasPrefix(tokens[next], "-") {
		next++ // skip the option value
	}
	return next
}

// isCodeModeHostProcess reports whether code-mode-host is the executable or the interpreter
// entrypoint, rather than a later argument.
func isCodeModeHostProcess(tokens []string) bool {
	if len(tokens) == 0 {
		return false
	}
	if isCodeModeHostToken(tokens[0]) {
		return true
	}
	return isInterpreterToken(tokens[0]) && len(tokens) > 1 && isCodeModeHostToken(tokens[1])
}

// CodexAppServerProcessIdentity is the PID-reuse guard: pid plus a normalized command line.
func CodexAppServerProcessIdentity(process CodexAppServerProcess) string {
	return strconv.Itoa(process.PID) + "\x00" + strings.Join(strings.Fields(process.CommandLine), " ")
}

// IsCodexAppServerCommandLine reports whether a command line is a Codex app-server (or
// code-mode host) worth restarting.
func IsCodexAppServerCommandLine(commandLine string) bool {
	tokens := TokenizeCommandLine(strings.TrimSpace(commandLine))
	if len(tokens) == 0 {
		return false
	}
	if isCodeModeHostProcess(tokens) {
		return true
	}
	// Codex must be argv0, so a later-argument occurrence stays unmatched
	// (`node worker.js codex app-server`).
	if !isCodexExecutableToken(tokens[0]) {
		return false
	}
	for index := 1; index < len(tokens); {
		token := tokens[index]
		if strings.HasPrefix(token, "-") {
			index = advancePastCodexGlobalOption(tokens, index)
			continue
		}
		// The first non-option after the globals is the Codex subcommand.
		return strings.ToLower(token) == "app-server"
	}
	return false
}

func parseUnixProcStatusUID(status string) *int {
	match := unixProcStatusUID.FindStringSubmatch(status)
	if match == nil {
		return nil
	}
	uid, err := strconv.Atoi(match[1])
	if err != nil {
		return nil
	}
	return &uid
}

func listUnixProcSnapshots(uid *int) []ProcessSnapshot {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil
	}
	out := []ProcessSnapshot{}
	for _, entry := range entries {
		pid, convErr := strconv.Atoi(entry.Name())
		if convErr != nil || pid <= 1 {
			continue
		}
		status, statusErr := os.ReadFile("/proc/" + entry.Name() + "/status")
		if statusErr != nil {
			continue // process exited mid-scan
		}
		processUID := parseUnixProcStatusUID(string(status))
		if uid != nil && processUID != nil && *processUID != *uid {
			continue
		}
		raw, cmdErr := os.ReadFile("/proc/" + entry.Name() + "/cmdline")
		if cmdErr != nil {
			continue
		}
		commandLine := strings.TrimSpace(strings.ReplaceAll(string(raw), "\x00", " "))
		if commandLine == "" {
			continue
		}
		out = append(out, ProcessSnapshot{PID: pid, CommandLine: commandLine, UID: processUID})
	}
	return out
}

func listDarwinSnapshots(uid *int) []ProcessSnapshot {
	var command *exec.Cmd
	if uid != nil {
		command = exec.Command("ps", "-u", strconv.Itoa(*uid), "-o", "pid=,command=")
	} else {
		command = exec.Command("ps", "-axo", "pid=,uid=,command=")
	}
	output, err := command.Output()
	if err != nil {
		return nil
	}
	out := []ProcessSnapshot{}
	for _, raw := range strings.Split(string(output), "\n") {
		line := strings.TrimSpace(strings.TrimSuffix(raw, "\r"))
		if line == "" {
			continue
		}
		fields := strings.Fields(line)
		if uid != nil {
			pid, convErr := strconv.Atoi(fields[0])
			if convErr != nil || pid <= 1 {
				continue
			}
			commandLine := strings.TrimSpace(strings.TrimPrefix(line, fields[0]))
			if commandLine == "" {
				continue
			}
			scoped := *uid
			out = append(out, ProcessSnapshot{PID: pid, CommandLine: commandLine, UID: &scoped})
			continue
		}
		if len(fields) < 3 {
			continue
		}
		pid, pidErr := strconv.Atoi(fields[0])
		processUID, uidErr := strconv.Atoi(fields[1])
		if pidErr != nil || pid <= 1 {
			continue
		}
		commandLine := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(strings.TrimPrefix(line, fields[0])), fields[1]))
		if commandLine == "" {
			continue
		}
		snapshot := ProcessSnapshot{PID: pid, CommandLine: commandLine}
		if uidErr == nil {
			snapshot.UID = &processUID
		}
		out = append(out, snapshot)
	}
	return out
}

func powerShellSingleQuotedIgnoreCaseMatch(pattern string) string {
	return "'(?i)" + strings.ReplaceAll(pattern, "'", "''") + "'"
}

// ListWindowsSnapshots enumerates processes scoped to the invoking user via Win32_Process
// GetOwner. PowerShell is the sole path: WMIC lacks reliable owner data and is disabled on
// many Windows 11 installs, and unscoped rows would contradict the current-user contract.
func ListWindowsSnapshots() []ProcessSnapshot {
	// The regexes are shared with the pre-filter so PowerShell pays GetOwner only for Codex
	// candidates rather than every process on the machine.
	basename := powerShellSingleQuotedIgnoreCaseMatch(strings.TrimPrefix(WindowsCodexBasenameCandidate.String(), "(?i)"))
	codeMode := powerShellSingleQuotedIgnoreCaseMatch(strings.TrimPrefix(WindowsCodexCodeModeHostCandidate.String(), "(?i)"))
	script := strings.Join([]string{
		"$ErrorActionPreference='SilentlyContinue'",
		"$me=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name",
		"Get-CimInstance Win32_Process | Where-Object {",
		"  -not [string]::IsNullOrWhiteSpace($_.CommandLine) -and (",
		"    $_.CommandLine -match " + basename + " -or",
		"    $_.CommandLine -match " + codeMode,
		"  )",
		"} | ForEach-Object {",
		"  try {",
		"    $o=Invoke-CimMethod -InputObject $_ -MethodName GetOwner -ErrorAction Stop",
		"    if($null -eq $o -or $o.ReturnValue -ne 0 -or [string]::IsNullOrWhiteSpace($o.User)){return}",
		"    $owner=if($o.Domain){\"$($o.Domain)\\$($o.User)\"}else{$o.User}",
		"    if($owner -ine $me){return}",
		"    $cmd=($_.CommandLine -replace \"`t\",\" \")",
		"    \"{0}`t{1}`t{2}\" -f $_.ProcessId, $cmd, $owner",
		"  } catch { }",
		"}",
	}, "\n")
	output, err := exec.Command("powershell.exe", "-NoProfile", "-NoLogo", "-NonInteractive",
		"-WindowStyle", "Hidden", "-Command", script).Output()
	if err != nil {
		return nil
	}
	out := []ProcessSnapshot{}
	for _, line := range strings.Split(string(output), "\n") {
		line = strings.TrimSuffix(line, "\r")
		first := strings.Index(line, "\t")
		if first <= 0 {
			continue
		}
		second := strings.Index(line[first+1:], "\t")
		if second < 0 {
			continue
		}
		second += first + 1
		pid, convErr := strconv.Atoi(line[:first])
		commandLine := strings.TrimSpace(line[first+1 : second])
		owner := strings.TrimSpace(line[second+1:])
		if convErr != nil || pid <= 1 || commandLine == "" || owner == "" {
			continue
		}
		out = append(out, ProcessSnapshot{PID: pid, CommandLine: commandLine, Owner: owner})
	}
	return out
}

func currentUID() *int {
	uid := os.Getuid()
	if uid < 0 {
		return nil
	}
	return &uid
}

func defaultListSnapshots(platform string, getUID func() *int) []ProcessSnapshot {
	switch platform {
	case "windows":
		return ListWindowsSnapshots()
	case "darwin":
		return listDarwinSnapshots(getUID())
	default:
		return listUnixProcSnapshots(getUID())
	}
}

// ListCodexAppServerProcesses returns the current user's Codex app-server processes.
func ListCodexAppServerProcesses(io AppServerProcessIO) []CodexAppServerProcess {
	platform := io.Platform
	if platform == "" {
		platform = runtime.GOOS
	}
	getUID := io.GetUID
	if getUID == nil {
		getUID = currentUID
	}
	snapshots := []ProcessSnapshot{}
	if io.ListSnapshots != nil {
		snapshots = io.ListSnapshots()
	} else {
		snapshots = defaultListSnapshots(platform, getUID)
	}
	seen := map[int]bool{}
	matched := []CodexAppServerProcess{}
	for _, snapshot := range snapshots {
		if seen[snapshot.PID] || !IsCodexAppServerCommandLine(snapshot.CommandLine) {
			continue
		}
		seen[snapshot.PID] = true
		matched = append(matched, CodexAppServerProcess{PID: snapshot.PID, CommandLine: snapshot.CommandLine})
	}
	return matched
}

func FormatStaleCodexAppServerWarning(processes []CodexAppServerProcess) string {
	pids := make([]string, 0, len(processes))
	for _, process := range processes {
		pids = append(pids, strconv.Itoa(process.PID))
	}
	plural := "s"
	if len(processes) == 1 {
		plural = ""
	}
	return fmt.Sprintf(
		"WARNING: %d Codex app-server process(es) still running (PID%s: %s). ", len(processes), plural, strings.Join(pids, ", ")) +
		"Disk catalog/cache were updated, but Codex may keep showing the old model list until those processes restart. " +
		"Re-run with `ocx sync --restart-codex` (or `ocx sync-cache --restart-codex`) to send SIGTERM only to matching app-server processes. " +
		"Active turns may be interrupted."
}

type RestartCodexAppServersResult struct {
	Requested []int                  `json:"requested"`
	Stopped   []int                  `json:"stopped"`
	Surviving []int                  `json:"surviving"`
	Failed    []AppServerKillFailure `json:"failed"`
}

type AppServerKillFailure struct {
	PID   int    `json:"pid"`
	Error string `json:"error"`
}

// RestartCodexAppServers sends SIGTERM to matched processes and waits briefly. It never
// escalates to SIGKILL.
func RestartCodexAppServers(processes []CodexAppServerProcess, io AppServerProcessIO) RestartCodexAppServersResult {
	isAlive := io.IsAlive
	if isAlive == nil {
		isAlive = platformProcessAlive
	}
	kill := io.Kill
	if kill == nil {
		kill = signalProcess
	}
	wait := io.WaitExit
	if wait == nil {
		wait = waitForProcessExit
	}
	now := io.Now
	if now == nil {
		now = time.Now
	}
	result := RestartCodexAppServersResult{Requested: []int{}, Stopped: []int{}, Surviving: []int{}, Failed: []AppServerKillFailure{}}
	for _, process := range processes {
		result.Requested = append(result.Requested, process.PID)
	}

	// Re-resolve immediately before signalling so a recycled PID is never killed: a new
	// Codex-shaped process that reused the PID must not receive SIGTERM.
	live := map[int]CodexAppServerProcess{}
	for _, process := range ListCodexAppServerProcesses(io) {
		live[process.PID] = process
	}
	signaled := []CodexAppServerProcess{}
	for _, process := range processes {
		current, found := live[process.PID]
		if !found || CodexAppServerProcessIdentity(current) != CodexAppServerProcessIdentity(process) {
			// The original target exited or changed identity; never signal its replacement.
			if !isAlive(process.PID) {
				result.Stopped = append(result.Stopped, process.PID)
			}
			continue
		}
		if err := kill(process.PID, syscall.SIGTERM); err != nil {
			if isAlive(process.PID) {
				result.Failed = append(result.Failed, AppServerKillFailure{PID: process.PID, Error: err.Error()})
				result.Surviving = append(result.Surviving, process.PID)
			} else {
				result.Stopped = append(result.Stopped, process.PID)
			}
			continue
		}
		signaled = append(signaled, process)
	}

	// One shared deadline, so N survivors wait ~2s in total rather than N×2s.
	deadline := now().Add(2 * time.Second)
	for _, process := range signaled {
		remaining := deadline.Sub(now())
		if remaining < 0 {
			remaining = 0
		}
		if wait(process.PID, remaining) || !isAlive(process.PID) {
			result.Stopped = append(result.Stopped, process.PID)
		} else {
			result.Surviving = append(result.Surviving, process.PID)
		}
	}
	sort.Ints(result.Stopped)
	sort.Ints(result.Surviving)
	return result
}

// AppServerLogger receives the human-facing progress and failure lines.
type AppServerLogger interface {
	Log(message string)
	Error(message string)
}

type AfterCatalogWriteAppServerOptions struct {
	Restart bool
	Log     AppServerLogger
	IO      AppServerProcessIO
}

type AfterCatalogWriteAppServerResult struct {
	Processes []CodexAppServerProcess
	Warned    bool
	Restart   *RestartCodexAppServersResult
	Hint      string
}

// AfterCatalogWriteHandleAppServers warns about stale app-servers after a catalog or cache
// write, or restarts them when the caller asked for it.
func AfterCatalogWriteHandleAppServers(options AfterCatalogWriteAppServerOptions) AfterCatalogWriteAppServerResult {
	processes := ListCodexAppServerProcesses(options.IO)
	result := AfterCatalogWriteAppServerResult{Processes: processes, Hint: StaleCodexAppServerHint}
	if len(processes) == 0 {
		return result
	}
	if !options.Restart {
		if options.Log != nil {
			options.Log.Error(FormatStaleCodexAppServerWarning(processes))
		}
		result.Warned = true
		return result
	}
	pids := make([]string, 0, len(processes))
	for _, process := range processes {
		pids = append(pids, strconv.Itoa(process.PID))
	}
	if options.Log != nil {
		options.Log.Log("Stopping Codex app-server process(es): " + strings.Join(pids, ", ") + " (active turns may be interrupted).")
	}
	restart := RestartCodexAppServers(processes, options.IO)
	if options.Log != nil {
		if len(restart.Stopped) > 0 {
			stopped := make([]string, 0, len(restart.Stopped))
			for _, pid := range restart.Stopped {
				stopped = append(stopped, strconv.Itoa(pid))
			}
			options.Log.Log("Stopped Codex app-server PID(s): " + strings.Join(stopped, ", "))
		}
		for _, failure := range restart.Failed {
			options.Log.Error(fmt.Sprintf("Failed to stop Codex app-server PID %d: %s", failure.PID, failure.Error))
		}
		if len(restart.Surviving) > 0 {
			surviving := make([]string, 0, len(restart.Surviving))
			for _, pid := range restart.Surviving {
				surviving = append(surviving, strconv.Itoa(pid))
			}
			options.Log.Error("Codex app-server PID(s) still running after SIGTERM: " + strings.Join(surviving, ", ") +
				". Stop them manually if the model list stays stale.")
		}
	}
	result.Restart = &restart
	return result
}
