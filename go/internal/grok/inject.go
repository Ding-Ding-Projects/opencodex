package grok

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/platform"
)

const (
	BeginMarker = "# >>> opencodex managed block — do not edit (removed by `ocx stop`) >>>"
	EndMarker   = "# <<< opencodex managed block <<<"
)

type SkippedReason string

const (
	SkipNone           SkippedReason = ""
	SkipNoGrokHome     SkippedReason = "no-grok-home"
	SkipOrphanedMarker SkippedReason = "orphaned-marker"
	SkipNonLoopback    SkippedReason = "non-loopback"
)

type InjectModel struct {
	ID            string
	Name          string
	ContextWindow int
	// ReasoningEfforts is the model's effort ladder in catalog order. An empty ladder
	// omits the effort scalars and the picker tables entirely, which is what a model
	// without reasoning levels should produce.
	ReasoningEfforts []string
	// DefaultReasoningEffort is the configured default. It is honoured only when it is
	// on the sanitized ladder; otherwise the same fallback the model advertisement uses
	// picks one.
	DefaultReasoningEffort string
}

type Options struct {
	GrokHome string
	Hostname string
	// Excluded allocates aliases for these model IDs without emitting their tables.
	Excluded map[string]struct{}
}

type Result struct {
	OK            bool
	Changed       bool
	Message       string
	SkippedReason SkippedReason
}

type managedRegion struct {
	start, end int
	orphaned   bool
}

var replaceFile = atomicReplace

// BuildGrokManagedBlock returns the LF-normalized OpenCodex-owned TOML fence.
func BuildGrokManagedBlock(port int, models []InjectModel, hostname string, reservedAliases, excluded map[string]struct{}) string {
	host := providerBaseHost(hostname)
	baseURL := fmt.Sprintf("http://%s:%d/v1", host, port)
	lines := []string{BeginMarker}
	aliasCounts := make(map[string]int)
	taken := make(map[string]struct{}, len(reservedAliases)+len(models))
	for alias := range reservedAliases {
		taken[alias] = struct{}{}
	}

	for _, model := range models {
		baseAlias := "ocx-" + sanitizeAlias(model.ID)
		count := aliasCounts[baseAlias] + 1
		alias := baseAlias
		if count > 1 {
			alias = fmt.Sprintf("%s-%d", baseAlias, count)
		}
		for hasAlias(taken, alias) {
			count++
			alias = fmt.Sprintf("%s-%d", baseAlias, count)
		}
		aliasCounts[baseAlias] = count
		taken[alias] = struct{}{}
		// Consume the alias slot before filtering so selection changes cannot rename
		// another model whose sanitized ID collides with this one.
		if _, isExcluded := excluded[model.ID]; isExcluded {
			continue
		}
		if len(lines) > 1 {
			lines = append(lines, "")
		}
		name := model.Name
		if name == "" {
			name = "OCX " + model.ID
		}
		lines = append(lines,
			"[model."+alias+"]",
			"model = "+tomlString(model.ID),
			"base_url = "+tomlString(baseURL),
			`api_backend = "chat_completions"`,
			`api_key = "opencodex-loopback"`,
			"name = "+tomlString(name),
			`extra_headers = { "x-opencodex-grok" = "1" }`,
		)
		if model.ContextWindow > 0 {
			lines = append(lines, fmt.Sprintf("context_window = %d", model.ContextWindow))
		}
		// The array-of-tables MUST follow every parent keyval, the inline extra_headers
		// included, or the tables bind to the wrong parent. Keep every picker option inside
		// Grok's accepted CLI vocabulary; ultra is Codex-only and is dropped above.
		efforts := sanitizeGrokReasoningEfforts(model.ReasoningEfforts)
		if defaultEffort := grokDefaultReasoningEffort(efforts, model.DefaultReasoningEffort); defaultEffort != "" {
			lines = append(lines,
				"supports_reasoning_effort = true",
				"reasoning_effort = "+tomlString(defaultEffort),
			)
			for _, effort := range efforts {
				option := grokReasoningEffortOption(effort, effort == defaultEffort)
				lines = append(lines,
					"",
					"[[model."+alias+".reasoning_efforts]]",
					"id = "+tomlString(option.id),
					"value = "+tomlString(option.value),
					"label = "+tomlString(option.label),
					"description = "+tomlString(option.description),
					fmt.Sprintf("default = %t", option.isDefault),
				)
			}
		}
	}
	lines = append(lines, EndMarker)
	return strings.Join(lines, "\n")
}

// InjectGrokConfig atomically adds or refreshes the managed Grok model fence.
func InjectGrokConfig(port int, models []InjectModel, opts Options) Result {
	if port < 1 || port > 65535 {
		return errorResult("inject", fmt.Errorf("invalid proxy port %d", port))
	}
	home := resolveGrokHome(opts.GrokHome)
	if !isDirectory(home) {
		return Result{OK: true, Message: fmt.Sprintf("Grok home not found at %s; config injection skipped.", home), SkippedReason: SkipNoGrokHome}
	}
	if !isLoopbackHostname(opts.Hostname) {
		removed := StripGrokConfig(Options{GrokHome: home})
		cleanup := ""
		if removed.Changed {
			cleanup = " Removed the previously generated block, which pointed at a loopback address."
		}
		return Result{
			OK: true, Changed: removed.Changed, SkippedReason: SkipNonLoopback,
			Message: fmt.Sprintf("Grok auto-registration skipped: opencodex is bound to the non-loopback host %q, where requests need your admission token. A managed block would either store that secret in ~/.grok/config.toml or overwrite it on the next start, so add the models yourself outside the opencodex markers.%s", opts.Hostname, cleanup),
		}
	}

	configPath := filepath.Join(home, "config.toml")
	backupPath := filepath.Join(home, "config.toml.bak-opencodex")
	raw, existed, err := readOptionalFile(configPath)
	if err != nil {
		return errorResult("inject", err)
	}
	content := string(raw)
	eol := dominantEOL(content)
	region := findManagedRegion(content)
	if region != nil && region.orphaned {
		return orphanedMarkerResult("injection")
	}

	block := applyEOL(BuildGrokManagedBlock(port, models, opts.Hostname, userModelAliases(content, region), opts.Excluded), eol)
	var next string
	switch {
	case region != nil:
		next = content[:region.start] + block + content[region.end:]
	case content == "":
		next = block + eol
	default:
		// Exactly one separator newline makes the transform injective for originals
		// with and without their own trailing newline, so stripping can restore bytes.
		next = content + eol + block + eol
	}
	output := []byte(next)
	if string(output) == string(raw) {
		return Result{OK: true, Message: "Grok config already contains the current opencodex managed block."}
	}
	if existed && region == nil {
		if err := copyBackupOnce(configPath, backupPath); err != nil {
			return errorResult("inject", err)
		}
	}
	if err := atomicWriteFile(configPath, output, 0o600); err != nil {
		return errorResult("inject", err)
	}
	message := "Added the opencodex managed block to Grok config."
	if region != nil {
		message = "Updated the opencodex managed block in Grok config."
	}
	return Result{OK: true, Changed: true, Message: message}
}

// StripGrokConfig atomically removes only the complete OpenCodex-managed fence.
func StripGrokConfig(opts Options) Result {
	home := resolveGrokHome(opts.GrokHome)
	if !isDirectory(home) {
		return Result{OK: true, Message: fmt.Sprintf("Grok home not found at %s; no managed config to remove.", home), SkippedReason: SkipNoGrokHome}
	}
	configPath := filepath.Join(home, "config.toml")
	raw, existed, err := readOptionalFile(configPath)
	if err != nil {
		return errorResult("strip", err)
	}
	if !existed {
		return Result{OK: true, Message: "Grok config not found; no managed block to remove."}
	}
	content := string(raw)
	region := findManagedRegion(content)
	if region == nil {
		return Result{OK: true, Message: "No opencodex managed block found in Grok config."}
	}
	if region.orphaned {
		return orphanedMarkerResult("cleanup")
	}

	eol := managedRegionEOL(content, region)
	removalEnd := consumeLineEnding(content, region.end)
	prefix := content[:region.start]
	rest := content[removalEnd:]
	if strings.HasSuffix(prefix, eol+eol) {
		prefix = prefix[:len(prefix)-len(eol)]
	} else if rest == "" && strings.HasSuffix(prefix, eol) {
		prefix = prefix[:len(prefix)-len(eol)]
	}
	if err := atomicWriteFile(configPath, []byte(prefix+rest), 0o600); err != nil {
		return errorResult("strip", err)
	}
	return Result{OK: true, Changed: true, Message: "Removed the opencodex managed block from Grok config."}
}

func resolveGrokHome(explicit string) string {
	if explicit != "" {
		return explicit
	}
	if configured := os.Getenv("GROK_HOME"); configured != "" {
		return configured
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return filepath.Join(".", ".grok")
	}
	return filepath.Join(home, ".grok")
}

func isDirectory(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

func isLoopbackHostname(hostname string) bool {
	normalized := strings.ToLower(strings.TrimSpace(hostname))
	switch normalized {
	case "", "localhost", "127.0.0.1", "::1", "[::1]":
		return true
	default:
		return false
	}
}

func providerBaseHost(hostname string) string {
	host := strings.TrimSpace(hostname)
	switch strings.ToLower(host) {
	case "::1", "[::1]":
		return "[::1]"
	case "", "localhost", "127.0.0.1", "0.0.0.0", "::", "[::]":
		return "127.0.0.1"
	}
	if strings.HasPrefix(host, "[") && strings.HasSuffix(host, "]") {
		return host
	}
	if strings.Contains(host, ":") {
		return "[" + host + "]"
	}
	return host
}

func findManagedRegion(content string) *managedRegion {
	start := strings.Index(content, BeginMarker)
	endStart := strings.Index(content, EndMarker)
	beginCount := strings.Count(content, BeginMarker)
	endCount := strings.Count(content, EndMarker)
	if beginCount == 0 && endCount == 0 {
		return nil
	}
	if beginCount != 1 || endCount != 1 || start < 0 || endStart < start+len(BeginMarker) ||
		!markerOccupiesLine(content, start, BeginMarker) || !markerOccupiesLine(content, endStart, EndMarker) {
		return &managedRegion{start: max(start, 0), end: len(content), orphaned: true}
	}
	end := endStart + len(EndMarker)
	return &managedRegion{start: start, end: end}
}

func markerOccupiesLine(content string, offset int, marker string) bool {
	lineStart := offset == 0 || content[offset-1] == '\n'
	after := offset + len(marker)
	lineEnd := after == len(content) || strings.HasPrefix(content[after:], "\n") || strings.HasPrefix(content[after:], "\r\n")
	return lineStart && lineEnd
}

func managedRegionEOL(content string, region *managedRegion) string {
	lineEnd := region.start + len(BeginMarker)
	if strings.HasPrefix(content[lineEnd:], "\r\n") {
		return "\r\n"
	}
	return "\n"
}

func consumeLineEnding(content string, offset int) int {
	if strings.HasPrefix(content[offset:], "\r\n") {
		return offset + 2
	}
	if strings.HasPrefix(content[offset:], "\n") {
		return offset + 1
	}
	return offset
}

func orphanedMarkerResult(action string) Result {
	return Result{
		Message:       fmt.Sprintf("Grok config %s refused: the opencodex markers are missing, duplicated, or out of order. The managed region boundary is ambiguous, so nothing was modified. Repair ~/.grok/config.toml manually (see config.toml.bak-opencodex) and re-run.", action),
		SkippedReason: SkipOrphanedMarker,
	}
}

func errorResult(action string, err error) Result {
	return Result{Message: fmt.Sprintf("Could not %s Grok config: %v", action, err)}
}

func readOptionalFile(path string) ([]byte, bool, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, false, nil
	}
	return data, err == nil, err
}

func copyBackupOnce(source, destination string) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if errors.Is(err, os.ErrExist) {
		return nil
	}
	if err != nil {
		return err
	}
	remove := true
	defer func() {
		output.Close()
		if remove {
			os.Remove(destination)
		}
	}()
	if _, err := io.Copy(output, input); err != nil {
		return err
	}
	if err := output.Sync(); err != nil {
		return err
	}
	if err := output.Close(); err != nil {
		return err
	}
	remove = false
	return nil
}

func dominantEOL(content string) string {
	crlf := strings.Count(content, "\r\n")
	if crlf == 0 {
		return "\n"
	}
	bareLF := strings.Count(content, "\n") - crlf
	if crlf >= bareLF {
		return "\r\n"
	}
	return "\n"
}

func applyEOL(content, eol string) string {
	lf := strings.ReplaceAll(content, "\r\n", "\n")
	if eol == "\r\n" {
		return strings.ReplaceAll(lf, "\n", "\r\n")
	}
	return lf
}

// atomicWriteFile intentionally mirrors codex.atomicWriteFile. That helper and
// its platform replace primitive are package-private, and the Grok package's
// write-scope boundary forbids changing Codex merely to share them.
func atomicWriteFile(path string, data []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".ocx-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(mode); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := replaceFile(temporaryPath, path); err != nil {
		return err
	}
	if mode&0o077 == 0 {
		// The requested mode has no group/other bits: the caller meant this
		// file for the owner alone. Chmod cannot make that true on Windows --
		// it only ever flips the DOS read-only attribute, so a writable file
		// always reports back as 0666 regardless of the mode requested here
		// (this is exactly the failure this closes: config.toml showing
		// -rw-rw-rw- when the test wanted 0600). HardenSecretPath strips the
		// broad Everyone/Users/Authenticated-Users ACEs via icacls on
		// Windows and is a no-op everywhere else, the same real fix already
		// used for the exported config backup (internal/cli/config_parity.go)
		// and the service state file (internal/cli/service_ownership.go).
		// Grok config can legitimately hold a non-loopback admission token
		// (see the SkipNonLoopback message above), so this is not cosmetic.
		if err := platform.HardenSecretPath(path, false); err != nil {
			return err
		}
	}
	return nil
}

func tomlString(value string) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

func hasAlias(aliases map[string]struct{}, alias string) bool {
	_, found := aliases[alias]
	return found
}
