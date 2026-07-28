package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const observeUsage = `Usage:
  ocx observe logs [--provider <name>] [--model <id>] [--status <code>]
      [--limit <n>] [--follow] [--json|--jsonl]
  ocx observe usage [--range <7d|30d|all>] [--surface <all|codex|claude|grok>] [--json]
  ocx observe storage [--json]
  ocx observe memory [--json]
  ocx observe debug [--json]
  ocx observe claude-inbound [--limit <n>] [--json]
  ocx observe injection [--limit <n>] [--json]`

// observeSleep is the follow-loop delay, injectable so a test can drive several
// polls without waiting real seconds.
var observeSleep = func(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// observeFollowRounds bounds the follow loop in tests. Zero means unbounded,
// which is the real command's behavior.
var observeFollowRounds = 0

func runObserve(ctx context.Context, args []string, streams IO) error {
	return observeDispatch(ctx, runtimeAPI{}, args, streams)
}

// The four top-level aliases the oracle dispatches straight into observe
// sections (src/cli/index.ts:1000). They are registered as hidden commands so
// they resolve without appearing twice in the root help, which is compared
// byte-for-byte against the TypeScript output.
func runObserveLogs(ctx context.Context, args []string, streams IO) error {
	return runObserve(ctx, append([]string{"logs"}, args...), streams)
}

func runObserveUsage(ctx context.Context, args []string, streams IO) error {
	return runObserve(ctx, append([]string{"usage"}, args...), streams)
}

func runObserveStorage(ctx context.Context, args []string, streams IO) error {
	return runObserve(ctx, append([]string{"storage"}, args...), streams)
}

func runObserveMemory(ctx context.Context, args []string, streams IO) error {
	return runObserve(ctx, append([]string{"memory"}, args...), streams)
}

// observeDispatch is the seam a test drives with an injected client.
func observeDispatch(ctx context.Context, api runtimeAPI, args []string, streams IO) error {
	rest := append([]string{}, args...)
	section := "logs"
	if len(rest) > 0 {
		section, rest = rest[0], rest[1:]
	}
	switch section {
	case "logs":
		return observeLogs(ctx, api, rest, streams)
	case "usage":
		return observeUsageSection(ctx, api, rest, streams)
	case "storage":
		return observeSimple(ctx, api, "/api/storage", rest, streams)
	case "memory":
		return observeSimple(ctx, api, "/api/system/memory", rest, streams)
	case "debug":
		return observeSimple(ctx, api, "/api/debug", rest, streams)
	case "claude-inbound":
		return observeSimple(ctx, api, "/api/claude/inbound-debug", rest, streams)
	case "injection":
		return observeSimple(ctx, api, "/api/debug/injection-logs", rest, streams)
	}
	return usageError(observeUsage, "unknown observe command %s", section)
}

// observeQuery builds a query string, omitting absent values and preserving the
// caller's key order the way URLSearchParams does.
func observeQuery(pairs [][2]string) string {
	parts := []string{}
	for _, pair := range pairs {
		if pair[1] == "" {
			continue
		}
		parts = append(parts, formURLEncode(pair[0])+"="+formURLEncode(pair[1]))
	}
	if len(parts) == 0 {
		return ""
	}
	return "?" + strings.Join(parts, "&")
}

// formURLEncode reproduces URLSearchParams' application/x-www-form-urlencoded
// serializer.
//
// url.QueryEscape is close but not the same set: it leaves `~` alone and
// escapes `*`, while the browser serializer does the reverse. Both parse back
// to the same value, so this only matters for byte-level parity with the
// oracle's request URI -- which is exactly what the differential test compares.
func formURLEncode(value string) string {
	const unreserved = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789*-._"
	var out strings.Builder
	for _, b := range []byte(value) {
		switch {
		case strings.IndexByte(unreserved, b) >= 0:
			out.WriteByte(b)
		case b == ' ':
			out.WriteByte('+')
		default:
			out.WriteString(fmt.Sprintf("%%%02X", b))
		}
	}
	return out.String()
}

func logRows(data any) []map[string]any {
	extract := func(items []any) []map[string]any {
		rows := make([]map[string]any, 0, len(items))
		for _, item := range items {
			if row, ok := item.(map[string]any); ok {
				rows = append(rows, row)
			}
		}
		return rows
	}
	if items, ok := data.([]any); ok {
		return extract(items)
	}
	if record, ok := data.(map[string]any); ok {
		for _, key := range []string{"logs", "entries", "requests"} {
			if items, ok := record[key].([]any); ok {
				return extract(items)
			}
		}
	}
	return nil
}

// firstText returns the first present, non-empty value among the keys.
//
// It deliberately does NOT reuse scalarText's "-" placeholder: that sentinel
// means "unset" when rendering a settings field, but a log row may legitimately
// contain the literal string "-", and the oracle prints it. Filtering it here
// would silently drop a real provider or model name.
func firstText(row map[string]any, keys ...string) string {
	for _, key := range keys {
		value, present := row[key]
		if !present || value == nil {
			continue
		}
		if text, ok := value.(string); ok {
			if text == "" {
				continue
			}
			return text
		}
		return scalarText(value)
	}
	return ""
}

func formatLog(row map[string]any) string {
	status := firstText(row, "status", "statusCode")
	if status == "" {
		status = "?"
	}
	route := []string{}
	for _, key := range []string{"provider", "model"} {
		if text := firstText(row, key); text != "" {
			route = append(route, text)
		}
	}
	duration := ""
	if text := firstText(row, "durationMs"); text != "" {
		duration = text + "ms"
	}
	parts := []string{}
	for _, field := range []string{firstText(row, "timestamp", "createdAt"), status, strings.Join(route, "/"), duration} {
		if field != "" {
			parts = append(parts, field)
		}
	}
	return strings.Join(parts, "  ")
}

// logKey identifies a row for follow-mode de-duplication.
func logKey(row map[string]any) string {
	if id := firstText(row, "id"); id != "" {
		return id
	}
	return strings.Join([]string{
		firstText(row, "timestamp"), firstText(row, "provider"),
		firstText(row, "model"), firstText(row, "status"),
	}, ":")
}

func observeLogs(ctx context.Context, api runtimeAPI, args []string, streams IO) error {
	wantsJSON := takeFlag(&args, "--json")
	wantsJSONL := takeFlag(&args, "--jsonl")
	follow := takeFlag(&args, "--follow")
	if takeFlag(&args, "-f") {
		follow = true
	}
	provider, _, err := takeOption(&args, "--provider")
	if err != nil {
		return err
	}
	model, _, err := takeOption(&args, "--model")
	if err != nil {
		return err
	}
	status, _, err := takeOption(&args, "--status")
	if err != nil {
		return err
	}
	minimumLimit := 1
	limit, hasLimit, err := takeIntegerOption(&args, "--limit", &minimumLimit)
	if err != nil {
		return err
	}
	if !hasLimit {
		limit = 200
	}
	if err := rejectArgs(args, observeUsage, false); err != nil {
		return err
	}
	// These two pairs are mutually exclusive for different reasons: only one
	// output shape can win, and follow streams line by line, so a single JSON
	// document could never be closed.
	if wantsJSON && wantsJSONL {
		return usageError(observeUsage, "--json and --jsonl cannot be combined")
	}
	if follow && wantsJSON {
		return usageError(observeUsage, "--follow uses --jsonl, not --json")
	}

	path := "/api/logs" + observeQuery([][2]string{
		{"provider", provider}, {"model", model},
		{"status", status}, {"limit", strconv.Itoa(limit)},
	})
	seen := map[string]struct{}{}
	// order preserves arrival sequence so the trim below can keep the most
	// recent keys instead of an arbitrary map subset.
	order := []string{}
	for round := 0; ; round++ {
		data, err := api.request(ctx, http.MethodGet, path, nil)
		if err != nil {
			return err
		}
		if !follow && wantsJSON {
			if err := printData(streams, data, true, nil); err != nil {
				return err
			}
		} else {
			for _, row := range logRows(data) {
				key := logKey(row)
				if follow {
					if _, already := seen[key]; already {
						continue
					}
				}
				line := formatLog(row)
				if wantsJSONL {
					encoded, marshalErr := json.Marshal(row)
					if marshalErr != nil {
						return marshalErr
					}
					line = string(encoded)
				}
				if _, err := fmt.Fprintln(streams.Out, line); err != nil {
					return err
				}
				if _, already := seen[key]; !already {
					seen[key] = struct{}{}
					order = append(order, key)
				}
			}
		}
		if !follow {
			return nil
		}
		// Bound the memory of a long-running follow. The oracle keeps the most
		// recent 2500 keys rather than clearing outright, and the difference is
		// user-visible: dropping everything makes the next poll reprint rows the
		// user already saw. Go maps have no insertion order, so arrival order is
		// tracked alongside the set.
		if len(order) > 5_000 {
			order = append([]string{}, order[len(order)-2_500:]...)
			seen = make(map[string]struct{}, len(order))
			for _, key := range order {
				seen[key] = struct{}{}
			}
		}
		if observeFollowRounds > 0 && round+1 >= observeFollowRounds {
			return nil
		}
		if err := observeSleep(ctx, time.Second); err != nil {
			return err
		}
	}
}

func observeUsageSection(ctx context.Context, api runtimeAPI, args []string, streams IO) error {
	wantsJSON := takeFlag(&args, "--json")
	rangeValue, hasRange, err := takeOption(&args, "--range")
	if err != nil {
		return err
	}
	if !hasRange {
		rangeValue = "30d"
	}
	surface, hasSurface, err := takeOption(&args, "--surface")
	if err != nil {
		return err
	}
	if !hasSurface {
		surface = "all"
	}
	switch rangeValue {
	case "7d", "30d", "all":
	default:
		return usageError(observeUsage, "--range must be 7d, 30d, or all")
	}
	switch surface {
	case "all", "codex", "claude", "grok":
	default:
		return usageError(observeUsage, "--surface must be all, codex, claude, or grok")
	}
	if err := rejectArgs(args, observeUsage, false); err != nil {
		return err
	}
	result, err := api.request(ctx, http.MethodGet,
		"/api/usage"+observeQuery([][2]string{{"range", rangeValue}, {"surface", surface}}), nil)
	if err != nil {
		return err
	}
	return printData(streams, result, wantsJSON, summaryLines(result))
}

func observeSimple(ctx context.Context, api runtimeAPI, path string, args []string, streams IO) error {
	wantsJSON := takeFlag(&args, "--json")
	minimumLimit := 1
	limit, hasLimit, err := takeIntegerOption(&args, "--limit", &minimumLimit)
	if err != nil {
		return err
	}
	if err := rejectArgs(args, observeUsage, false); err != nil {
		return err
	}
	query := ""
	if hasLimit {
		query = observeQuery([][2]string{{"limit", strconv.Itoa(limit)}})
	}
	result, err := api.request(ctx, http.MethodGet, path+query, nil)
	if err != nil {
		return err
	}
	return printData(streams, result, wantsJSON, summaryLines(result))
}
