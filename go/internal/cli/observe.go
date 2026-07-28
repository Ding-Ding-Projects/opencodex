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
	return observeDispatch(ctx, newRuntimeAPI(), args, streams)
}

// The four top-level aliases the oracle dispatches straight into observe
// sections (src/cli/index.ts:1000). They are registered as hidden commands so
// they resolve without appearing twice in the root help, which is compared
// byte-for-byte against the TypeScript output.
// Each wrapper is a thin adapter over its *With twin so a test can drive the
// SAME function the registry calls. A test that reimplements the prepend
// proves only that prepending works, which is not the thing that can break:
// what breaks is a wrapper naming the wrong section.
func runObserveLogs(ctx context.Context, args []string, streams IO) error {
	return runObserveLogsWith(ctx, newRuntimeAPI(), args, streams)
}

func runObserveLogsWith(ctx context.Context, api runtimeAPI, args []string, streams IO) error {
	return observeAlias(ctx, api, "logs", args, streams)
}

func runObserveUsage(ctx context.Context, args []string, streams IO) error {
	return runObserveUsageWith(ctx, newRuntimeAPI(), args, streams)
}

func runObserveUsageWith(ctx context.Context, api runtimeAPI, args []string, streams IO) error {
	return observeAlias(ctx, api, "usage", args, streams)
}

func runObserveStorage(ctx context.Context, args []string, streams IO) error {
	return runObserveStorageWith(ctx, newRuntimeAPI(), args, streams)
}

func runObserveStorageWith(ctx context.Context, api runtimeAPI, args []string, streams IO) error {
	return observeAlias(ctx, api, "storage", args, streams)
}

func runObserveMemory(ctx context.Context, args []string, streams IO) error {
	return runObserveMemoryWith(ctx, newRuntimeAPI(), args, streams)
}

func runObserveMemoryWith(ctx context.Context, api runtimeAPI, args []string, streams IO) error {
	return observeAlias(ctx, api, "memory", args, streams)
}

// observeAlias prepends the section an alias stands for and forwards the rest
// unchanged.
func observeAlias(ctx context.Context, api runtimeAPI, section string, args []string, streams IO) error {
	return observeDispatch(ctx, api, append([]string{section}, args...), streams)
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

// queryParam is one entry of a query string. Presence is tracked separately
// from the value because they mean different things: the oracle calls
// search.set for every DEFINED option, so `--provider ""` serializes as
// `provider=` and actually filters, while an omitted option is absent from the
// URI entirely. Collapsing the two would silently turn a deliberate
// empty-string filter into no filter at all.
type queryParam struct {
	key     string
	value   string
	present bool
}

// observeQuery builds a query string, omitting absent parameters and
// preserving the caller's key order the way URLSearchParams does.
func observeQuery(params []queryParam) string {
	parts := []string{}
	for _, param := range params {
		if !param.present {
			continue
		}
		parts = append(parts, formURLEncode(param.key)+"="+formURLEncode(param.value))
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

// logRows returns every entry of the log array, not only the objects.
//
// The oracle iterates the parsed array directly, so a malformed payload like
// [1, {...}] prints BOTH rows. Filtering to objects here would silently drop
// the number and, worse, shift the pairing against the ordered row list.
func logRows(data any) []any {
	if items, ok := data.([]any); ok {
		return items
	}
	if record, ok := data.(map[string]any); ok {
		for _, key := range []string{"logs", "entries", "requests"} {
			if items, ok := record[key].([]any); ok {
				return items
			}
		}
	}
	return nil
}

// rowObject narrows an entry for the field-reading helpers; a non-object row
// still prints, it simply has no fields to read.
func rowObject(row any) map[string]any {
	if object, ok := row.(map[string]any); ok {
		return object
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

func formatLog(entry any) string {
	row := rowObject(entry)
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
func logKey(entry any) string {
	row := rowObject(entry)
	// A primitive row has no properties, so every field reads as undefined and
	// the oracle's template literal collapses them all to one key. Reproducing
	// the exact text keeps follow-mode de-duplication identical. A nil row never
	// reaches here: the caller stops on it, the way the oracle throws.
	if row == nil {
		return "undefined:undefined:undefined:undefined"
	}
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
	provider, hasProvider, err := takeOption(&args, "--provider")
	if err != nil {
		return err
	}
	model, hasModel, err := takeOption(&args, "--model")
	if err != nil {
		return err
	}
	status, hasStatus, err := takeOption(&args, "--status")
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

	path := "/api/logs" + observeQuery([]queryParam{
		{key: "provider", value: provider, present: hasProvider},
		{key: "model", value: model, present: hasModel},
		{key: "status", value: status, present: hasStatus},
		// limit always has a value: the oracle defaults it to 200 and sends it.
		{key: "limit", value: strconv.Itoa(limit), present: true},
	})
	seen := map[string]struct{}{}
	// order preserves arrival sequence so the trim below can keep the most
	// recent keys instead of an arbitrary map subset.
	order := []string{}
	for round := 0; ; round++ {
		data, raw, err := api.requestWithRaw(ctx, http.MethodGet, path, nil)
		if err != nil {
			return err
		}
		rawRows := orderedLogRows(raw)
		if !follow && wantsJSON {
			if err := printData(streams, data, true, nil); err != nil {
				return err
			}
		} else {
			for rowIndex, row := range logRows(data) {
				// The oracle computes this key by reading row.id BEFORE it
				// prints, so a null entry throws a TypeError there: the rows
				// before it are already on screen, the null row never prints,
				// and the command exits non-zero. A Go nil row reproduces that
				// boundary rather than quietly rendering something the oracle
				// would never show.
				if row == nil {
					return fmt.Errorf("null is not an object (evaluating 'row.id')")
				}
				key := logKey(row)
				if follow {
					if _, already := seen[key]; already {
						continue
					}
				}
				line := formatLog(row)
				if wantsJSONL {
					// Re-marshalling the decoded map would sort the keys; the
					// oracle's JSON.stringify preserves the order it parsed.
					if rowIndex < len(rawRows) {
						line = rawRows[rowIndex]
					} else {
						encoded, marshalErr := json.Marshal(row)
						if marshalErr != nil {
							return marshalErr
						}
						line = string(encoded)
					}
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
		"/api/usage"+observeQuery([]queryParam{
			{key: "range", value: rangeValue, present: true},
			{key: "surface", value: surface, present: true},
		}), nil)
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
		query = observeQuery([]queryParam{{key: "limit", value: strconv.Itoa(limit), present: true}})
	}
	result, err := api.request(ctx, http.MethodGet, path+query, nil)
	if err != nil {
		return err
	}
	return printData(streams, result, wantsJSON, summaryLines(result))
}

// orderedLogRows re-serializes each OBJECT row with its original key order.
//
// It applies the same object-only filter as logRows, so index N here is the
// same row as index N there; a payload like [1, {...}] would otherwise pair the
// object with the number's bytes. Rows are re-serialized rather than copied
// verbatim, because the oracle prints JSON.stringify output, which normalizes
// whitespace and escape spelling.
func orderedLogRows(raw []byte) []string {
	value, err := decodeOrdered(raw)
	if err != nil {
		return nil
	}
	items := value.values
	if !value.present || (value.kind != 'a' && value.kind != 'o') {
		return nil
	}
	if value.kind == 'o' {
		items = nil
		for index, key := range value.keys {
			if key != "logs" && key != "entries" && key != "requests" {
				continue
			}
			if value.values[index].kind == 'a' {
				items = value.values[index].values
				break
			}
		}
	}
	out := []string{}
	for _, item := range items {
		// Every entry is kept: logRows no longer filters, so index N here must
		// stay the same row as index N there.
		encoded, marshalErr := item.MarshalJSON()
		if marshalErr != nil {
			return nil
		}
		out = append(out, string(encoded))
	}
	return out
}
