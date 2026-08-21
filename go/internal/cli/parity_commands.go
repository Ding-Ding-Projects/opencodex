package cli

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func runChangelog(args []string, streams IO) error {
	jsonOutput := false
	for _, arg := range args {
		if arg == "--json" {
			jsonOutput = true
		} else {
			return fmt.Errorf("usage: ocx changelog [--json]")
		}
	}
	dir, err := configDir()
	if err != nil {
		return err
	}
	data, readErr := os.ReadFile(filepath.Join(filepath.Dir(dir), "CHANGELOG.md"))
	if os.IsNotExist(readErr) {
		data, readErr = os.ReadFile(filepath.Join(dir, "CHANGELOG.md"))
	}
	if readErr != nil {
		if jsonOutput {
			return json.NewEncoder(streams.Out).Encode(map[string]any{"available": false, "releases": []any{}})
		}
		fmt.Fprintln(streams.Out, "Changelog is unavailable in this installation.")
		return nil
	}
	if jsonOutput {
		return json.NewEncoder(streams.Out).Encode(map[string]any{"available": true, "markdown": string(data)})
	}
	_, err = streams.Out.Write(data)
	if err == nil && (len(data) == 0 || data[len(data)-1] != '\n') {
		_, err = fmt.Fprintln(streams.Out)
	}
	return err
}

func runExport(args []string, streams IO) error {
	return runConfig(append([]string{"export"}, args...), streams)
}

func runHost(args []string, streams IO) error {
	jsonOutput := false
	verb := "status"
	for _, arg := range args {
		if arg == "--json" {
			jsonOutput = true
		} else if verb == "status" && !strings.HasPrefix(arg, "--") {
			verb = arg
		} else {
			return fmt.Errorf("usage: ocx host [status|discover] [--json]")
		}
	}
	cfg, _, err := loadConfig()
	if err != nil {
		return err
	}
	if verb != "status" && verb != "discover" {
		return fmt.Errorf("unknown host subcommand %q", verb)
	}
	value := map[string]any{"hostname": cfg.Host, "port": cfg.Port, "exposed": !isLoopbackCLIHost(cfg.Host), "credentialPresent": len(cfg.APIKeys) > 0}
	if verb == "discover" {
		value = map[string]any{"hosts": []any{value}}
	}
	if jsonOutput {
		return json.NewEncoder(streams.Out).Encode(value)
	}
	if verb == "discover" {
		fmt.Fprintf(streams.Out, "local\t%s:%d\n", cfg.Host, cfg.Port)
	} else {
		fmt.Fprintf(streams.Out, "hostname=%s port=%d exposed=%t credentialPresent=%t\n", cfg.Host, cfg.Port, value["exposed"], value["credentialPresent"])
	}
	return nil
}

func runLaunch(args []string, streams IO) error {
	jsonOutput := false
	positional := []string{}
	for _, arg := range args {
		if arg == "--json" {
			jsonOutput = true
		} else if strings.HasPrefix(arg, "--") {
			return fmt.Errorf("unsupported launch option %q", arg)
		} else {
			positional = append(positional, arg)
		}
	}
	if len(positional) > 1 {
		return fmt.Errorf("usage: ocx launch [target] [--json]")
	}
	targets := []map[string]any{{"id": "codex", "kind": "cli", "label": "Codex", "available": false}, {"id": "claude", "kind": "cli", "label": "Claude Code", "available": false}, {"id": "grok", "kind": "cli", "label": "Grok", "available": false}}
	if len(positional) == 1 {
		for _, target := range targets {
			if target["id"] == positional[0] {
				return jsonOrTextUnavailable(streams, jsonOutput, target)
			}
		}
		return fmt.Errorf("unknown launch target %q", positional[0])
	}
	if jsonOutput {
		return json.NewEncoder(streams.Out).Encode(map[string]any{"targets": targets})
	}
	for _, target := range targets {
		fmt.Fprintf(streams.Out, "%s\t%s\tnot installed\n", target["id"], target["label"])
	}
	return nil
}

func runTerminal(args []string, streams IO) error {
	jsonOutput := false
	verb := "list"
	for _, arg := range args {
		if arg == "--json" {
			jsonOutput = true
		} else if verb == "list" && !strings.HasPrefix(arg, "--") {
			verb = arg
		} else {
			return fmt.Errorf("usage: ocx terminal [list] [--json]")
		}
	}
	if verb != "list" {
		return fmt.Errorf("terminal sessions require the authenticated management host; use ocx terminal list")
	}
	presets := []map[string]any{{"id": "shell", "label": "Shell", "available": false}, {"id": "powershell", "label": "PowerShell", "available": false}}
	if jsonOutput {
		return json.NewEncoder(streams.Out).Encode(map[string]any{"presets": presets})
	}
	for _, preset := range presets {
		fmt.Fprintf(streams.Out, "%s\t%s\tnot available\n", preset["id"], preset["label"])
	}
	return nil
}

func jsonOrTextUnavailable(streams IO, jsonOutput bool, target map[string]any) error {
	target["reason"] = "target_unavailable"
	if jsonOutput {
		return json.NewEncoder(streams.Out).Encode(target)
	}
	return fmt.Errorf("%s is not installed", target["label"])
}

func isLoopbackCLIHost(host string) bool {
	host = strings.Trim(strings.ToLower(strings.TrimSpace(host)), "[]")
	return host == "" || host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "0.0.0.0" || host == "::"
}
