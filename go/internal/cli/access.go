package cli

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"strings"
)

const accessUsage = `Usage:
  ocx access key [list] [--json]
  ocx access key create [name] [--json]
  ocx access key remove <id> --yes [--json]
  ocx access endpoints [--json]
  ocx access models [--json]
  ocx access test <model> [--protocol <chat|responses|messages>] [--json]`

func runAccess(ctx context.Context, args []string, streams IO) error {
	return accessDispatch(ctx, newRuntimeAPI(), args, streams)
}

// runAccessKey backs the `api-key` alias, which the oracle routes straight
// into `access key`.
func runAccessKey(ctx context.Context, args []string, streams IO) error {
	return runAccessKeyWith(ctx, newRuntimeAPI(), args, streams)
}

func runAccessKeyWith(ctx context.Context, api runtimeAPI, args []string, streams IO) error {
	return accessDispatch(ctx, api, append([]string{"key"}, args...), streams)
}

// accessDispatch is the seam a test drives with an injected client.
func accessDispatch(ctx context.Context, api runtimeAPI, args []string, streams IO) error {
	rest := append([]string{}, args...)
	section := "key"
	if len(rest) > 0 {
		section, rest = strings.ToLower(rest[0]), rest[1:]
	}
	switch section {
	case "key", "keys":
		return accessKey(ctx, api, rest, streams)
	case "endpoints":
		return accessEndpoints(ctx, api, rest, streams)
	case "models":
		return accessModels(ctx, api, rest, streams)
	case "test":
		return accessTest(ctx, api, rest, streams)
	}
	return usageError(accessUsage, "unknown access command %s", section)
}

func accessKey(ctx context.Context, api runtimeAPI, args []string, streams IO) error {
	rest := append([]string{}, args...)
	action := "list"
	if len(rest) > 0 {
		action, rest = strings.ToLower(rest[0]), rest[1:]
	}
	wantsJSON := takeFlag(&rest, "--json")

	switch action {
	case "list":
		if err := rejectArgs(rest, accessUsage, false); err != nil {
			return err
		}
		result, err := api.request(ctx, http.MethodGet, "/api/keys", nil)
		if err != nil {
			return err
		}
		lines := []string{"No API access keys configured."}
		if rows := recordSlice(result, "keys"); len(rows) > 0 {
			lines = lines[:0]
			for _, row := range rows {
				lines = append(lines, fmt.Sprintf("%s  %s  %s",
					scalarField(row, "id"), scalarField(row, "name"), scalarField(row, "prefix")))
			}
		}
		return printData(streams, result, wantsJSON, lines)

	case "create":
		name := "default"
		if len(rest) > 0 {
			name, rest = rest[0], rest[1:]
		}
		if err := rejectArgs(rest, accessUsage, false); err != nil {
			return err
		}
		result, raw, err := api.requestWithRaw(ctx, http.MethodPost, "/api/keys", map[string]any{"name": name})
		if err != nil {
			return err
		}
		// --json prints the payload verbatim, so it must keep the server's key
		// order (id, name, key, createdAt) rather than a Go map's sorted one.
		payload := orderedPayload(raw, result)
		created := name
		if reported := scalarField(asRecord(result), "name"); reported != "" {
			created = reported
		}
		// The plaintext key is returned ONCE. It goes to stdout and nowhere
		// else: not into an error, not into a log, not into a retry message.
		return printData(streams, payload, wantsJSON, []string{
			fmt.Sprintf("Created API key %s (%s).", created, scalarField(asRecord(result), "id")),
			fmt.Sprintf("Key (shown once): %s", scalarField(asRecord(result), "key")),
		})

	case "remove", "delete":
		// The positional is taken BEFORE --yes, matching the oracle: that is
		// why `remove --yes` reports the missing confirmation rather than the
		// missing id.
		id := ""
		if len(rest) > 0 {
			id, rest = rest[0], rest[1:]
		}
		yes := takeFlag(&rest, "--yes")
		if id == "" {
			return usageError(accessUsage, "key id is required")
		}
		if !yes {
			return usageError(accessUsage, "remove requires --yes")
		}
		if err := rejectArgs(rest, accessUsage, false); err != nil {
			return err
		}
		result, err := api.request(ctx, http.MethodDelete, "/api/keys", map[string]any{"id": id})
		if err != nil {
			return err
		}
		return printData(streams, result, wantsJSON, []string{fmt.Sprintf("Removed API key %s.", id)})
	}
	return usageError(accessUsage, "unknown key command %s", action)
}

// accessEndpoints reports only the addressing fields of the keys payload, so
// the key material in the same response never reaches the terminal.
func accessEndpoints(ctx context.Context, api runtimeAPI, args []string, streams IO) error {
	rest := append([]string{}, args...)
	wantsJSON := takeFlag(&rest, "--json")
	if err := rejectArgs(rest, accessUsage, false); err != nil {
		return err
	}
	result, raw, err := api.requestWithRaw(ctx, http.MethodGet, "/api/keys", nil)
	if err != nil {
		return err
	}
	// Key ORDER matters: the oracle rebuilds the view with Object.fromEntries
	// over Object.entries, which preserves the server's order, and --json
	// prints it. A Go map would re-sort it.
	pairs := [][2]any{}
	lines := []string{}
	for _, name := range orderedKeysOf(raw, result) {
		if !strings.HasSuffix(name, "Endpoint") && name != "baseUrl" && name != "endpoint" {
			continue
		}
		value := asRecord(result)[name]
		pairs = append(pairs, [2]any{name, value})
		lines = append(lines, fmt.Sprintf("%s: %s", name, scalarText(value)))
	}
	view, err := orderedObject(pairs)
	if err != nil {
		return err
	}
	return printData(streams, view, wantsJSON, lines)
}

func accessModels(ctx context.Context, api runtimeAPI, args []string, streams IO) error {
	rest := append([]string{}, args...)
	wantsJSON := takeFlag(&rest, "--json")
	if err := rejectArgs(rest, accessUsage, false); err != nil {
		return err
	}
	result, err := api.request(ctx, http.MethodGet, "/v1/models", nil)
	if err != nil {
		return err
	}
	lines := []string{}
	for _, row := range recordSlice(result, "data") {
		// TrimRight, not TrimSpace: the oracle only drops the trailing
		// separator when owned_by is absent.
		lines = append(lines, strings.TrimRight(
			fmt.Sprintf("%s  %s", scalarField(row, "id"), scalarField(row, "owned_by")), " "))
	}
	return printData(streams, result, wantsJSON, lines)
}

func accessTest(ctx context.Context, api runtimeAPI, args []string, streams IO) error {
	rest := append([]string{}, args...)
	// The oracle shifts the first token UNCONDITIONALLY, before parsing any
	// flag. `access test --protocol chat m` therefore takes "--protocol" as
	// the model and rejects the leftovers, rather than reading the flag.
	// Skipping `--`-prefixed tokens here would silently accept an invocation
	// the TypeScript CLI refuses.
	model := ""
	if len(rest) > 0 {
		model, rest = rest[0], rest[1:]
	}
	wantsJSON := takeFlag(&rest, "--json")
	protocol, hasProtocol, err := takeOption(&rest, "--protocol")
	if err != nil {
		return err
	}
	if !hasProtocol {
		protocol = "chat"
	}
	if model == "" {
		return usageError(accessUsage, "model is required")
	}
	if protocol != "chat" && protocol != "responses" && protocol != "messages" {
		return usageError(accessUsage, "--protocol must be chat, responses, or messages")
	}
	if err := rejectArgs(rest, accessUsage, false); err != nil {
		return err
	}

	path := "/v1/chat/completions"
	var body map[string]any
	switch protocol {
	case "responses":
		path = "/v1/responses"
		body = map[string]any{"model": model, "input": "Reply with OK.", "max_output_tokens": 16}
	case "messages":
		path = "/v1/messages"
		body = map[string]any{"model": model, "max_tokens": 16,
			"messages": []any{map[string]any{"role": "user", "content": "Reply with OK."}}}
	default:
		body = map[string]any{"model": model, "max_tokens": 16, "stream": false,
			"messages": []any{map[string]any{"role": "user", "content": "Reply with OK."}}}
	}
	result, err := api.request(ctx, http.MethodPost, path, body)
	if err != nil {
		return err
	}
	return printData(streams, result, wantsJSON,
		[]string{fmt.Sprintf("%s: %s request succeeded.", model, protocol)})
}

// asRecord narrows a decoded payload to an object, or nil.
func asRecord(value any) map[string]any {
	record, _ := value.(map[string]any)
	return record
}

// recordSlice returns the object rows of payload[key].
func recordSlice(value any, key string) []map[string]any {
	items, _ := asRecord(value)[key].([]any)
	rows := make([]map[string]any, 0, len(items))
	for _, item := range items {
		if row, ok := item.(map[string]any); ok {
			rows = append(rows, row)
		}
	}
	return rows
}

// scalarField renders one field the way String(value) would. An absent or null
// field becomes "" rather than the "-" placeholder used for settings, because
// a log or key row may legitimately be missing a column.
func scalarField(row map[string]any, key string) string {
	value, present := row[key]
	if !present || value == nil {
		return ""
	}
	return scalarText(value)
}

// orderedKeysOf recovers the server's key order from the raw bytes, falling
// back to sorted keys when the payload is not a plain object.
func orderedKeysOf(raw []byte, decoded any) []string {
	if value, err := decodeOrdered(raw); err == nil && value.kind == 'o' {
		return value.keys
	}
	keys := make([]string, 0, len(asRecord(decoded)))
	for key := range asRecord(decoded) {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
