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
	"claude":      "Usage: ocx claude [claude arguments...]\n\nLaunch Claude Code with proxy environment variables.",
	"debug":       "Usage: ocx debug <status|on|off|stack-on|stack-off>",
	"service":     "Usage: ocx service [install|start|stop|status|uninstall]",
	"tray":        "Usage: ocx tray [install|start|stop|restart|status|uninstall|run] [--json] [--no-start]\n\nManage the Windows system tray companion.",
	"update":      "Usage: ocx update --tag latest|preview [--destination PATH] [--dry-run]\n       ocx update --url HTTPS_URL --sha256 HEX [--destination PATH]\n\nResolve a platform-native GitHub release artifact, verify its SHA-256 manifest, and replace the current binary.",
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
	if _, err := fmt.Fprintln(writer, "opencodex (ocx) — Universal provider proxy for Codex\n\nUsage:"); err != nil {
		return err
	}
	for _, spec := range commandSpecs {
		if spec.Hidden || spec.Name == "version" {
			continue
		}
		if _, err := fmt.Fprintf(writer, "  %-38s %s\n", spec.Usage, spec.Summary); err != nil {
			return err
		}
	}
	_, err := fmt.Fprintln(writer, "  ocx --version                          Print version")
	return err
}
