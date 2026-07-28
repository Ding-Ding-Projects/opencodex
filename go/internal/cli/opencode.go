package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/codex"
	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/platform"
	"github.com/lidge-jun/opencodex-go/internal/providers"
	"github.com/lidge-jun/opencodex-go/internal/server"
)

// `ocx opencode [args...]` launches the opencode CLI wired to this proxy.
//
// The Go port of src/cli/opencode.ts. Like `ocx claude` it starts or finds the
// proxy and then execs the client with stdio inherited, but the wiring channel
// is different: opencode reads providers from merged JSON config layers, so the
// launcher injects a generated provider block through the inline runtime layer
// (OPENCODE_CONFIG_CONTENT) instead of setting per-provider env slots.
//
// The launcher NEVER rewrites the user's opencode config files. It may read
// them to detect a conflicting `provider.opencodex`, and reports that as
// information only, because the inline layer outranks project and global
// config anyway.

// opencodeProviderID is the provider key this launcher owns. It is the only
// key it ever injects.
const opencodeProviderID = "opencodex"

const opencodeConfigSchema = "https://opencode.ai/config.json"

// opencodeConfigContentEnv is opencode's inline runtime config layer, which
// merges after project/global/custom config.
const opencodeConfigContentEnv = "OPENCODE_CONFIG_CONTENT"

// opencodeProviderNPM is the package opencode loads to speak the proxy's
// OpenAI-compatible /v1 surface.
const opencodeProviderNPM = "@ai-sdk/openai-compatible"

// opencodeAPIKeyEnv carries the proxy admission key to the child process.
//
// The inline config holds only the `{env:...}` REFERENCE, so the secret never
// lands on disk; opencode substitutes it at load time. Serializing the token
// into the config payload would write a live credential into a value that gets
// logged and inherited by grandchildren.
const opencodeAPIKeyEnv = "OPENCODEX_OPENCODE_API_KEY"

// opencodeAPIKeyEnvRef is the reference shared by `apiKey` and the dedicated
// admission header.
const opencodeAPIKeyEnvRef = "{env:" + opencodeAPIKeyEnv + "}"

// schemaRequiredOutputBudget stands in for the output half of opencode's
// `limit` block.
//
// opencode's schema rejects a `limit` carrying `context` without `output`, and
// the catalog has no authoritative per-model output figure. Dropping `limit`
// entirely would also discard the context window we DO have, so this ceiling
// fills the missing half. It is a schema-validity constant, not a claim about
// any model's real maximum, and it is clamped to the context window so a
// small-context model is never emitted with output > context.
const schemaRequiredOutputBudget = 32_000

const opencodeInstallHint = "❌ `opencode` CLI not found. Install it first: npm install -g opencode-ai"

var opencodeProjectConfigFilenames = []string{"opencode.json", "opencode.jsonc"}

// opencodeModelEntry is one model as opencode's provider block lists it.
type opencodeModelEntry struct {
	Name  string              `json:"name"`
	Limit *opencodeModelLimit `json:"limit,omitempty"`
}

type opencodeModelLimit struct {
	Context int `json:"context"`
	Output  int `json:"output"`
}

type opencodeProviderOptions struct {
	BaseURL string            `json:"baseURL"`
	APIKey  string            `json:"apiKey,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
}

type opencodeProviderBlock struct {
	NPM     string                        `json:"npm"`
	Name    string                        `json:"name"`
	Options opencodeProviderOptions       `json:"options"`
	Models  map[string]opencodeModelEntry `json:"models"`
}

// opencodeCatalogModel is a visible catalog entry keyed by the proxy's
// canonical namespaced selector.
type opencodeCatalogModel struct {
	Namespaced    string
	Native        bool
	Provider      string
	ID            string
	ContextWindow int
	DisplayName   string
}

// opencodeProxyModelRow is one row of the proxy's /api/models response.
type opencodeProxyModelRow struct {
	Provider      string `json:"provider"`
	ID            string `json:"id"`
	Namespaced    string `json:"namespaced"`
	Native        bool   `json:"native"`
	Disabled      bool   `json:"disabled"`
	DisplayName   string `json:"displayName"`
	ContextWindow int    `json:"contextWindow"`
}

// decodeOpencodeModelRows accepts BOTH shapes the management API may return.
//
// The oracle assumes the response body IS the array (src/cli/opencode.ts), but
// the Go management server answers with `{"models":[...],"customModels":[...]}`
// (internal/management). Changing the server here would move bytes that other
// differential tests compare, so the launcher widens what it accepts instead --
// which a launcher should do regardless of which shape it meets.
//
// The server-response divergence itself is NOT resolved by this: it stays an
// open parity item for the convergence slice, recorded in
// devlog/_plan/260728_go_port_parity/050_cli_opencode_launcher.md.
func decodeOpencodeModelRows(raw []byte) ([]opencodeProxyModelRow, error) {
	var rows []opencodeProxyModelRow
	if err := json.Unmarshal(raw, &rows); err == nil {
		return rows, nil
	}
	var envelope struct {
		Models       []opencodeProxyModelRow `json:"models"`
		CustomModels []opencodeProxyModelRow `json:"customModels"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil, fmt.Errorf("Management API returned an unexpected /api/models payload.")
	}
	if envelope.Models == nil && envelope.CustomModels == nil {
		return nil, fmt.Errorf("Management API returned an unexpected /api/models payload.")
	}
	return append(append([]opencodeProxyModelRow{}, envelope.Models...), envelope.CustomModels...), nil
}

// opencodeCatalogFromProxyRows keeps the visible rows in order.
//
// Disabled rows are dropped, and native rows are dropped in Codex Direct mode:
// native chat-completions need the caller's real ChatGPT OAuth bearer, which
// proxy admission cannot supply, so advertising them would offer models that
// always fail.
func opencodeCatalogFromProxyRows(rows []opencodeProxyModelRow, cfg config.Config) []opencodeCatalogModel {
	omitNative := providers.ProviderCodexAccountMode("openai", providerEntry(cfg, "openai")) == "direct"
	seen := map[string]bool{}
	catalog := []opencodeCatalogModel{}
	for _, row := range rows {
		namespaced := strings.TrimSpace(row.Namespaced)
		if namespaced == "" || row.Disabled {
			continue
		}
		if omitNative && row.Native {
			continue
		}
		if seen[namespaced] {
			continue
		}
		seen[namespaced] = true
		catalog = append(catalog, opencodeCatalogModel{
			Namespaced:    namespaced,
			Native:        row.Native,
			Provider:      row.Provider,
			ID:            row.ID,
			ContextWindow: row.ContextWindow,
			DisplayName:   row.DisplayName,
		})
	}
	return catalog
}

func providerEntry(cfg config.Config, name string) *providers.ProviderConfig {
	provider, present := cfg.Providers[name]
	if !present {
		return nil
	}
	return &providers.ProviderConfig{
		Adapter:          provider.Adapter,
		BaseURL:          provider.BaseURL,
		AuthMode:         provider.AuthMode,
		CodexAccountMode: provider.CodexAccountMode,
	}
}

func opencodeModelEntryLabel(model opencodeCatalogModel) string {
	providerLabel := model.Provider
	if model.Native {
		providerLabel = "native"
	} else if providerLabel == "" {
		providerLabel = "routed"
	}
	id := model.ID
	if id == "" {
		id = model.Namespaced
	}
	if model.DisplayName != "" {
		return fmt.Sprintf("%s (%s)", model.DisplayName, providerLabel)
	}
	return fmt.Sprintf("%s (%s)", id, providerLabel)
}

// buildOpencodeProviderBlock assembles the provider block from catalog rows.
//
// `limit.context` is emitted ONLY from an authoritative context window, never
// guessed: a wrong context window makes opencode truncate or over-send.
func buildOpencodeProviderBlock(port int, catalog []opencodeCatalogModel, hostname string, cfg config.Config) opencodeProviderBlock {
	models := map[string]opencodeModelEntry{}
	for _, model := range catalog {
		if _, present := models[model.Namespaced]; present {
			// First entry wins; native rows lead /api/models.
			continue
		}
		entry := opencodeModelEntry{Name: opencodeModelEntryLabel(model)}
		if model.ContextWindow > 0 {
			context := model.ContextWindow
			entry.Limit = &opencodeModelLimit{
				Context: context,
				Output:  int(math.Min(float64(schemaRequiredOutputBudget), float64(context))),
			}
		}
		models[model.Namespaced] = entry
	}
	return opencodeProviderBlock{
		NPM:     opencodeProviderNPM,
		Name:    "OpenCodex",
		Options: opencodeProviderOptions_(port, hostname, cfg),
		Models:  models,
	}
}

// opencodeProviderOptions_ chooses HOW the admission key travels.
//
// A non-loopback bind accepts admission only through x-opencodex-api-key, so
// Authorization stays free for the Codex Direct upstream credential. On
// loopback the ordinary `apiKey` field is used.
func opencodeProviderOptions_(port int, hostname string, cfg config.Config) opencodeProviderOptions {
	options := opencodeProviderOptions{BaseURL: opencodeProxyBaseURL(port, hostname)}
	if codex.ShouldInjectAPIAuthHeader(cfg.Host) {
		options.Headers = map[string]string{"x-opencodex-api-key": opencodeAPIKeyEnvRef}
		return options
	}
	options.APIKey = opencodeAPIKeyEnvRef
	return options
}

func opencodeProxyBaseURL(port int, hostname string) string {
	return fmt.Sprintf("http://%s:%d/v1", server.ProbeHostname(hostname), port)
}

// mergeOpencodeRuntimeConfig merges an INHERITED inline layer and replaces only
// `provider.opencodex`.
//
// Replacing the whole payload would silently drop an inline layer a wrapper
// script set up; replacing only our own key leaves the rest intact.
func mergeOpencodeRuntimeConfig(inherited string, block opencodeProviderBlock) (map[string]any, error) {
	if strings.TrimSpace(inherited) == "" {
		return map[string]any{
			"$schema":  opencodeConfigSchema,
			"provider": map[string]any{opencodeProviderID: block},
		}, nil
	}
	var parsed any
	if json.Unmarshal([]byte(inherited), &parsed) != nil {
		return nil, fmt.Errorf("%s is not valid JSON.", opencodeConfigContentEnv)
	}
	record, isObject := parsed.(map[string]any)
	if !isObject {
		return nil, fmt.Errorf("%s must be a JSON object.", opencodeConfigContentEnv)
	}
	existing, present := record["provider"]
	providerRecord, providerIsObject := existing.(map[string]any)
	if present && existing != nil && !providerIsObject {
		return nil, fmt.Errorf("%s provider must be a JSON object when present.", opencodeConfigContentEnv)
	}
	merged := map[string]any{}
	for key, value := range record {
		merged[key] = value
	}
	if schema, isString := record["$schema"].(string); isString {
		merged["$schema"] = schema
	} else {
		merged["$schema"] = opencodeConfigSchema
	}
	providers := map[string]any{}
	for key, value := range providerRecord {
		providers[key] = value
	}
	providers[opencodeProviderID] = block
	merged["provider"] = providers
	return merged, nil
}

// buildOpencodeEnv assembles the child environment.
func buildOpencodeEnv(block opencodeProviderBlock, apiKey string, base map[string]string) (map[string]string, error) {
	runtimeConfig, err := mergeOpencodeRuntimeConfig(base[opencodeConfigContentEnv], block)
	if err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(runtimeConfig)
	if err != nil {
		return nil, err
	}
	env := cloneEnvironment(base)
	env[opencodeConfigContentEnv] = string(encoded)
	env[opencodeAPIKeyEnv] = apiKey
	return env, nil
}

// opencodeGlobalConfigPath resolves the user's global opencode config.
//
// opencode uses the XDG layout on EVERY platform, including Windows, where it
// is %USERPROFILE%\.config\opencode -- not AppData.
func opencodeGlobalConfigPath(env map[string]string, home string) string {
	xdg := env["XDG_CONFIG_HOME"]
	if xdg == "" {
		xdg = filepath.Join(home, ".config")
	}
	return filepath.Join(xdg, "opencode", "opencode.json")
}

// opencodeProviderOverridePath finds a global or project config that already
// defines our provider key. Informational only: the inline runtime layer
// outranks both.
func opencodeProviderOverridePath(cwd string, env map[string]string, home string) string {
	if configFileDefinesOpencodeProvider(opencodeGlobalConfigPath(env, home)) {
		return opencodeGlobalConfigPath(env, home)
	}
	gitRoot := findGitRootFrom(cwd)
	dir := cwd
	for {
		for _, name := range opencodeProjectConfigFilenames {
			candidate := filepath.Join(dir, name)
			if configFileDefinesOpencodeProvider(candidate) {
				return candidate
			}
		}
		if gitRoot != "" && dir == gitRoot {
			return ""
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return ""
		}
		dir = parent
	}
}

func findGitRootFrom(start string) string {
	dir := start
	for {
		if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return ""
		}
		dir = parent
	}
}

func configFileDefinesOpencodeProvider(path string) bool {
	raw, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	parsed, err := parseJSONC(raw)
	if err != nil {
		return false
	}
	record, isObject := parsed.(map[string]any)
	if !isObject {
		return false
	}
	providerRecord, providerIsObject := record["provider"].(map[string]any)
	if !providerIsObject {
		return false
	}
	_, present := providerRecord[opencodeProviderID]
	return present
}

// runOpencode is the launcher entry point.
func runOpencode(ctx context.Context, args []string, streams IO) error {
	return opencodeDispatch(ctx, newRuntimeAPI(), args, streams, nil)
}

// opencodeExec runs the external CLI. It is an injection seam: a test asserts
// the argv and env the launcher assembled without needing opencode installed.
type opencodeExec func(ctx context.Context, args []string, env []string, streams IO) error

// opencodeDispatch is split out so a test can drive the launcher against a stub
// management server and a stub exec, rather than needing a live proxy and the
// real opencode binary on PATH.
func opencodeDispatch(ctx context.Context, api runtimeAPI, args []string, streams IO, run opencodeExec) error {
	cfg, _, err := loadConfig()
	if err != nil {
		return err
	}
	live := findLiveProxy(ctx, cfg)
	if live == nil && strings.TrimSpace(api.BaseURL) == "" {
		fmt.Fprintln(streams.Err, "❌ Proxy did not become healthy after starting.")
		return errSilentFailure
	}
	hostname, port := "", cfg.Port
	if live != nil {
		hostname, port = live.Hostname, live.Port
	}
	_, raw, err := api.requestWithRaw(ctx, "GET", "/api/models", nil)
	if err != nil {
		fmt.Fprintf(streams.Err, "❌ Could not fetch the model catalog from the proxy: %v\n", err)
		return errSilentFailure
	}
	rows, err := decodeOpencodeModelRows(raw)
	if err != nil {
		fmt.Fprintf(streams.Err, "❌ Could not fetch the model catalog from the proxy: %v\n", err)
		return errSilentFailure
	}
	catalog := opencodeCatalogFromProxyRows(rows, *cfg)
	block := buildOpencodeProviderBlock(port, catalog, hostname, *cfg)

	fmt.Fprintf(streams.Err, "✅ opencode wired to %s — %d model(s) under provider `%s`.\n",
		block.Options.BaseURL, len(catalog), opencodeProviderID)
	fmt.Fprintln(streams.Err, "   Your existing opencode config files are left untouched; only the runtime provider block is injected.")

	base := environmentMap(os.Environ())
	cwd, _ := os.Getwd()
	home, _ := os.UserHomeDir()
	if override := opencodeProviderOverridePath(cwd, base, home); override != "" {
		fmt.Fprintf(streams.Err, "ℹ %s also defines provider.%s; the runtime layer from ocx opencode overrides it for this launch.\n",
			override, opencodeProviderID)
	}

	env, err := buildOpencodeEnv(block, api.managementToken(cfg), base)
	if err != nil {
		fmt.Fprintf(streams.Err, "❌ %v\n", err)
		return errSilentFailure
	}

	if run == nil {
		run = execOpencodeBinary
	}
	if runErr := run(ctx, args, environmentList(env), streams); runErr != nil {
		if hint := opencodeNotFoundHint(runErr); hint != "" {
			fmt.Fprintln(streams.Err, hint)
			return errSilentFailure
		}
		// The child's own output already reached the user's terminal, so a
		// non-zero exit is propagated without a second message over the top.
		return errSilentFailure
	}
	return nil
}

func execOpencodeBinary(ctx context.Context, args []string, env []string, streams IO) error {
	var command *exec.Cmd
	if runtime.GOOS == "windows" {
		command = platform.WindowsCommand("opencode", args...)
	} else {
		command = exec.CommandContext(ctx, "opencode", args...)
	}
	command.Stdin, command.Stdout, command.Stderr = streams.In, streams.Out, streams.Err
	command.Env = env
	return command.Run()
}

// opencodeNotFoundHint reports the install hint when the failure means the CLI
// is missing.
//
// Two spellings have to be covered. On Unix a missing binary is ENOENT. On
// Windows the win32 launcher routes `.cmd` shims through cmd.exe, which reports
// command-not-found as exit 9009 rather than failing to start -- so ENOENT
// never fires there and the exit code is the only signal.
func opencodeNotFoundHint(runErr error) string {
	if errors.Is(runErr, exec.ErrNotFound) || errors.Is(runErr, os.ErrNotExist) {
		return opencodeInstallHint
	}
	var exitErr *exec.ExitError
	if runtime.GOOS == "windows" && errors.As(runErr, &exitErr) && exitErr.ExitCode() == 9009 {
		return opencodeInstallHint
	}
	return ""
}
