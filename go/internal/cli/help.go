package cli

import (
	"fmt"
	"io"
)

var commandHelp = map[string]string{
	"start":       "Usage: ocx start [--host HOST] [--port PORT]\n\nStart the proxy in the foreground.",
	"stop":        "Usage: ocx stop\n\nGracefully stop the running proxy.",
	"restart":     "Usage: ocx restart\n\nRestart the proxy as a detached process.",
	"health":      "Usage: ocx health [--json]\n\nCheck whether the proxy is healthy.",
	"gui":         "Usage: ocx gui\n\nStart the proxy if needed and open its dashboard.",
	"restore":     "Usage: ocx restore [back]\n\nRemove OpenCodex-owned entries from Codex config, or re-inject while the proxy is running.",
	"sync":        "Usage: ocx sync\n\nFetch models from the running proxy and inject the catalog into Codex.",
	"login":       "Usage: ocx login <provider>\n\nAuthenticate xAI, Anthropic, Kimi, Kiro, Google Antigravity, Cursor, or GitHub Copilot.",
	"logout":      "Usage: ocx logout <provider>\n\nRemove saved OAuth accounts for a provider.",
	"account":     accountUsage,
	"provider":    providerUsage,
	"models":      "Usage: ocx models <list|efforts|add|remove|list-custom> [arguments]",
	"init":        "Usage: ocx init\n\nInteractively configure a provider.",
	"status":      "Usage: ocx status [--json]\n\nShow proxy and service status.",
	"doctor":      "Usage: ocx doctor [--json]\n\nRun local configuration, process, and network diagnostics.",
	"diagnostics": "Usage: ocx diagnostics [--json]\n\nPrint a secret-free local diagnostic report.",
	"completion":  "Usage: ocx completion <bash|zsh|fish|powershell>\n\nGenerate shell completion setup.",
	"config":      "Usage: ocx config <path|show|get|set|unset|validate> [arguments]\n\nInspect and update validated configuration values.",
	"claude": "Usage: ocx claude [claude arguments...]\n\nLaunch Claude Code with proxy environment variables.\n\n" +
		"Claude Desktop profile:\n" +
		"  ocx claude desktop [apply] [--static|--hybrid|--discovery-only]\n" +
		"  ocx claude desktop show [--json]\n" +
		"  ocx claude desktop move <route> <opus|fable|sonnet|haiku> [--default]\n" +
		"  ocx claude desktop default <family> <route|none>\n" +
		"  ocx claude desktop export <path|->\n" +
		"  ocx claude desktop import <path> [--apply]",
	"debug":   "Usage: ocx debug <status|on|off|stack-on|stack-off>",
	"service": "Usage: ocx service [install|start|stop|status|uninstall]",
	"tray":    "Usage: ocx tray [install|start|stop|restart|status|uninstall|run] [--json] [--no-start]\n\nManage the Windows system tray companion.",
	"update":  "Usage: ocx update --tag latest|preview [--destination PATH] [--dry-run]\n       ocx update --url HTTPS_URL --sha256 HEX [--destination PATH]\n\nResolve a platform-native GitHub release artifact, verify its SHA-256 manifest, and replace the current binary.",
}

func PrintHelp(writer io.Writer, command string) error {
	if command != "" {
		canonical := command
		if position, ok := commandIndex[command]; ok {
			canonical = commandSpecs[position].Name
		}
		text, ok := commandHelp[canonical]
		if !ok {
			if position, exists := commandIndex[canonical]; exists {
				spec := commandSpecs[position]
				text, ok = "Usage: "+spec.Usage+"\n\n"+spec.Summary, true
			}
		}
		if !ok {
			return fmt.Errorf("unknown help topic %q", command)
		}
		_, err := fmt.Fprintln(writer, text)
		return err
	}
	_, err := fmt.Fprintln(writer, rootHelp)
	return err
}

// rootHelp intentionally follows the TypeScript launcher's public help bytes.
// Go-only administrative commands remain discoverable through `ocx help NAME`
// without changing the compatibility surface shown by a bare `ocx --help`.
const rootHelp = `opencodex (ocx) — Universal provider proxy for Codex

Usage:
  ocx init                    Interactive setup (provider + Codex config injection)
  ocx start [--port <port>]   Start the proxy server (auto-syncs models to Codex)
  ocx stop                    Stop the proxy AND restore native Codex (plain codex works again)
  ocx restore                 Restore native Codex without stopping (alias: eject)
  ocx restore back            Re-point codex at the running proxy (undo restore)
  ocx recover-history --legacy-openai
                               Explicitly recover pre-backup syncResumeHistory rows
  ocx uninstall               Remove service/shim/config and restore native Codex (alias: remove)
  ocx service [sub]           Run as a background service (default: install/update/start)
  ocx codex-shim <sub>        Auto-start proxy when ` + "`codex`" + ` launches (install|status|uninstall|remove)
  ocx tray <sub>              Windows status tray (install|start|stop|status|uninstall)
  ocx ensure                  Ensure the proxy is running and Codex config/cache are current
  ocx sync                    Fetch models from providers and inject into Codex config
  ocx sync-cache              Refresh Codex's model cache from the active catalog
  ocx status                  Check proxy server status
  ocx doctor                  Diagnose environment/network issues (WSL, proxy, ChatGPT reachability)
  ocx debug [provider|usage ...]
                              provider/usage on|off|status|reset|logs [-f]
  ocx login <provider>        OAuth login (xai) — opens browser, stores token in ~/.opencodex/auth.json
  ocx logout <provider>       Remove a stored OAuth login
  ocx gui                     Open the opencodex dashboard
  ocx update [--tag <tag>]    Update opencodex (keeps preview installs on @preview)
  ocx restart                  Stop and restart the proxy
  ocx v2 <sub>                multi_agent_v2 surface (status|on|off|mode|threads)
  ocx health [--json]          Check proxy health (exit 0=healthy, 1=not)
  ocx provider <sub>          Manage providers (list|add|remove|show|set-default)
  ocx account <sub>           Accounts/keys (list|current|use|refresh|auto-switch|remove|add-key)
  ocx models <sub>            List models; manage custom models (add|remove|list-custom)
  ocx claude [args...]        Launch Claude Code wired to the proxy (model discovery on)
  ocx claude desktop [sub]    Manage and apply Claude Desktop's four-family profile
  ocx help [command]          Show help
  ocx --version | -v          Print version

Examples:
  ocx init                    Set up provider and inject into Codex
  ocx start                   Start on default port (10100)
  ocx start --port 8080       Start on custom port
  ocx help service            Show service command help
  ocx sync                    Sync available models to Codex`
