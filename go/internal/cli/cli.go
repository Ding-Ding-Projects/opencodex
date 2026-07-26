package cli

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/lib"
)

var Version = "0.1.0-dev"

type IO struct {
	In  io.Reader
	Out io.Writer
	Err io.Writer
}

type Command struct {
	Name string
	Args []string
}

type commandHandler func(context.Context, []string, IO) error

type commandSpec struct {
	Name    string
	Aliases []string
	Usage   string
	Summary string
	Handler commandHandler
	Hidden  bool
}

var commandSpecs []commandSpec
var commandIndex map[string]int

func init() {
	commandSpecs = defaultCommandSpecs()
	commandIndex = buildCommandIndex(commandSpecs)
}

func defaultCommandSpecs() []commandSpec {
	return []commandSpec{
		{Name: "help", Usage: "ocx help [command]", Summary: "Show help", Handler: commandHelpHandler},
		{Name: "version", Aliases: []string{"-v", "--version"}, Usage: "ocx --version", Summary: "Print version", Handler: commandVersionHandler},
		{Name: "start", Aliases: []string{"serve"}, Usage: "ocx start [--host HOST] [--port PORT]", Summary: "Start the proxy server", Handler: runServe},
		{Name: "stop", Usage: "ocx stop", Summary: "Gracefully stop the proxy", Handler: runStopCommand},
		{Name: "restart", Usage: "ocx restart", Summary: "Restart the proxy in background", Handler: runRestart},
		{Name: "ensure", Usage: "ocx ensure", Summary: "Ensure the proxy is running", Handler: runEnsure},
		{Name: "health", Usage: "ocx health [--json]", Summary: "Check proxy health", Handler: runHealth},
		{Name: "gui", Usage: "ocx gui", Summary: "Open the dashboard", Handler: runGUI},
		{Name: "restore", Aliases: []string{"eject"}, Usage: "ocx restore", Summary: "Restore native Codex routing", Handler: noContext(runRestore)},
		{Name: "uninstall", Aliases: []string{"remove"}, Usage: "ocx uninstall", Summary: "Remove proxy service integration", Handler: runUninstall},
		{Name: "codex-shim", Usage: "ocx codex-shim <install|status|uninstall>", Summary: "Manage Codex autostart shim", Handler: noContext(runCodexShim)},
		{Name: "sync-cache", Usage: "ocx sync-cache", Summary: "Invalidate the Codex model cache", Handler: noContext(runSyncCache)},
		{Name: "sync", Usage: "ocx sync", Summary: "Fetch models and inject them into Codex", Handler: runSync},
		{Name: "recover-history", Usage: "ocx recover-history --legacy-openai", Summary: "Recover legacy Codex history routing", Handler: noContext(runRecoverHistory)},
		{Name: "v2", Usage: "ocx v2 <status|on|off|mode|threads>", Summary: "Manage Codex multi-agent v2", Handler: noContext(runV2)},
		{Name: "login", Usage: "ocx login <provider>", Summary: "Authenticate an OAuth provider", Handler: runLogin},
		{Name: "logout", Usage: "ocx logout <provider>", Summary: "Remove saved OAuth accounts", Handler: runLogout},
		{Name: "account", Usage: "ocx account <subcommand>", Summary: "Manage provider accounts", Handler: runAccount},
		{Name: "provider", Usage: "ocx provider <subcommand>", Summary: "Manage providers", Handler: noContext(runProvider)},
		{Name: "models", Usage: "ocx models [subcommand]", Summary: "List models and effort support", Handler: noContext(runModels)},
		{Name: "init", Usage: "ocx init", Summary: "Interactive provider setup", Handler: noContext(runInit)},
		{Name: "status", Usage: "ocx status", Summary: "Show proxy and service status", Handler: runStatus},
		{Name: "doctor", Usage: "ocx doctor [--json]", Summary: "Run environment diagnostics", Handler: runDoctor},
		{Name: "diagnostics", Aliases: []string{"diagnose"}, Usage: "ocx diagnostics [--json]", Summary: "Print a secret-free diagnostic report", Handler: noContext(runDiagnostics)},
		{Name: "completion", Usage: "ocx completion <shell>", Summary: "Generate shell completions", Handler: noContext(runCompletion)},
		{Name: "config", Usage: "ocx config <subcommand>", Summary: "Inspect or update configuration", Handler: noContext(runConfig)},
		{Name: "claude", Usage: "ocx claude [args...]", Summary: "Launch Claude Code through the proxy", Handler: runClaude},
		{Name: "claude-desktop", Usage: "ocx claude-desktop [subcommand]", Summary: "Manage Claude Desktop model families", Handler: runClaudeDesktop, Hidden: true},
		{Name: "debug", Usage: "ocx debug <subcommand>", Summary: "Configure runtime diagnostics", Handler: noContext(runDebug)},
		{Name: "service", Usage: "ocx service [subcommand]", Summary: "Manage the background service", Handler: noContext(runService)},
		{Name: "tray", Usage: "ocx tray [subcommand]", Summary: "Manage the Windows tray companion", Handler: runTray},
		{Name: "update", Usage: "ocx update [options]", Summary: "Replace the binary with a verified update", Handler: runUpdate},
	}
}

func buildCommandIndex(specs []commandSpec) map[string]int {
	index := make(map[string]int, len(specs)*2)
	for position, spec := range specs {
		index[spec.Name] = position
		for _, alias := range spec.Aliases {
			index[alias] = position
		}
	}
	return index
}

func noContext(handler func([]string, IO) error) commandHandler {
	return func(_ context.Context, args []string, streams IO) error { return handler(args, streams) }
}

func commandHelpHandler(_ context.Context, args []string, streams IO) error {
	return PrintHelp(streams.Out, first(args))
}

func commandVersionHandler(_ context.Context, _ []string, streams IO) error {
	_, err := fmt.Fprintf(streams.Out, "opencodex %s\n", Version)
	return err
}

func Parse(args []string) (Command, error) {
	if len(args) == 0 {
		return Command{Name: "help"}, nil
	}
	name := strings.ToLower(strings.TrimSpace(args[0]))
	if name == "-h" || name == "--help" {
		name = "help"
	}
	if _, exists := commandIndex[name]; !exists && strings.HasPrefix(name, "-") {
		return Command{}, fmt.Errorf("unknown option %q", args[0])
	}
	return Command{Name: name, Args: append([]string(nil), args[1:]...)}, nil
}

// Dispatch executes os.Args and returns a process exit code.
func Dispatch() int {
	return dispatchGuarded(func() int {
		return Run(context.Background(), os.Args[1:], IO{In: os.Stdin, Out: os.Stdout, Err: os.Stderr})
	}, os.Stderr)
}

func dispatchGuarded(run func() int, stderr io.Writer) int {
	dir, err := configDir()
	if err != nil {
		dir = os.TempDir()
	}
	exitCode := 1
	crashed, guardErr := lib.RunGuarded(filepath.Join(dir, "crash.log"), "uncaughtException", lib.DefaultSidecarTracker, func() {
		exitCode = run()
	})
	if guardErr != nil && stderr != nil {
		fmt.Fprintln(stderr, "Error: write crash log:", guardErr)
	}
	if crashed && stderr != nil {
		fmt.Fprintln(stderr, "Error: unexpected CLI panic (details written to crash.log)")
	}
	return exitCode
}

func Run(ctx context.Context, args []string, streams IO) int {
	command, err := Parse(args)
	if err != nil {
		fmt.Fprintln(streams.Err, "Error:", err)
		return 1
	}
	position, ok := commandIndex[command.Name]
	if !ok {
		fmt.Fprintf(streams.Err, "Unknown command: %s\n", command.Name)
		_ = PrintHelp(streams.Out, "")
		return 1
	}
	spec := commandSpecs[position]
	if runErr := spec.Handler(ctx, command.Args, streams); runErr != nil {
		fmt.Fprintln(streams.Err, "Error:", runErr)
		return 1
	}
	return 0
}

func registeredCommandNames(includeAliases bool) []string {
	names := []string{}
	for _, spec := range commandSpecs {
		if spec.Hidden {
			continue
		}
		names = append(names, spec.Name)
		if includeAliases {
			for _, alias := range spec.Aliases {
				if !strings.HasPrefix(alias, "-") {
					names = append(names, alias)
				}
			}
		}
	}
	sort.Strings(names)
	return names
}

func first(values []string) string {
	if len(values) == 0 {
		return ""
	}
	return values[0]
}
