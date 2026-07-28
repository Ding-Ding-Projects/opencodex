package cli

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"strings"
)

const comboUsage = `Usage:
  ocx combo [list] [--json]
  ocx combo show <id> [--json]
  ocx combo set <id> --targets <provider/model[:weight],...>
      [--strategy <failover|round-robin>] [--sticky <1-100>]
      [--effort <low|medium|high|xhigh|max|ultra|->] [--alias <name|->]
      [--rename-from <id>] [--json]
  ocx combo remove <id> --yes [--json]`

type comboTarget struct {
	Provider string `json:"provider"`
	Model    string `json:"model"`
	Weight   *int   `json:"weight,omitempty"`
}

// parseComboTargets reads `provider/model[:weight]` entries.
//
// The weight colon is only the LAST colon that appears after the provider
// slash. Model identifiers legitimately contain colons, so a naive split turns
// `openai/gpt:preview` into a weightless parse error instead of a model name.
func parseComboTargets(raw string) ([]comboTarget, error) {
	targets := []comboTarget{}
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		selector := part
		var weight *int
		if colon := strings.LastIndex(part, ":"); colon > strings.Index(part, "/") && colon != -1 {
			// Range-check while the value is still float64. Converting first
			// cannot round-trip a huge value like 1e30, so the digits would
			// silently stay in the model name and a bogus target would ship
			// instead of being rejected.
			if parsed, valid := jsNumber(part[colon+1:]); valid && !math.IsInf(parsed, 0) && !math.IsNaN(parsed) && parsed == math.Trunc(parsed) {
				selector = part[:colon]
				if parsed < 1 || parsed > 10_000 {
					return nil, usageError(comboUsage, "target weight must be 1-10000: %s", part)
				}
				value := int(parsed)
				weight = &value
			}
		}
		slash := strings.Index(selector, "/")
		if slash <= 0 || slash == len(selector)-1 {
			return nil, usageError(comboUsage, "invalid target %q; use provider/model[:weight]", part)
		}
		targets = append(targets, comboTarget{Provider: selector[:slash], Model: selector[slash+1:], Weight: weight})
	}
	if len(targets) == 0 {
		return nil, usageError(comboUsage, "--targets requires at least one provider/model")
	}
	return targets, nil
}

func comboRows(result any) []map[string]any {
	record, ok := result.(map[string]any)
	if !ok {
		return nil
	}
	raw, ok := record["combos"].([]any)
	if !ok {
		return nil
	}
	rows := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		if row, ok := item.(map[string]any); ok {
			rows = append(rows, row)
		}
	}
	return rows
}

func runCombo(ctx context.Context, args []string, streams IO) error {
	return comboDispatch(ctx, runtimeAPI{}, args, streams)
}

// comboDispatch is the seam a test drives with an injected client.
func comboDispatch(ctx context.Context, api runtimeAPI, args []string, streams IO) error {
	rest := append([]string{}, args...)
	action := "list"
	if len(rest) > 0 {
		action, rest = rest[0], rest[1:]
	}
	switch action {
	case "list":
		return comboList(ctx, api, rest, streams)
	case "show":
		return comboShow(ctx, api, rest, streams)
	case "set", "create", "update":
		return comboSet(ctx, api, rest, streams)
	case "remove", "delete":
		return comboRemove(ctx, api, rest, streams)
	}
	return usageError(comboUsage, "unknown combo command %s", action)
}

func comboList(ctx context.Context, api runtimeAPI, args []string, streams IO) error {
	wantsJSON := takeFlag(&args, "--json")
	if err := rejectArgs(args, comboUsage, false); err != nil {
		return err
	}
	result, err := api.request(ctx, http.MethodGet, "/api/combos", nil)
	if err != nil {
		return err
	}
	rows := comboRows(result)
	lines := []string{"No combos configured."}
	if len(rows) > 0 {
		lines = lines[:0]
		for _, row := range rows {
			id := scalarText(row["id"])
			model := scalarText(row["model"])
			if model == "-" {
				model = "combo/" + id
			}
			lines = append(lines, fmt.Sprintf("%s  %s", id, model))
		}
	}
	return printData(streams, result, wantsJSON, lines)
}

func comboShow(ctx context.Context, api runtimeAPI, args []string, streams IO) error {
	if len(args) == 0 {
		return usageError(comboUsage, "combo id is required")
	}
	id := args[0]
	args = args[1:]
	wantsJSON := takeFlag(&args, "--json")
	if err := rejectArgs(args, comboUsage, false); err != nil {
		return err
	}
	result, err := api.request(ctx, http.MethodGet, "/api/combos", nil)
	if err != nil {
		return err
	}
	for _, row := range comboRows(result) {
		if scalarText(row["id"]) == id {
			return printData(streams, row, wantsJSON, summaryLines(row))
		}
	}
	return usageError(comboUsage, "unknown combo %s", id)
}

func comboSet(ctx context.Context, api runtimeAPI, args []string, streams IO) error {
	if len(args) == 0 {
		return usageError(comboUsage, "combo id is required")
	}
	id := strings.TrimSpace(args[0])
	args = args[1:]
	wantsJSON := takeFlag(&args, "--json")
	if id == "" {
		return usageError(comboUsage, "combo id is required")
	}
	targetsRaw, hasTargets, err := takeOption(&args, "--targets")
	if err != nil {
		return err
	}
	if !hasTargets {
		return usageError(comboUsage, "--targets is required")
	}
	strategy, hasStrategy, err := takeOption(&args, "--strategy")
	if err != nil {
		return err
	}
	if !hasStrategy {
		strategy = "failover"
	}
	if strategy != "failover" && strategy != "round-robin" {
		return usageError(comboUsage, "--strategy must be failover or round-robin")
	}
	minimumSticky := 1
	stickyLimit, hasSticky, err := takeIntegerOption(&args, "--sticky", &minimumSticky)
	if err != nil {
		return err
	}
	if !hasSticky {
		stickyLimit = 1
	}
	if stickyLimit > 100 {
		return usageError(comboUsage, "--sticky must be <= 100")
	}
	effort, hasEffort, err := takeOption(&args, "--effort")
	if err != nil {
		return err
	}
	alias, hasAlias, err := takeOption(&args, "--alias")
	if err != nil {
		return err
	}
	renameFrom, hasRename, err := takeOption(&args, "--rename-from")
	if err != nil {
		return err
	}
	if err := rejectArgs(args, comboUsage, false); err != nil {
		return err
	}
	targets, err := parseComboTargets(targetsRaw)
	if err != nil {
		return err
	}

	combo := map[string]any{"strategy": strategy, "stickyLimit": stickyLimit, "targets": targets}
	// `-` clears a value. The two fields clear to different zero values because
	// the API distinguishes "no effort pinned" (null) from "no alias" ("").
	if hasEffort {
		if effort == "-" {
			combo["defaultEffort"] = nil
		} else {
			combo["defaultEffort"] = effort
		}
	}
	if hasAlias {
		if alias == "-" {
			combo["alias"] = ""
		} else {
			combo["alias"] = alias
		}
	}
	payload := map[string]any{"id": id, "combo": combo}
	if hasRename && renameFrom != "" {
		payload["renameFrom"] = renameFrom
	}
	result, err := api.request(ctx, http.MethodPut, "/api/combos", payload)
	if err != nil {
		return err
	}
	return printData(streams, result, wantsJSON, []string{fmt.Sprintf("Saved combo %s.", id)})
}

func comboRemove(ctx context.Context, api runtimeAPI, args []string, streams IO) error {
	if len(args) == 0 {
		return usageError(comboUsage, "combo id is required")
	}
	id := strings.TrimSpace(args[0])
	args = args[1:]
	wantsJSON := takeFlag(&args, "--json")
	confirmed := takeFlag(&args, "--yes")
	if id == "" {
		return usageError(comboUsage, "combo id is required")
	}
	if !confirmed {
		return usageError(comboUsage, "remove requires --yes")
	}
	if err := rejectArgs(args, comboUsage, false); err != nil {
		return err
	}
	result, err := api.request(ctx, http.MethodDelete, "/api/combos?id="+url.QueryEscape(id), nil)
	if err != nil {
		return err
	}
	return printData(streams, result, wantsJSON, []string{fmt.Sprintf("Removed combo %s.", id)})
}

const routeUsage = `Usage:
  ocx route combo [subcommand] [options]`

// runRoute is the `ocx route combo ...` wrapper. It accepts nothing else, so a
// mistyped surface fails loudly instead of silently doing combo work.
func runRoute(ctx context.Context, args []string, streams IO) error {
	if len(args) == 0 || args[0] != "combo" {
		return usageError(routeUsage, "route requires the combo subcommand")
	}
	return runCombo(ctx, args[1:], streams)
}
