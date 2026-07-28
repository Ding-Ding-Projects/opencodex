package cli

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"sync"
)

const systemUsage = `Usage:
  ocx system [status] [--json]
  ocx system settings [--auto-start <on|off>] [--stream-mode <auto|legacy-tee|eager-relay>] [--json]
  ocx system startup <health|install-service|install-shim> [--json]
  ocx system diagnostics [--json]
  ocx system sync [--json]
  ocx system update check [--channel <latest|preview>] [--json]
  ocx system update run [--channel <latest|preview>] [--restart <on|off>] --yes [--json]
  ocx system update status <job-id> [--json]`

func runSystem(ctx context.Context, args []string, streams IO) error {
	return systemDispatch(ctx, runtimeAPI{}, args, streams)
}

// systemDispatch is the seam a test drives with an injected client.
func systemDispatch(ctx context.Context, api runtimeAPI, args []string, streams IO) error {
	rest := append([]string{}, args...)
	action := "status"
	if len(rest) > 0 {
		action, rest = rest[0], rest[1:]
	}
	switch action {
	case "status":
		return systemStatus(ctx, api, rest, streams)
	case "settings":
		return systemSettings(ctx, api, rest, streams)
	case "startup":
		return systemStartup(ctx, api, rest, streams)
	case "diagnostics":
		return systemSimple(ctx, api, http.MethodGet, "/api/diagnostics/project-config", rest, streams)
	case "sync":
		return systemSimple(ctx, api, http.MethodPost, "/api/sync", rest, streams)
	case "update":
		return systemUpdate(ctx, api, rest, streams)
	}
	return usageError(systemUsage, "unknown system command %s", action)
}

// systemSimple prints the payload with no summary, matching the oracle's bare
// printData(result, wantsJson) call for these two.
func systemSimple(ctx context.Context, api runtimeAPI, method, path string, args []string, streams IO) error {
	wantsJSON := takeFlag(&args, "--json")
	if err := rejectArgs(args, systemUsage, false); err != nil {
		return err
	}
	result, err := api.request(ctx, method, path, nil)
	if err != nil {
		return err
	}
	return printData(streams, result, wantsJSON, nil)
}

func systemStatus(ctx context.Context, api runtimeAPI, args []string, streams IO) error {
	wantsJSON := takeFlag(&args, "--json")
	if err := rejectArgs(args, systemUsage, false); err != nil {
		return err
	}
	// The oracle issues these concurrently via Promise.all and renders them in
	// this order. A map would re-sort the sections alphabetically, so the pairs
	// are kept ordered and only converted for JSON output.
	sections := []struct{ key, path string }{
		{"settings", "/api/settings"},
		{"startup", "/api/startup-health"},
		{"memory", "/api/system/memory"},
	}
	values := make([]any, len(sections))
	errs := make([]error, len(sections))
	var wait sync.WaitGroup
	for index, section := range sections {
		wait.Add(1)
		go func(index int, path string) {
			defer wait.Done()
			values[index], errs[index] = api.request(ctx, http.MethodGet, path, nil)
		}(index, section.path)
	}
	wait.Wait()
	for _, err := range errs {
		if err != nil {
			return err
		}
	}
	ordered := make([][2]any, len(sections))
	for index, section := range sections {
		ordered[index] = [2]any{section.key, values[index]}
	}
	// A map would re-sort these keys for --json; the oracle's object keeps the
	// order it was built in, so the payload carries its own byte form.
	payload, err := orderedObject(ordered)
	if err != nil {
		return err
	}
	return printData(streams, payload, wantsJSON, orderedSummaryLines(ordered))
}

// systemSettings reads when given no flags and writes when given any. Treating
// it as read-only would drop the only path that changes these settings.
func systemSettings(ctx context.Context, api runtimeAPI, args []string, streams IO) error {
	wantsJSON := takeFlag(&args, "--json")
	autoStart, hasAutoStart, err := takeBooleanOption(&args, "--auto-start")
	if err != nil {
		return err
	}
	streamMode, hasStreamMode, err := takeOption(&args, "--stream-mode")
	if err != nil {
		return err
	}
	if err := rejectArgs(args, systemUsage, false); err != nil {
		return err
	}
	if !hasAutoStart && !hasStreamMode {
		result, err := api.request(ctx, http.MethodGet, "/api/settings", nil)
		if err != nil {
			return err
		}
		return printData(streams, result, wantsJSON, summaryLines(result))
	}
	body := map[string]any{}
	if hasAutoStart {
		body["codexAutoStart"] = autoStart
	}
	if hasStreamMode {
		body["streamMode"] = streamMode
	}
	result, err := api.request(ctx, http.MethodPut, "/api/settings", body)
	if err != nil {
		return err
	}
	return printData(streams, result, wantsJSON, []string{"System settings updated."})
}

func systemStartup(ctx context.Context, api runtimeAPI, args []string, streams IO) error {
	action := "health"
	if len(args) > 0 {
		action, args = lowerASCII(args[0]), args[1:]
	}
	wantsJSON := takeFlag(&args, "--json")
	if err := rejectArgs(args, systemUsage, false); err != nil {
		return err
	}
	if action == "health" || action == "status" {
		result, err := api.request(ctx, http.MethodGet, "/api/startup-health", nil)
		if err != nil {
			return err
		}
		return printData(streams, result, wantsJSON, summaryLines(result))
	}
	if action != "install-service" && action != "install-shim" {
		return usageError(systemUsage, "startup action must be health, install-service, or install-shim")
	}
	result, err := api.request(ctx, http.MethodPost, "/api/startup-action", map[string]any{"action": action})
	if err != nil {
		return err
	}
	line := action + " complete."
	if record, ok := result.(map[string]any); ok {
		if message, ok := record["message"].(string); ok && message != "" {
			line = message
		}
	}
	return printData(streams, result, wantsJSON, []string{line})
}

func systemUpdate(ctx context.Context, api runtimeAPI, args []string, streams IO) error {
	action := "check"
	if len(args) > 0 {
		action, args = lowerASCII(args[0]), args[1:]
	}
	wantsJSON := takeFlag(&args, "--json")

	if action == "status" {
		if len(args) == 0 {
			return usageError(systemUsage, "update job id is required")
		}
		jobID := args[0]
		args = args[1:]
		if err := rejectArgs(args, systemUsage, false); err != nil {
			return err
		}
		result, err := api.request(ctx, http.MethodGet, "/api/update/status?jobId="+encodeURIComponent(jobID), nil)
		if err != nil {
			return err
		}
		return printData(streams, result, wantsJSON, nil)
	}

	channel, hasChannel, err := takeOption(&args, "--channel")
	if err != nil {
		return err
	}
	if !hasChannel {
		channel = "latest"
	}
	if channel != "latest" && channel != "preview" {
		return usageError(systemUsage, "--channel must be latest or preview")
	}
	if action == "check" {
		if err := rejectArgs(args, systemUsage, false); err != nil {
			return err
		}
		result, err := api.request(ctx, http.MethodGet, "/api/update/check?tag="+channel, nil)
		if err != nil {
			return err
		}
		return printData(streams, result, wantsJSON, nil)
	}
	if action != "run" {
		return usageError(systemUsage, "unknown update action %s", action)
	}
	// The oracle defaults --restart to true, so omitting it still restarts.
	restart, hasRestart, err := takeBooleanOption(&args, "--restart")
	if err != nil {
		return err
	}
	if !hasRestart {
		restart = true
	}
	confirmed := takeFlag(&args, "--yes")
	if !confirmed {
		return usageError(systemUsage, "update run requires --yes")
	}
	if err := rejectArgs(args, systemUsage, false); err != nil {
		return err
	}
	result, err := api.request(ctx, http.MethodPost, "/api/update/run", map[string]any{"tag": channel, "restart": restart})
	if err != nil {
		return err
	}
	return printData(streams, result, wantsJSON, []string{fmt.Sprintf("Update started (%s).", channel)})
}

// lowerASCII lowercases a subcommand word the way String.prototype.toLowerCase
// does for the ASCII keywords these dispatchers compare against.
func lowerASCII(value string) string {
	return strings.ToLower(value)
}
