package parity_test

import (
	"bytes"
	"encoding/json"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"

	updatepkg "github.com/lidge-jun/opencodex-go/internal/update"
)

func TestTypeScriptAndGoLongClaudeSession(t *testing.T) {
	upstream := newDifferentialUpstream(t)
	config := differentialConfig(upstream.server.URL, []string{"success"})
	tsProxy := startTypeScriptProxy(t, config)
	goProxy := startProxyWithConfig(t, config)
	messages := []any{}
	for turn := 1; turn <= 8; turn++ {
		messages = append(messages, map[string]any{"role": "user", "content": "Claude session turn"})
		body := map[string]any{"model": "differential/success", "max_tokens": 64, "stream": true, "messages": messages}
		compareRuntimeBytes(t, "session/claude-multiturn",
			captureJSON(t, goProxy.baseURL, "/v1/messages", body),
			captureJSON(t, tsProxy.baseURL, "/v1/messages", body), true)
		messages = append(messages, map[string]any{"role": "assistant", "content": "differential hello"})
	}
}

func TestTypeScriptAndGoUpdateDryRunPlanning(t *testing.T) {
	bun, err := exec.LookPath("bun")
	if err != nil {
		t.Skip("Bun runtime is unavailable")
	}
	repositoryRoot := typeScriptOracleRoot()
	indexModule := filepath.Join(repositoryRoot, "src", "update", "index.ts")
	jobModule := filepath.Join(repositoryRoot, "src", "update", "job.ts")
	script := `
import { defaultUpdateTag, updateCommand } from ` + string(mustJSON(indexModule)) + `;
import { restartCommand } from ` + string(mustJSON(jobModule)) + `;
console.log(JSON.stringify({
  channels: [defaultUpdateTag("2.0.0-preview.3"), defaultUpdateTag("2.0.0")],
  install: [
    updateCommand("bun", "preview", "2.1.0-preview.2"),
    updateCommand("npm", "latest", "2.1.0"),
  ],
  restart: [
    restartCommand(false, "bun", "/pkg/bin/ocx.mjs", 12000),
    restartCommand(true, "npm", "/pkg/bin/ocx.mjs", 12000, ["service", "install", "--native"]),
  ],
}));`
	output, err := exec.Command(bun, "-e", script).Output()
	if err != nil {
		t.Fatal(err)
	}
	var tsPlan map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(output), &tsPlan); err != nil {
		t.Fatal(err)
	}
	bunInstall := updatepkg.InstallCommand(updatepkg.InstallerBun, updatepkg.ChannelPreview, "2.1.0-preview.2")
	npmInstall := updatepkg.InstallCommand(updatepkg.InstallerNPM, updatepkg.ChannelLatest, "2.1.0")
	bunRestart := updatepkg.BuildRestartPlan(updatepkg.InstallerBun, bun, "/pkg/bin/ocx.mjs", false, 12000, nil)
	npmRestart := updatepkg.BuildRestartPlan(updatepkg.InstallerNPM, "ignored", "/pkg/bin/ocx.mjs", true, 12000, []string{"service", "install", "--native"})
	goPlan := map[string]any{
		"channels": []any{string(updatepkg.DefaultChannel("2.0.0-preview.3")), string(updatepkg.DefaultChannel("2.0.0"))},
		"install": []any{
			map[string]any{"bin": bunInstall.Bin, "args": stringSliceToAny(bunInstall.Args)},
			map[string]any{"bin": npmInstall.Bin, "args": stringSliceToAny(npmInstall.Args)},
		},
		"restart": []any{
			map[string]any{"mode": string(bunRestart.Mode), "bin": bunRestart.Command.Bin, "args": stringSliceToAny(bunRestart.Command.Args), "display": bunRestart.Command.String()},
			map[string]any{"mode": string(npmRestart.Mode), "bin": npmRestart.Command.Bin, "args": stringSliceToAny(npmRestart.Command.Args), "display": npmRestart.Command.String()},
		},
	}
	if !reflect.DeepEqual(goPlan, tsPlan) {
		goJSON, _ := json.Marshal(goPlan)
		t.Fatalf("update dry-run plan differs\nGo=%s\nTS=%s", goJSON, bytes.TrimSpace(output))
	}
}

func stringSliceToAny(values []string) []any {
	result := make([]any, len(values))
	for index, value := range values {
		result[index] = value
	}
	return result
}
