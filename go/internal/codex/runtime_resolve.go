package codex

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/lib"
)

type runtimeResolveCacheEntry struct {
	key   string
	at    time.Time
	value ResolveCodexRuntimeResult
}

var runtimeResolveCache struct {
	sync.Mutex
	entry *runtimeResolveCacheEntry
}

func runtimeResolveCacheKey(options ResolveCodexRuntimeOptions) string {
	if options.DisableCache || options.Probe != nil || options.Exists != nil || options.ReadFile != nil || options.Now != nil {
		return ""
	}
	persisted := LoadPersistedCodexRuntime(options)
	stamp := ""
	if persisted != nil {
		stamp = persisted.Command + "|" + persisted.SelectedVersion + "|" + persisted.UpdatedAt
	}
	return strings.Join([]string{runtimeEnv(options, "CODEX_CLI_PATH"), runtimeEnv(options, "PATH"), runtimeGOOS(options), options.ConfigDir, strconv.FormatBool(discoverRuntimeAlternatives(options)), stamp}, "\x00")
}

func ResolveCodexRuntime(options ResolveCodexRuntimeOptions) ResolveCodexRuntimeResult {
	key := runtimeResolveCacheKey(options)
	now := runtimeNow(options)
	if key != "" {
		runtimeResolveCache.Lock()
		cached := runtimeResolveCache.entry
		if cached != nil && cached.key == key && now.Sub(cached.at) < CodexRuntimeResolveCacheTTL {
			value := cached.value
			runtimeResolveCache.Unlock()
			return value
		}
		runtimeResolveCache.Unlock()
	}
	result := resolveCodexRuntimeUncached(options)
	if key != "" {
		runtimeResolveCache.Lock()
		runtimeResolveCache.entry = &runtimeResolveCacheEntry{key, now, result}
		runtimeResolveCache.Unlock()
	}
	return result
}

func resolveCodexRuntimeUncached(options ResolveCodexRuntimeOptions) ResolveCodexRuntimeResult {
	candidates := []rankedRuntimeCandidate{}
	environment := strings.TrimSpace(runtimeEnv(options, "CODEX_CLI_PATH"))
	if environment != "" {
		candidates = append(candidates, rankedRuntimeCandidate{environment, RuntimeSourceEnvironment})
	}
	persisted := LoadPersistedCodexRuntime(options)
	if persisted != nil {
		candidates = append(candidates, rankedRuntimeCandidate{persisted.Command, RuntimeSourceConfigured})
	}
	for _, command := range shimRuntimeCandidates(options) {
		candidates = append(candidates, rankedRuntimeCandidate{command, RuntimeSourceShim})
	}
	for _, command := range pathRuntimeCandidates(options) {
		candidates = append(candidates, rankedRuntimeCandidate{command, RuntimeSourcePath})
	}
	candidates = append(candidates, rankedRuntimeCandidate{"codex", RuntimeSourceFallback})
	result := ResolveCodexRuntimeResult{Runtime: ResolvedCodexRuntime{Command: "codex", Source: RuntimeSourceFallback}, Failures: []RuntimeProbeFailure{}}
	valid := []ResolvedCodexRuntime{}
	seen := map[string]bool{}
	for _, candidate := range candidates {
		key := strings.ToLower(strings.TrimSpace(candidate.Command))
		if seen[key] {
			continue
		}
		seen[key] = true
		resolved, err := probeRuntimeCandidate(candidate, options)
		if err != nil {
			result.Failures = append(result.Failures, RuntimeProbeFailure{candidate.Command, candidate.Source, truncateRuntimeReason(err.Error())})
			continue
		}
		valid = append(valid, resolved)
		if !discoverRuntimeAlternatives(options) {
			break
		}
	}
	if len(valid) == 0 {
		return result
	}
	selected := valid[0]
	if environment != "" {
		for _, item := range valid {
			if item.Source == RuntimeSourceEnvironment && sameRuntimeCommand(item.Command, environment) {
				selected = item
				break
			}
		}
	}
	if persisted != nil {
		configuredValid := false
		for _, item := range valid {
			if sameRuntimeCommand(item.Command, persisted.Command) {
				configuredValid = true
				if environment == "" {
					selected = item
				}
				break
			}
		}
		if !configuredValid && environment == "" {
			reason := "configured runtime is no longer valid"
			for _, failure := range result.Failures {
				if sameRuntimeCommand(failure.Command, persisted.Command) {
					reason = failure.Reason
					break
				}
			}
			result.ReplacedConfigured = &ReplacedConfiguredRuntime{ResolvedCodexRuntime{persisted.Command, persisted.SelectedVersion, RuntimeSourceConfigured}, reason}
		}
	}
	result.Runtime = selected
	sort.SliceStable(valid, func(i, j int) bool { return CompareCodexVersions(valid[i].Version, valid[j].Version) > 0 })
	for _, item := range valid {
		if !sameRuntimeCommand(item.Command, selected.Command) && CompareCodexVersions(item.Version, selected.Version) > 0 {
			copy := item
			result.NewerAvailable = &copy
			break
		}
	}
	return result
}

func ResolveAndPersistCodexRuntime(options ResolveCodexRuntimeOptions) ResolveCodexRuntimeResult {
	result := ResolveCodexRuntime(options)
	if result.Runtime.Command != "" && result.Runtime.Source != RuntimeSourceFallback {
		if err := PersistCodexRuntime(result.Runtime, options); err != nil {
			result.PersistError = truncateRuntimeReason(err.Error())
		}
	}
	return result
}
func EffortClampAppliesToRuntime(diagnostic *EffortClampDiagnostic, selected ResolvedCodexRuntime) bool {
	if diagnostic == nil || len(diagnostic.RemovedEfforts) == 0 {
		return false
	}
	if sameRuntimeCommand(diagnostic.RuntimePath, selected.Command) {
		return true
	}
	return diagnostic.RuntimeVersion != "" && selected.Version != "" && diagnostic.RuntimeVersion == selected.Version
}
func FormatRuntimeLogLine(selected ResolvedCodexRuntime, home string) string {
	version := selected.Version
	if version == "" {
		version = "unknown"
	}
	return fmt.Sprintf("[opencodex] Codex runtime: %s (version=%s, source=%s)", DisplayCodexRuntimePath(selected.Command, home), version, selected.Source)
}
func FormatClampLogLines(diagnostic EffortClampDiagnostic) []string {
	return []string{"[opencodex] Removed unsupported reasoning efforts: " + strings.Join(diagnostic.RemovedEfforts, ", "), "[opencodex] Run ocx doctor for diagnosis and recovery."}
}
func ResetCodexRuntimeResolveCache() {
	runtimeResolveCache.Lock()
	runtimeResolveCache.entry = nil
	runtimeResolveCache.Unlock()
}
func discoverRuntimeAlternatives(options ResolveCodexRuntimeOptions) bool {
	return options.DiscoverAlternatives == nil || *options.DiscoverAlternatives
}
func sameRuntimeCommand(left, right string) bool {
	return strings.EqualFold(strings.TrimSpace(left), strings.TrimSpace(right))
}
func truncateRuntimeReason(reason string) string {
	reason = lib.RedactUserPath(lib.RedactSecretString(reason))
	reason = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return '?'
		}
		return r
	}, reason)
	if len(reason) > 200 {
		return reason[:200]
	}
	return reason
}
func cleanStringList(values []string) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			out = append(out, value)
		}
	}
	return out
}
