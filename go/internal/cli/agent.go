package cli

import (
	"context"
	"fmt"
	"net/http"
	"strings"
)

const agentUsage = `Usage:
  ocx agent [status] [--json]
  ocx agent injection <status|set> [--model <id|->] [--effort <level|->]
      [--prompt <text|->] [--guidance <on|off>] [--json]
  ocx agent effort <status|set> [--main <level|->] [--subagent <level|->] [--json]
  ocx agent subagents <status|set|clear> [model,model...] [--json]
  ocx agent fallback <status|set|clear> [model,model...] [--poll-ms <5000-600000>] [--json]
  ocx agent sidecar <status|web|vision> [--model <id|->] [--backend <openai|anthropic|->]
      [--reasoning <level>] [--max-descriptions <n>] [--json]`

// clearableOption reads an option where `-` means "clear this value".
//
// The three return values distinguish the states the body builder needs:
// absent (leave the field out entirely), cleared (send an explicit null), and
// set. Collapsing absent and cleared would make every PUT overwrite fields the
// user never mentioned.
func clearableOption(args *[]string, flag string) (value any, present bool, err error) {
	raw, ok, err := takeOption(args, flag)
	if err != nil || !ok {
		return nil, false, err
	}
	if raw == "-" {
		return nil, true, nil
	}
	return raw, true, nil
}

func runAgent(ctx context.Context, args []string, streams IO) error {
	return agentDispatch(ctx, runtimeAPI{}, args, streams)
}

// agentDispatch is the seam a test drives with an injected client.
func agentDispatch(ctx context.Context, api runtimeAPI, args []string, streams IO) error {
	rest := append([]string{}, args...)
	section := "status"
	if len(rest) > 0 {
		section, rest = rest[0], rest[1:]
	}
	switch section {
	case "status":
		return agentStatus(ctx, api, rest, streams)
	case "injection", "guidance":
		return agentInjection(ctx, api, rest, streams)
	case "effort":
		return agentEffort(ctx, api, rest, streams)
	case "subagents", "roster":
		return agentSubagents(ctx, api, rest, streams)
	case "fallback":
		return agentFallback(ctx, api, rest, streams)
	case "sidecar":
		return agentSidecar(ctx, api, rest, streams)
	}
	return usageError(agentUsage, "unknown agent command %s", section)
}

// agentSection splits the leading action word from the remaining flags.
func agentSection(args []string) (action string, rest []string) {
	action = "status"
	rest = args
	if len(rest) > 0 {
		action, rest = strings.ToLower(rest[0]), rest[1:]
	}
	return action, rest
}

// agentGet is the shared read path: every section's status is one GET rendered
// through the same summary formatter.
func agentGet(ctx context.Context, api runtimeAPI, path string, args []string, streams IO) error {
	wantsJSON := takeFlag(&args, "--json")
	if err := rejectArgs(args, agentUsage, false); err != nil {
		return err
	}
	result, err := api.request(ctx, http.MethodGet, path, nil)
	if err != nil {
		return err
	}
	return printData(streams, result, wantsJSON, summaryLines(result))
}

func agentPut(ctx context.Context, api runtimeAPI, path string, body map[string]any, wantsJSON bool, line string, streams IO) error {
	result, err := api.request(ctx, http.MethodPut, path, body)
	if err != nil {
		return err
	}
	return printData(streams, result, wantsJSON, []string{line})
}

func agentStatus(ctx context.Context, api runtimeAPI, args []string, streams IO) error {
	wantsJSON := takeFlag(&args, "--json")
	if err := rejectArgs(args, agentUsage, false); err != nil {
		return err
	}
	// The oracle fetches all six surfaces and reports them as one object, so a
	// single command answers "how is the agent configured right now".
	sections := []struct {
		key  string
		path string
	}{
		{"v2", "/api/v2"},
		{"injection", "/api/injection-model"},
		{"caps", "/api/effort-caps"},
		{"subagents", "/api/subagent-models"},
		{"fallback", "/api/subagent-model-fallback"},
		{"sidecars", "/api/sidecar-settings"},
	}
	result := map[string]any{}
	for _, section := range sections {
		value, err := api.request(ctx, http.MethodGet, section.path, nil)
		if err != nil {
			return err
		}
		result[section.key] = value
	}
	return printData(streams, result, wantsJSON, summaryLines(result))
}

func agentInjection(ctx context.Context, api runtimeAPI, args []string, streams IO) error {
	action, rest := agentSection(args)
	if action == "status" {
		return agentGet(ctx, api, "/api/injection-model", rest, streams)
	}
	if action != "set" {
		return usageError(agentUsage, "unknown injection action %s", action)
	}
	wantsJSON := takeFlag(&rest, "--json")
	body := map[string]any{}
	for _, option := range []struct {
		flag  string
		field string
	}{
		{"--model", "model"},
		{"--effort", "effort"},
		{"--prompt", "prompt"},
	} {
		value, present, err := clearableOption(&rest, option.flag)
		if err != nil {
			return err
		}
		if present {
			body[option.field] = value
		}
	}
	guidance, hasGuidance, err := takeBooleanOption(&rest, "--guidance")
	if err != nil {
		return err
	}
	if hasGuidance {
		body["multiAgentGuidanceEnabled"] = guidance
	}
	if err := rejectArgs(rest, agentUsage, false); err != nil {
		return err
	}
	if len(body) == 0 {
		return usageError(agentUsage, "at least one injection option is required")
	}
	return agentPut(ctx, api, "/api/injection-model", body, wantsJSON, "Agent injection settings updated.", streams)
}

func agentEffort(ctx context.Context, api runtimeAPI, args []string, streams IO) error {
	action, rest := agentSection(args)
	if action == "status" {
		return agentGet(ctx, api, "/api/effort-caps", rest, streams)
	}
	if action != "set" {
		return usageError(agentUsage, "unknown effort action %s", action)
	}
	wantsJSON := takeFlag(&rest, "--json")
	body := map[string]any{}
	for _, option := range []struct {
		flag  string
		field string
	}{
		{"--main", "effortCap"},
		{"--subagent", "subagentEffortCap"},
	} {
		value, present, err := clearableOption(&rest, option.flag)
		if err != nil {
			return err
		}
		if present {
			body[option.field] = value
		}
	}
	if err := rejectArgs(rest, agentUsage, false); err != nil {
		return err
	}
	if len(body) == 0 {
		return usageError(agentUsage, "--main and/or --subagent is required")
	}
	return agentPut(ctx, api, "/api/effort-caps", body, wantsJSON, "Agent effort caps updated.", streams)
}

func agentSubagents(ctx context.Context, api runtimeAPI, args []string, streams IO) error {
	action, rest := agentSection(args)
	if action == "status" {
		return agentGet(ctx, api, "/api/subagent-models", rest, streams)
	}
	wantsJSON := takeFlag(&rest, "--json")
	models := []string{}
	switch action {
	case "clear":
	case "set":
		// The oracle shifts this positional unconditionally, so a leading flag
		// becomes the roster string and fails as an unexpected argument later.
		if len(rest) == 0 {
			return usageError(agentUsage, "comma-separated subagent models are required")
		}
		models = csvValues(rest[0])
		rest = rest[1:]
	default:
		return usageError(agentUsage, "unknown subagents action %s", action)
	}
	if err := rejectArgs(rest, agentUsage, false); err != nil {
		return err
	}
	if len(models) > 5 {
		return usageError(agentUsage, "at most 5 subagent models are allowed")
	}
	summary := strings.Join(models, ", ")
	if summary == "" {
		summary = "cleared"
	}
	return agentPut(ctx, api, "/api/subagent-models", map[string]any{"models": models},
		wantsJSON, "Subagent roster: "+summary, streams)
}

func agentFallback(ctx context.Context, api runtimeAPI, args []string, streams IO) error {
	action, rest := agentSection(args)
	if action == "status" {
		return agentGet(ctx, api, "/api/subagent-model-fallback", rest, streams)
	}
	wantsJSON := takeFlag(&rest, "--json")
	body := map[string]any{}
	switch action {
	case "clear":
		body["models"] = []string{}
	case "set":
		// The model list is optional here, unlike `subagents set`: this section
		// also owns --poll-ms, so `fallback set --poll-ms N` is a valid call
		// that touches only the interval.
		if len(rest) > 0 && !strings.HasPrefix(rest[0], "--") {
			body["models"] = csvValues(rest[0])
			rest = rest[1:]
		}
	default:
		return usageError(agentUsage, "unknown fallback action %s", action)
	}
	minimumPoll := 5_000
	pollMs, hasPoll, err := takeIntegerOption(&rest, "--poll-ms", &minimumPoll)
	if err != nil {
		return err
	}
	if hasPoll {
		if pollMs > 600_000 {
			return usageError(agentUsage, "--poll-ms must be <= 600000")
		}
		body["pollMs"] = pollMs
	}
	if err := rejectArgs(rest, agentUsage, false); err != nil {
		return err
	}
	if len(body) == 0 {
		return usageError(agentUsage, "models and/or --poll-ms is required")
	}
	return agentPut(ctx, api, "/api/subagent-model-fallback", body, wantsJSON, "Subagent fallback settings updated.", streams)
}

func agentSidecar(ctx context.Context, api runtimeAPI, args []string, streams IO) error {
	section, rest := agentSection(args)
	if section == "status" {
		return agentGet(ctx, api, "/api/sidecar-settings", rest, streams)
	}
	if section != "web" && section != "vision" {
		return usageError(agentUsage, "sidecar must be web, vision, or status")
	}
	wantsJSON := takeFlag(&rest, "--json")
	settings := map[string]any{}
	// --model clears to "" and --backend to null: the API distinguishes "no
	// model chosen" from "no backend pinned", so they are not interchangeable.
	model, hasModel, err := takeOption(&rest, "--model")
	if err != nil {
		return err
	}
	if hasModel {
		if model == "-" {
			settings["model"] = ""
		} else {
			settings["model"] = model
		}
	}
	backend, hasBackend, err := takeOption(&rest, "--backend")
	if err != nil {
		return err
	}
	if hasBackend {
		if backend == "-" {
			settings["backend"] = nil
		} else {
			settings["backend"] = backend
		}
	}
	reasoning, hasReasoning, err := takeOption(&rest, "--reasoning")
	if err != nil {
		return err
	}
	if hasReasoning {
		settings["reasoning"] = reasoning
	}
	minimumDescriptions := 1
	maxDescriptions, hasMax, err := takeIntegerOption(&rest, "--max-descriptions", &minimumDescriptions)
	if err != nil {
		return err
	}
	if hasMax {
		settings["maxDescriptionsPerTurn"] = maxDescriptions
	}
	if err := rejectArgs(rest, agentUsage, false); err != nil {
		return err
	}
	if len(settings) == 0 {
		return usageError(agentUsage, "at least one sidecar option is required")
	}
	field := "vision"
	if section == "web" {
		field = "webSearch"
	}
	return agentPut(ctx, api, "/api/sidecar-settings", map[string]any{field: settings},
		wantsJSON, fmt.Sprintf("%s sidecar settings updated.", section), streams)
}
