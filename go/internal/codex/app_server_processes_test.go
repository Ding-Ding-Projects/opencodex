package codex

import (
	"strings"
	"syscall"
	"testing"
	"time"
)

// Matching stays narrow on purpose: `app-server` must be the Codex SUBCOMMAND, so unrelated
// tools that merely contain "codex" in a path or a later argument are never signalled.
func TestIsCodexAppServerCommandLineMatchesOnlyTheRealThing(t *testing.T) {
	for _, testCase := range []struct {
		commandLine string
		want        bool
	}{
		{"codex app-server", true},
		{"/usr/local/bin/codex app-server", true},
		{`"C:\Program Files\codex\codex.exe" app-server`, true},
		{"codex-x86_64-unknown-linux-musl app-server", true},
		{"codex --config foo app-server", true},
		{"codex -c key=value app-server", true},
		{"codex --model gpt-5.6 app-server", true},
		{"codex --config=inline app-server", true},
		{"codex-code-mode-host --port 1", true},
		{"node /opt/codex-code-mode-host --port 1", true},
		{"", false},
		{"codex exec 'run app-server later'", false},
		{"node worker.js codex app-server", false},
		{"hermes-codex-bridge-mcp app-server", false},
		{"codex", false},
		{"opencodex app-server", false},
		// `--model` consumes its value, so the subcommand check must not stop at it.
		{"codex --model app-server", false},
	} {
		if got := IsCodexAppServerCommandLine(testCase.commandLine); got != testCase.want {
			t.Errorf("IsCodexAppServerCommandLine(%q) = %v, want %v", testCase.commandLine, got, testCase.want)
		}
	}
}

func TestTokenizeCommandLineHandlesQuotes(t *testing.T) {
	got := TokenizeCommandLine(`"/opt/my codex/codex.exe" app-server --config 'a b'`)
	want := []string{"/opt/my codex/codex.exe", "app-server", "--config", "a b"}
	if len(got) != len(want) {
		t.Fatalf("tokens = %#v, want %#v", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("tokens = %#v, want %#v", got, want)
		}
	}
}

func snapshotIO(snapshots []ProcessSnapshot) AppServerProcessIO {
	return AppServerProcessIO{ListSnapshots: func() []ProcessSnapshot { return snapshots }}
}

func TestListCodexAppServerProcessesFiltersAndDedupes(t *testing.T) {
	io := snapshotIO([]ProcessSnapshot{
		{PID: 10, CommandLine: "codex app-server"},
		{PID: 10, CommandLine: "codex app-server"},
		{PID: 11, CommandLine: "vim notes.md"},
		{PID: 12, CommandLine: "codex-code-mode-host"},
	})
	processes := ListCodexAppServerProcesses(io)
	if len(processes) != 2 || processes[0].PID != 10 || processes[1].PID != 12 {
		t.Fatalf("processes = %#v", processes)
	}
}

// A PID that was recycled between the match and the signal must not be killed: the identity
// (pid + normalized command line) has to match at signal time.
func TestRestartCodexAppServersSkipsARecycledPID(t *testing.T) {
	killed := []int{}
	io := AppServerProcessIO{
		ListSnapshots: func() []ProcessSnapshot {
			return []ProcessSnapshot{{PID: 42, CommandLine: "codex app-server --profile other"}}
		},
		IsAlive:  func(int) bool { return true },
		Kill:     func(pid int, _ syscall.Signal) error { killed = append(killed, pid); return nil },
		WaitExit: func(int, time.Duration) bool { return true },
		Now:      func() time.Time { return time.Unix(0, 0) },
	}
	result := RestartCodexAppServers([]CodexAppServerProcess{{PID: 42, CommandLine: "codex app-server"}}, io)
	if len(killed) != 0 {
		t.Fatalf("signalled a recycled pid: %v", killed)
	}
	if len(result.Stopped) != 0 || len(result.Surviving) != 0 {
		t.Fatalf("result = %#v, want the target reported as neither stopped nor surviving", result)
	}
}

func TestRestartCodexAppServersReportsStoppedAndSurviving(t *testing.T) {
	alive := map[int]bool{1: true, 2: true}
	io := AppServerProcessIO{
		ListSnapshots: func() []ProcessSnapshot {
			return []ProcessSnapshot{
				{PID: 1, CommandLine: "codex app-server"},
				{PID: 2, CommandLine: "codex app-server"},
			}
		},
		IsAlive: func(pid int) bool { return alive[pid] },
		Kill: func(pid int, signal syscall.Signal) error {
			if signal != syscall.SIGTERM {
				t.Fatalf("signal = %v, want SIGTERM (never SIGKILL)", signal)
			}
			if pid == 1 {
				alive[1] = false
			}
			return nil
		},
		WaitExit: func(pid int, _ time.Duration) bool { return !alive[pid] },
		Now:      func() time.Time { return time.Unix(0, 0) },
	}
	processes := []CodexAppServerProcess{{PID: 1, CommandLine: "codex app-server"}, {PID: 2, CommandLine: "codex app-server"}}
	result := RestartCodexAppServers(processes, io)
	if len(result.Stopped) != 1 || result.Stopped[0] != 1 {
		t.Fatalf("stopped = %v, want [1]", result.Stopped)
	}
	if len(result.Surviving) != 1 || result.Surviving[0] != 2 {
		t.Fatalf("surviving = %v, want [2]", result.Surviving)
	}
}

type recordingLogger struct{ out, err []string }

func (l *recordingLogger) Log(message string)   { l.out = append(l.out, message) }
func (l *recordingLogger) Error(message string) { l.err = append(l.err, message) }

func TestAfterCatalogWriteWarnsWithoutRestartAndTerminatesWithIt(t *testing.T) {
	snapshots := []ProcessSnapshot{{PID: 7, CommandLine: "codex app-server"}}
	warnLogger := &recordingLogger{}
	warned := AfterCatalogWriteHandleAppServers(AfterCatalogWriteAppServerOptions{
		Log: warnLogger, IO: snapshotIO(snapshots),
	})
	if !warned.Warned || warned.Restart != nil || len(warnLogger.err) != 1 {
		t.Fatalf("warn pass = %#v, stderr = %#v", warned, warnLogger.err)
	}
	if !strings.Contains(warnLogger.err[0], "ocx sync --restart-codex") {
		t.Fatalf("warning does not name the flag: %q", warnLogger.err[0])
	}

	restartLogger := &recordingLogger{}
	killed := []int{}
	restarted := AfterCatalogWriteHandleAppServers(AfterCatalogWriteAppServerOptions{
		Restart: true, Log: restartLogger,
		IO: AppServerProcessIO{
			ListSnapshots: func() []ProcessSnapshot { return snapshots },
			IsAlive:       func(pid int) bool { return len(killed) == 0 },
			Kill:          func(pid int, _ syscall.Signal) error { killed = append(killed, pid); return nil },
			WaitExit:      func(int, time.Duration) bool { return len(killed) > 0 },
			Now:           func() time.Time { return time.Unix(0, 0) },
		},
	})
	if restarted.Warned || restarted.Restart == nil || len(killed) != 1 || killed[0] != 7 {
		t.Fatalf("restart pass = %#v, killed = %v", restarted, killed)
	}
	if len(restarted.Restart.Stopped) != 1 || restarted.Restart.Stopped[0] != 7 {
		t.Fatalf("stopped = %v, want [7]", restarted.Restart.Stopped)
	}
}

// No app-server running means no warning and no restart block at all.
func TestAfterCatalogWriteStaysQuietWithNoProcesses(t *testing.T) {
	logger := &recordingLogger{}
	result := AfterCatalogWriteHandleAppServers(AfterCatalogWriteAppServerOptions{
		Restart: true, Log: logger, IO: snapshotIO(nil),
	})
	if result.Warned || result.Restart != nil || len(logger.out) != 0 || len(logger.err) != 0 {
		t.Fatalf("result = %#v out=%#v err=%#v", result, logger.out, logger.err)
	}
	if result.Hint != StaleCodexAppServerHint {
		t.Fatalf("hint = %q", result.Hint)
	}
}
