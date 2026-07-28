package cli

import (
	"context"
	"fmt"
	"io"
	"math"
	"strings"
	"time"
)

// The Go port of src/cli/account-auth.ts: `account login`/`reauth`, `code`,
// `cancel`, and `reset-credits`.
//
// SECURITY BOUNDARY. Every path here handles a short-lived authorization code.
// The rules that follow are not stylistic:
//
//   - the code is never printed, echoed back, or included in an error message;
//   - a parse failure reports the ARGUMENT SHAPE, never the value;
//   - stdin is the preferred channel, because an argv value is in the shell
//     history and was visible to anyone who could run `ps` while it ran.

const accountAuthUsage = `Usage:
  ocx account login <provider> [--id <account-id>] [--reauth] [--code -] [--no-wait] [--json]
  ocx account code <provider> [--flow <flow-id>] [--json]   (reads the code from stdin)
  ocx account cancel <provider> [--flow <flow-id>] [--json]
  ocx account reset-credits <account-id|main> [--consume --yes] [--json]

The redirect URL or authorization code is a short-lived credential. Pipe it in
rather than passing it as an argument, where it lands in shell history and is
visible to anyone who can run ps:
  pbpaste | ocx account code <provider> --flow <flow-id>
  ocx account login <provider> --code -   (same, for the login flow)`

// codexNames are the providers whose login runs through the Codex auth routes
// rather than the generic provider OAuth ones.
var codexNames = map[string]bool{"openai": true, "codex": true, "chatgpt": true}

// stdinSentinel means "read it from stdin", the documented way to pass a code
// silently.
const stdinSentinel = "-"

const argvWarning = "warning: the authorization code was passed as a command-line argument, so it is now in your shell history and was visible in the process list while this ran. Pipe it on stdin instead, or pass `-` to read from stdin."

// codexLoginPollAttempts and providerLoginPollAttempts are DELIBERATELY
// different, matching the oracle. The Codex flow gets a longer budget because
// it can require a second interactive step upstream.
const (
	codexLoginPollAttempts    = 150
	providerLoginPollAttempts = 100
	loginPollInterval         = 2 * time.Second
)

// accountAuthDeps are the injection seams: the sleep so a test can exercise the
// poll budget without waiting minutes, and stdin so a code never has to be a
// real terminal.
type accountAuthDeps struct {
	sleep func(time.Duration)
	stdin io.Reader
}

func (deps accountAuthDeps) pause(duration time.Duration) {
	if deps.sleep != nil {
		deps.sleep(duration)
		return
	}
	time.Sleep(duration)
}

// resolveAuthCode resolves the code, preferring stdin.
//
// It never logs the value: the warning names the EXPOSURE, not the credential.
// What this closes is shell history, `ps`, and this program's own output; a
// code pasted at an interactive prompt is still visible on the terminal,
// exactly as it is in the existing interactive login.
func resolveAuthCode(supplied *suppliedOption, deps accountAuthDeps, required bool, streams IO) (string, error) {
	if supplied != nil && supplied.value != stdinSentinel {
		fmt.Fprintln(streams.Err, argvWarning)
		return supplied.value, nil
	}
	if supplied == nil && !required {
		return "", nil
	}
	input := deps.stdin
	if input == nil {
		input = streams.In
	}
	if isTerminal(input) {
		fmt.Fprintln(streams.Err, "Paste the redirect URL or authorization code, then press Enter:")
	}
	return readSecretLine(input, "authorization code")
}

type loginStart struct {
	URL          string `json:"url"`
	FlowID       string `json:"flowId"`
	Instructions string `json:"instructions"`
	DeviceCode   string `json:"deviceCode"`
	// raw is the response EXACTLY as decoded. `--no-wait --json` prints the
	// start payload verbatim, so re-serializing the struct would turn a string
	// or array response into `{}` and would add empty fields the server never
	// sent.
	raw any
}

// payload returns what `--json` must print: the original value, not a
// reconstruction of it.
func (s loginStart) payload() any { return s.raw }

func runAccountLogin(ctx context.Context, api runtimeAPI, argv []string, deps accountAuthDeps, streams IO) error {
	args := append([]string{}, argv...)
	provider := ""
	if len(args) > 0 {
		provider = strings.ToLower(strings.TrimSpace(args[0]))
		args = args[1:]
	}
	wantsJSON := takeFlag(&args, "--json")
	noWait := takeFlag(&args, "--no-wait")
	reauth := takeFlag(&args, "--reauth")
	id, _, err := takeOption(&args, "--id")
	if err != nil {
		return err
	}
	supplied, hasSupplied, err := takeOptionWithSyntax(&args, "--code")
	if err != nil {
		return err
	}
	if provider == "" {
		return usageError(accountAuthUsage, "provider is required")
	}
	if err := rejectArgs(args, accountAuthUsage, false); err != nil {
		return err
	}
	// Resolve ONLY when --code was actually given. A plain `ocx account login`
	// opens the browser flow and polls, so blocking on stdin here would hang
	// the ordinary path forever.
	var suppliedPtr *suppliedOption
	if hasSupplied {
		suppliedPtr = &supplied
	}
	code, err := resolveAuthCode(suppliedPtr, deps, false, streams)
	if err != nil {
		return err
	}

	if codexNames[provider] {
		return codexLogin(ctx, api, provider, id, code, reauth, noWait, wantsJSON, deps, streams)
	}
	if id != "" && !reauth {
		return usageError(accountAuthUsage, "--id is only valid with --reauth for provider OAuth accounts")
	}
	return providerLogin(ctx, api, provider, id, code, reauth, noWait, wantsJSON, deps, streams)
}

func codexLogin(ctx context.Context, api runtimeAPI, provider, id, code string, reauth, noWait, wantsJSON bool, deps accountAuthDeps, streams IO) error {
	body := map[string]any{}
	if id != "" {
		body["id"] = id
	}
	if reauth {
		body["reauth"] = true
	}
	start, err := requestLoginStart(ctx, api, "POST", "/api/codex-auth/login", body)
	if err != nil {
		return err
	}
	if !wantsJSON {
		if start.URL != "" {
			fmt.Fprintf(streams.Out, "Open this URL to sign in:\n%s\n", start.URL)
		}
		if start.Instructions != "" {
			fmt.Fprintln(streams.Out, start.Instructions)
		}
		if start.FlowID != "" {
			fmt.Fprintf(streams.Out, "Flow: %s\n", start.FlowID)
		}
	}
	if code != "" && start.FlowID != "" {
		if _, err := api.request(ctx, "POST", "/api/codex-auth/login/code",
			map[string]any{"flowId": start.FlowID, "input": code}); err != nil {
			return err
		}
	}
	if noWait {
		if wantsJSON {
			return printData(streams, start.payload(), true, nil)
		}
		return nil
	}
	if start.FlowID == "" {
		return usageError("", "login did not return a flow id")
	}
	query := "/api/codex-auth/login-status?flowId=" + encodeURIComponent(start.FlowID)
	if id != "" {
		query += "&accountId=" + encodeURIComponent(id)
	}
	if reauth {
		query += "&reauth=1"
	}
	for attempt := 0; attempt < codexLoginPollAttempts; attempt++ {
		deps.pause(loginPollInterval)
		state, err := requestStateMap(ctx, api, "GET", query)
		if err != nil {
			return err
		}
		switch state["status"] {
		case "done":
			line := "Logged in."
			if email, isString := state["email"].(string); isString && email != "" {
				line = "Logged in as " + email + "."
			}
			return printData(streams, state, wantsJSON, []string{line})
		case "error", "expired":
			// Stop immediately: continuing to poll a flow the server has
			// already failed just delays the report.
			//
			// The oracle is `String(state.error ?? \`login ${state.status}\`)`:
			// NULLISH coalescing, so only an absent or null error falls back.
			// An empty-string error is used verbatim, and a non-string one is
			// stringified rather than ignored. Testing for a non-empty string
			// instead would replace a server-supplied reason with a generic
			// one whenever the server sent an object or an empty message.
			reason, present := state["error"]
			if !present || reason == nil {
				return usageError("", "login %v", state["status"])
			}
			return usageError("", "%s", jsString(reason))
		}
	}
	return usageError("", "login timed out")
}

func providerLogin(ctx context.Context, api runtimeAPI, provider, id, code string, reauth, noWait, wantsJSON bool, deps accountAuthDeps, streams IO) error {
	body := map[string]any{"provider": provider, "addAccount": !reauth}
	if reauth && id != "" {
		body["accountId"] = id
		body["reauth"] = true
	}
	start, err := requestLoginStart(ctx, api, "POST", "/api/oauth/login", body)
	if err != nil {
		return err
	}
	if !wantsJSON {
		if start.URL != "" {
			fmt.Fprintf(streams.Out, "Open this URL to sign in:\n%s\n", start.URL)
		}
		if start.Instructions != "" {
			fmt.Fprintln(streams.Out, start.Instructions)
		}
		if start.DeviceCode != "" {
			fmt.Fprintf(streams.Out, "Device code: %s\n", start.DeviceCode)
		}
	}
	if code != "" {
		if _, err := api.request(ctx, "POST", "/api/oauth/login/code",
			map[string]any{"provider": provider, "input": code}); err != nil {
			return err
		}
	}
	if noWait {
		if wantsJSON {
			return printData(streams, start.payload(), true, nil)
		}
		return nil
	}
	query := "/api/oauth/status?provider=" + encodeURIComponent(provider)
	for attempt := 0; attempt < providerLoginPollAttempts; attempt++ {
		deps.pause(loginPollInterval)
		state, err := requestStateMap(ctx, api, "GET", query)
		if err != nil {
			return err
		}
		if state["loggedIn"] == true {
			return printData(streams, state, wantsJSON, []string{"Logged in to " + provider + "."})
		}
		// The oracle's test is `if (state.error)` -- JS TRUTHINESS, not "is a
		// non-empty string". A server answering `{"error": true}` or
		// `{"error": {...}}` fails there and would have polled to timeout here.
		if jsTruthy(state["error"]) {
			return usageError("", "%s", jsString(state["error"]))
		}
	}
	return usageError("", "login timed out")
}

func runAccountCode(ctx context.Context, api runtimeAPI, argv []string, deps accountAuthDeps, streams IO) error {
	args := append([]string{}, argv...)
	provider := ""
	if len(args) > 0 {
		provider = strings.ToLower(strings.TrimSpace(args[0]))
		args = args[1:]
	}
	// FLAGS FIRST. Taking the positional before parsing them made
	// `ocx account code openai --flow f1` read `--flow` as the code and then
	// reject `f1` as an unexpected argument.
	wantsJSON := takeFlag(&args, "--json")
	flowID, _, err := takeOption(&args, "--flow")
	if err != nil {
		return err
	}
	supplied, hasSupplied, err := takeOptionWithSyntax(&args, "--code")
	if err != nil {
		return err
	}
	// An unknown flag is NOT a credential. Without this guard `--nope` becomes
	// the positional code and the real complaint ("unexpected argument") is
	// replaced by a confusing one about how the code was passed.
	positional := ""
	hasPositional := false
	if len(args) > 0 && !strings.HasPrefix(args[0], "--") {
		positional, hasPositional = args[0], true
		args = args[1:]
	}
	if provider == "" {
		return usageError(accountAuthUsage, "provider is required")
	}
	// A second positional here is most likely the code, split by an unquoted
	// space or a stray shell expansion. Naming it back would put it on stderr.
	if err := rejectArgs(args, accountAuthUsage, true); err != nil {
		return err
	}
	if hasSupplied && hasPositional {
		return usageError(accountAuthUsage, "pass the code either positionally or with --code, not both")
	}
	var suppliedPtr *suppliedOption
	switch {
	case hasSupplied:
		suppliedPtr = &supplied
	case hasPositional:
		suppliedPtr = &suppliedOption{value: positional}
	}
	input, err := resolveAuthCode(suppliedPtr, deps, true, streams)
	if err != nil {
		return err
	}
	if input == "" {
		return usageError(accountAuthUsage, "provider and redirect/code are required")
	}
	path := "/api/oauth/login/code"
	body := map[string]any{"provider": provider, "input": input}
	if codexNames[provider] {
		if flowID == "" {
			return usageError(accountAuthUsage, "Codex login code requires --flow <flow-id>")
		}
		path = "/api/codex-auth/login/code"
		body = map[string]any{"flowId": flowID, "input": input}
	}
	result, err := api.request(ctx, "POST", path, body)
	if err != nil {
		return err
	}
	return printData(streams, result, wantsJSON, []string{"Login code submitted."})
}

func runAccountCancel(ctx context.Context, api runtimeAPI, argv []string, streams IO) error {
	args := append([]string{}, argv...)
	provider := ""
	if len(args) > 0 {
		provider = strings.ToLower(strings.TrimSpace(args[0]))
		args = args[1:]
	}
	wantsJSON := takeFlag(&args, "--json")
	flowID, _, err := takeOption(&args, "--flow")
	if err != nil {
		return err
	}
	if provider == "" {
		return usageError(accountAuthUsage, "provider is required")
	}
	if err := rejectArgs(args, accountAuthUsage, false); err != nil {
		return err
	}
	path := "/api/oauth/login/cancel"
	body := map[string]any{"provider": provider}
	if codexNames[provider] {
		path = "/api/codex-auth/login/cancel"
		// JSON.stringify({ flowId: undefined }) OMITS the key, so an absent
		// --flow sends `{}` rather than `{"flowId":""}`. The server currently
		// treats both the same, but sending a key the oracle never sends is a
		// divergence a future server change could act on.
		body = map[string]any{}
		if flowID != "" {
			body["flowId"] = flowID
		}
	}
	result, err := api.request(ctx, "POST", path, body)
	if err != nil {
		return err
	}
	return printData(streams, result, wantsJSON, []string{"Cancelled " + provider + " login."})
}

func runAccountResetCredits(ctx context.Context, api runtimeAPI, argv []string, streams IO) error {
	args := append([]string{}, argv...)
	rawID := ""
	if len(args) > 0 {
		rawID = strings.TrimSpace(args[0])
		args = args[1:]
	}
	wantsJSON := takeFlag(&args, "--json")
	consume := takeFlag(&args, "--consume")
	yes := takeFlag(&args, "--yes")
	if rawID == "" {
		return usageError(accountAuthUsage, "account id is required")
	}
	// Consuming a credit is IRREVERSIBLE, so it is gated before the request is
	// built, not after.
	if consume && !yes {
		return usageError(accountAuthUsage, "consuming a reset credit requires --yes")
	}
	if err := rejectArgs(args, accountAuthUsage, false); err != nil {
		return err
	}
	accountID := rawID
	if accountID == "main" {
		accountID = "__main__"
	}
	var result any
	var err error
	if consume {
		result, err = api.request(ctx, "POST", "/api/codex-auth/reset-credits/consume",
			map[string]any{"accountId": accountID})
	} else {
		result, err = api.request(ctx, "GET",
			"/api/codex-auth/reset-credits?accountId="+encodeURIComponent(accountID), nil)
	}
	if err != nil {
		return err
	}
	return printData(streams, result, wantsJSON, nil)
}

func requestLoginStart(ctx context.Context, api runtimeAPI, method, path string, body map[string]any) (loginStart, error) {
	decoded, err := api.request(ctx, method, path, body)
	if err != nil {
		return loginStart{}, err
	}
	// `null` is the ONE non-object the oracle cannot survive: it reads
	// `start.url` straight off the response, which throws. A string, an array
	// or a number all yield undefined for every field and carry on, so only
	// null becomes an error here.
	//
	// Coercing null to an empty start instead let `--no-wait` report success
	// against a server that returned nothing, and made a provider login poll
	// for the full 200 seconds before giving up.
	if decoded == nil {
		return loginStart{}, fmt.Errorf("null is not an object (evaluating 'start.url')")
	}
	record, isObject := decoded.(map[string]any)
	if !isObject {
		// A string, array or number has no fields to read, but it is still
		// what `--json` has to print.
		return loginStart{raw: decoded}, nil
	}
	start := loginStart{raw: decoded}
	if value, isString := record["url"].(string); isString {
		start.URL = value
	}
	if value, isString := record["flowId"].(string); isString {
		start.FlowID = value
	}
	if value, isString := record["instructions"].(string); isString {
		start.Instructions = value
	}
	if value, isString := record["deviceCode"].(string); isString {
		start.DeviceCode = value
	}
	return start, nil
}

func requestStateMap(ctx context.Context, api runtimeAPI, method, path string) (map[string]any, error) {
	decoded, err := api.request(ctx, method, path, nil)
	if err != nil {
		return nil, err
	}
	record, isObject := decoded.(map[string]any)
	if !isObject {
		// The oracle reads `state.status` straight off the response. On `null`
		// that throws a TypeError and the login fails; coercing to an empty
		// map instead made a malformed payload look like "still pending" and
		// polled all the way to the timeout.
		if decoded == nil {
			// The wording is the oracle's, verbatim: a user comparing the two
			// CLIs sees the same message.
			return nil, fmt.Errorf("null is not an object (evaluating 'null.status')")
		}
		return map[string]any{}, nil
	}
	return record, nil
}

// jsTruthy reports whether a decoded JSON value is truthy in JavaScript.
//
// Only false, 0, "", and null/undefined are falsy; every object and array --
// including an empty one -- is truthy. A Go `!= ""` test on a string field is
// therefore NOT the same condition.
func jsTruthy(value any) bool {
	switch typed := value.(type) {
	case nil:
		return false
	case bool:
		return typed
	case float64:
		return typed != 0 && !math.IsNaN(typed)
	case string:
		return typed != ""
	}
	return true
}

// jsString renders a value the way String(value) would for an error message.
func jsString(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case nil:
		return "null"
	case bool:
		if typed {
			return "true"
		}
		return "false"
	case float64:
		return jsNumberText(typed)
	case []any:
		parts := make([]string, 0, len(typed))
		for _, item := range typed {
			if item == nil {
				parts = append(parts, "")
				continue
			}
			parts = append(parts, jsString(item))
		}
		return strings.Join(parts, ",")
	}
	// String({}) is "[object Object]".
	return "[object Object]"
}

// accountAuthDispatch routes the four auth subcommands, reporting whether it
// owns the one it was given.
func accountAuthDispatch(ctx context.Context, api runtimeAPI, sub string, argv []string, deps accountAuthDeps, streams IO) (error, bool) {
	switch sub {
	case "login":
		return runAccountLogin(ctx, api, argv, deps, streams), true
	case "reauth":
		return runAccountLogin(ctx, api, append(append([]string{}, argv...), "--reauth"), deps, streams), true
	case "code":
		return runAccountCode(ctx, api, argv, deps, streams), true
	case "cancel":
		return runAccountCancel(ctx, api, argv, streams), true
	case "reset-credits":
		return runAccountResetCredits(ctx, api, argv, streams), true
	}
	return nil, false
}
