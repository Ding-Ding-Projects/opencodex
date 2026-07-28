package cli

import (
	"context"
	"math"
	"net/http"
	"sort"
	"strings"
)

const grokUsage = `Usage:
  ocx grok [status|show] [--json]
  ocx grok exclude|include|set <model,model...> [--json]
  ocx grok clear [--json]
  ocx grok apply [--json]`

const claudeConfigUsage = `Usage:
  ocx integration claude [status|show] [--json]
  ocx integration claude set [--enabled <on|off>] [--auth-mode <mode>]
      [--system-env <on|off>] [--fast-mode <on|off>] [--auto-context <on|off>]
      [--compact-window <n|default>] [--inject-agents <on|off>]
      [--small-fast-model <id|->] [--model-map <from=to,...|->]
      [--blocked-skills <a,b|->] [--web-model <id|->] [--web-backend <name|->]
      [--vision-model <id|->] [--vision-backend <name|->] [--json]`

const integrationUsage = `Usage:
  ocx integration <claude|grok> <subcommand>`

func runGrok(ctx context.Context, args []string, streams IO) error {
	return grokDispatch(ctx, runtimeAPI{}, args, streams)
}

// grokDispatch is the seam a test drives with an injected client.
func grokDispatch(ctx context.Context, api runtimeAPI, args []string, streams IO) error {
	rest := append([]string{}, args...)
	action := "status"
	if len(rest) > 0 {
		action, rest = strings.ToLower(rest[0]), rest[1:]
	}
	wantsJSON := takeFlag(&rest, "--json")

	switch action {
	case "status", "show":
		if err := rejectArgs(rest, grokUsage, false); err != nil {
			return err
		}
		result, err := api.request(ctx, http.MethodGet, "/api/grok", nil)
		if err != nil {
			return err
		}
		return printData(streams, result, wantsJSON, summaryLines(result))
	case "apply":
		if err := rejectArgs(rest, grokUsage, false); err != nil {
			return err
		}
		result, err := api.request(ctx, http.MethodPost, "/api/grok/apply", nil)
		if err != nil {
			return err
		}
		line := "Grok configuration applied."
		if record, ok := result.(map[string]any); ok {
			if message, ok := record["message"].(string); ok && message != "" {
				line = message
			}
		}
		return printData(streams, result, wantsJSON, []string{line})
	}

	var excluded []string
	switch action {
	case "clear":
		excluded = []string{}
	case "exclude", "include", "set":
		if len(rest) == 0 {
			return usageError(grokUsage, "comma-separated models are required")
		}
		requested := csvValues(rest[0])
		rest = rest[1:]
		if action == "set" {
			excluded = requested
			break
		}
		// exclude/include are relative edits, so the current server state has to
		// be read first; sending only the requested models would replace the
		// list instead of adding to or removing from it.
		state, err := api.request(ctx, http.MethodGet, "/api/grok", nil)
		if err != nil {
			return err
		}
		// The oracle merges through a Set, which keeps whatever the server
		// stored. Silently dropping an entry we cannot type-assert would make a
		// relative edit destructive: `grok exclude c` would delete unrelated
		// exclusions just because they were not strings.
		current := []string{}
		if record, ok := state.(map[string]any); ok {
			if list, ok := record["excluded"].([]any); ok {
				for _, item := range list {
					model, ok := item.(string)
					if !ok {
						return usageError(grokUsage,
							"the proxy reported a non-string Grok exclusion (%v); fix it with `ocx grok set` before a relative edit", item)
					}
					current = append(current, model)
				}
			}
		}
		seen := map[string]struct{}{}
		for _, model := range current {
			seen[model] = struct{}{}
		}
		for _, model := range requested {
			if action == "exclude" {
				seen[model] = struct{}{}
			} else {
				delete(seen, model)
			}
		}
		excluded = make([]string, 0, len(seen))
		for model := range seen {
			excluded = append(excluded, model)
		}
		sort.Strings(excluded)
	default:
		return usageError(grokUsage, "unknown Grok command %s", action)
	}

	if err := rejectArgs(rest, grokUsage, false); err != nil {
		return err
	}
	result, err := api.request(ctx, http.MethodPut, "/api/grok/selection", map[string]any{"excluded": excluded})
	if err != nil {
		return err
	}
	summary := strings.Join(excluded, ", ")
	if summary == "" {
		summary = "none"
	}
	return printData(streams, result, wantsJSON, []string{"Grok exclusions: " + summary})
}

// parseModelMap reads `from=to,...`; `-` clears the whole map.
func parseModelMap(raw string) (map[string]string, error) {
	if raw == "-" {
		return map[string]string{}, nil
	}
	out := map[string]string{}
	for _, pair := range strings.Split(raw, ",") {
		index := strings.Index(pair, "=")
		if index <= 0 || index == len(pair)-1 {
			return nil, usageError(claudeConfigUsage, "invalid model map entry %q; use from=to", pair)
		}
		out[strings.TrimSpace(pair[:index])] = strings.TrimSpace(pair[index+1:])
	}
	return out, nil
}

func runIntegration(ctx context.Context, args []string, streams IO) error {
	if len(args) == 0 {
		return usageError(integrationUsage, "integration requires claude or grok")
	}
	switch strings.ToLower(args[0]) {
	case "grok":
		return runGrok(ctx, args[1:], streams)
	case "claude":
		return claudeConfigDispatch(ctx, runtimeAPI{}, args[1:], streams)
	}
	return usageError(integrationUsage, "integration requires claude or grok")
}

func claudeConfigDispatch(ctx context.Context, api runtimeAPI, args []string, streams IO) error {
	rest := append([]string{}, args...)
	action := "status"
	if len(rest) > 0 {
		action, rest = strings.ToLower(rest[0]), rest[1:]
	}
	wantsJSON := takeFlag(&rest, "--json")

	if action == "status" || action == "show" {
		if err := rejectArgs(rest, claudeConfigUsage, false); err != nil {
			return err
		}
		result, err := api.request(ctx, http.MethodGet, "/api/claude-code", nil)
		if err != nil {
			return err
		}
		return printData(streams, result, wantsJSON, summaryLines(result))
	}
	if action != "set" {
		return usageError(claudeConfigUsage, "unknown Claude config command %s", action)
	}

	body := map[string]any{}
	for _, option := range []struct{ flag, field string }{
		{"--enabled", "enabled"},
		{"--system-env", "systemEnv"},
		{"--fast-mode", "fastMode"},
		{"--auto-context", "autoContext"},
		{"--inject-agents", "injectAgents"},
	} {
		value, present, err := takeBooleanOption(&rest, option.flag)
		if err != nil {
			return err
		}
		if present {
			body[option.field] = value
		}
	}
	if authMode, present, err := takeOption(&rest, "--auth-mode"); err != nil {
		return err
	} else if present {
		body["authMode"] = authMode
	}
	// `default` and `-` both mean "no window pinned"; anything else must be a
	// positive integer, so a typo cannot silently disable compaction.
	if compact, present, err := takeOption(&rest, "--compact-window"); err != nil {
		return err
	} else if present {
		if compact == "default" || compact == "-" {
			body["autoCompactWindow"] = nil
		} else {
			// Validate as float64: converting first would reject a large but
			// legitimate value the oracle accepts, because the int conversion
			// cannot represent it.
			parsed, valid := jsNumber(strings.NewReplacer("_", "", ",", "").Replace(compact))
			if !valid || math.IsNaN(parsed) || math.IsInf(parsed, 0) || parsed != math.Trunc(parsed) || parsed <= 0 {
				return usageError(claudeConfigUsage, "--compact-window must be a positive integer or default")
			}
			body["autoCompactWindow"] = parsed
		}
	}
	if model, present, err := takeOption(&rest, "--small-fast-model"); err != nil {
		return err
	} else if present {
		if model == "-" {
			body["smallFastModel"] = ""
		} else {
			body["smallFastModel"] = model
		}
	}
	if raw, present, err := takeOption(&rest, "--model-map"); err != nil {
		return err
	} else if present {
		parsed, mapErr := parseModelMap(raw)
		if mapErr != nil {
			return mapErr
		}
		body["modelMap"] = parsed
	}
	if raw, present, err := takeOption(&rest, "--blocked-skills"); err != nil {
		return err
	} else if present {
		if raw == "-" {
			body["blockedSkills"] = nil
		} else {
			body["blockedSkills"] = csvValues(raw)
		}
	}

	webModel, hasWebModel, err := takeOption(&rest, "--web-model")
	if err != nil {
		return err
	}
	webBackend, hasWebBackend, err := takeOption(&rest, "--web-backend")
	if err != nil {
		return err
	}
	visionModel, hasVisionModel, err := takeOption(&rest, "--vision-model")
	if err != nil {
		return err
	}
	visionBackend, hasVisionBackend, err := takeOption(&rest, "--vision-backend")
	if err != nil {
		return err
	}
	if settings := claudeSidecar(webModel, hasWebModel, webBackend, hasWebBackend); settings != nil {
		body["webSearchSidecar"] = settings
	}
	if settings := claudeSidecar(visionModel, hasVisionModel, visionBackend, hasVisionBackend); settings != nil {
		body["visionSidecar"] = settings
	}

	if err := rejectArgs(rest, claudeConfigUsage, false); err != nil {
		return err
	}
	if len(body) == 0 {
		return usageError(claudeConfigUsage, "at least one Claude setting is required")
	}
	result, err := api.request(ctx, http.MethodPut, "/api/claude-code", body)
	if err != nil {
		return err
	}
	return printData(streams, result, wantsJSON, []string{"Claude Code settings updated."})
}

// claudeSidecar builds a sidecar patch, or nil when neither half was given.
// model clears to "" and backend to null, matching how the API distinguishes
// "no model chosen" from "no backend pinned".
func claudeSidecar(model string, hasModel bool, backend string, hasBackend bool) map[string]any {
	if !hasModel && !hasBackend {
		return nil
	}
	settings := map[string]any{}
	if hasModel {
		if model == "-" {
			settings["model"] = ""
		} else {
			settings["model"] = model
		}
	}
	if hasBackend {
		if backend == "-" {
			settings["backend"] = nil
		} else {
			settings["backend"] = backend
		}
	}
	return settings
}
