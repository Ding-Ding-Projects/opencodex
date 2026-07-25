package cli

import (
	"fmt"
	"io"
)

var commandHelp = map[string]string{
	"serve":       "Usage: ocx serve [--host HOST] [--port PORT]\n\nStart the proxy in the foreground.",
	"stop":        "Usage: ocx stop\n\nGracefully stop the running proxy.",
	"restart":     "Usage: ocx restart\n\nRestart the proxy as a detached process.",
	"health":      "Usage: ocx health [--json]\n\nCheck whether the proxy is healthy.",
	"gui":         "Usage: ocx gui\n\nStart the proxy if needed and open its dashboard.",
	"restore":     "Usage: ocx restore\n\nRemove OpenCodex-owned entries from Codex config.",
	"login":       "Usage: ocx login <chatgpt|anthropic>\n\nAuthenticate an OAuth provider in the browser.",
	"logout":      "Usage: ocx logout <provider>\n\nRemove saved OAuth accounts for a provider.",
	"account":     "Usage: ocx account <list|switch|add|remove|refresh> [arguments]",
	"provider":    "Usage: ocx provider <list|add|remove|default> [arguments]",
	"models":      "Usage: ocx models <list|add|remove> [arguments]",
	"init":        "Usage: ocx init\n\nInteractively configure a provider.",
	"status":      "Usage: ocx status\n\nShow proxy and service status.",
	"doctor":      "Usage: ocx doctor\n\nRun local configuration, process, and network diagnostics.",
	"diagnostics": "Usage: ocx diagnostics [--json]\n\nPrint a secret-free local diagnostic report.",
	"completion":  "Usage: ocx completion <bash|zsh|fish|powershell>\n\nGenerate shell completion setup.",
	"config":      "Usage: ocx config <path|show|get|set|unset|validate> [arguments]\n\nInspect and update validated configuration values.",
	"claude":      "Usage: ocx claude [claude arguments...]\n\nLaunch Claude Code with proxy environment variables.",
	"debug":       "Usage: ocx debug <status|on|off|stack-on|stack-off>",
	"service":     "Usage: ocx service [install|start|stop|status|uninstall]",
	"tray":        "Usage: ocx tray [install|start|stop|restart|status|uninstall|run]\n\nManage the Windows system tray companion.",
	"update":      "Usage: ocx update --url HTTPS_URL --sha256 HEX [--destination PATH]",
}

func PrintHelp(writer io.Writer, command string) error {
	if command != "" {
		text, ok := commandHelp[command]
		if !ok {
			return fmt.Errorf("unknown help topic %q", command)
		}
		_, err := fmt.Fprintln(writer, text)
		return err
	}
	_, err := fmt.Fprint(writer, `opencodex (ocx) — Universal provider proxy for Codex

Usage:
  ocx serve [--port PORT]     Start the proxy server
  ocx stop                    Gracefully stop the proxy
  ocx restart                 Restart the proxy in background
  ocx health [--json]         Check proxy health
  ocx gui                     Open the dashboard
  ocx restore                 Restore native Codex routing
  ocx login <provider>        Authenticate an OAuth provider
  ocx logout <provider>       Remove saved OAuth accounts
  ocx init                    Interactive provider setup
  ocx status                  Show proxy and service status
  ocx doctor                  Run diagnostics
  ocx diagnostics [--json]   Print a secret-free diagnostic report
  ocx completion <shell>     Generate shell completions
  ocx config <subcommand>    Inspect or update configuration
  ocx service [subcommand]    Manage the background service
  ocx tray [subcommand]       Manage the Windows tray companion
  ocx provider <subcommand>   Manage providers
  ocx account <subcommand>    Manage provider accounts
  ocx models <subcommand>     List or edit configured models
  ocx claude [args...]        Launch Claude Code through the proxy
  ocx debug <subcommand>      Configure runtime diagnostics
  ocx update [options]        Replace the binary with a verified update
  ocx help [command]          Show help
  ocx --version               Print version
`)
	return err
}
