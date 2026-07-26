package codex

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const (
	CodexRuntimeStateFile       = "codex-runtime.json"
	CodexRuntimeClampFile       = "codex-runtime-clamp.json"
	CodexRuntimeProbeTimeout    = 8 * time.Second
	CodexRuntimeResolveCacheTTL = 15 * time.Second
	maxCodexRuntimeStateBytes   = 1 << 20
)

type CodexRuntimeSource string

const (
	RuntimeSourceEnvironment CodexRuntimeSource = "environment"
	RuntimeSourceConfigured  CodexRuntimeSource = "configured"
	RuntimeSourceShim        CodexRuntimeSource = "shim"
	RuntimeSourcePath        CodexRuntimeSource = "path"
	RuntimeSourceFallback    CodexRuntimeSource = "fallback"
)

type ResolvedCodexRuntime struct {
	Command string             `json:"command"`
	Version string             `json:"version,omitempty"`
	Source  CodexRuntimeSource `json:"source"`
}
type RuntimeProbeFailure struct {
	Command string             `json:"command"`
	Source  CodexRuntimeSource `json:"source"`
	Reason  string             `json:"reason"`
}
type EffortClampDiagnostic struct {
	RuntimePath    string   `json:"runtimePath"`
	RuntimeVersion string   `json:"runtimeVersion,omitempty"`
	RemovedEfforts []string `json:"removedEfforts"`
	AffectedModels []string `json:"affectedModels"`
}
type ReplacedConfiguredRuntime struct {
	From   ResolvedCodexRuntime `json:"from"`
	Reason string               `json:"reason"`
}
type ResolveCodexRuntimeResult struct {
	Runtime            ResolvedCodexRuntime       `json:"runtime"`
	Failures           []RuntimeProbeFailure      `json:"failures"`
	ReplacedConfigured *ReplacedConfiguredRuntime `json:"replacedConfigured,omitempty"`
	NewerAvailable     *ResolvedCodexRuntime      `json:"newerAvailable,omitempty"`
	PersistError       string                     `json:"persistError,omitempty"`
}
type RuntimeProbe func(context.Context, string, string, map[string]string) (string, error)
type ResolveCodexRuntimeOptions struct {
	Env                  map[string]string
	GOOS                 string
	ConfigDir            string
	HomeDir              string
	Probe                RuntimeProbe
	Exists               func(string) bool
	ReadFile             func(string) ([]byte, error)
	Now                  func() time.Time
	DiscoverAlternatives *bool
	DisableCache         bool
}

type persistedRuntimeState struct {
	Version         int                `json:"version"`
	Command         string             `json:"command"`
	Source          CodexRuntimeSource `json:"source"`
	SelectedVersion string             `json:"selectedVersion,omitempty"`
	UpdatedAt       string             `json:"updatedAt"`
}
type persistedClampState struct {
	Version   int    `json:"version"`
	UpdatedAt string `json:"updatedAt"`
	EffortClampDiagnostic
}

func CodexRuntimeStatePath(configDir string) string {
	return filepath.Join(configDir, CodexRuntimeStateFile)
}
func CodexRuntimeClampStatePath(configDir string) string {
	return filepath.Join(configDir, CodexRuntimeClampFile)
}
func runtimeNow(options ResolveCodexRuntimeOptions) time.Time {
	if options.Now != nil {
		return options.Now()
	}
	return time.Now()
}
func runtimeGOOS(options ResolveCodexRuntimeOptions) string {
	if options.GOOS != "" {
		return options.GOOS
	}
	return runtime.GOOS
}
func runtimeEnv(options ResolveCodexRuntimeOptions, key string) string {
	if options.Env != nil {
		return options.Env[key]
	}
	return os.Getenv(key)
}
func runtimeExists(options ResolveCodexRuntimeOptions, path string) bool {
	if options.Exists != nil {
		return options.Exists(path)
	}
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}
func readRuntimeFile(options ResolveCodexRuntimeOptions, path string) ([]byte, error) {
	if options.ReadFile != nil {
		return options.ReadFile(path)
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	return io.ReadAll(io.LimitReader(file, maxCodexRuntimeStateBytes+1))
}

func LoadLastEffortClamp(options ResolveCodexRuntimeOptions) *EffortClampDiagnostic {
	data, err := readRuntimeFile(options, CodexRuntimeClampStatePath(options.ConfigDir))
	if err != nil || len(data) > maxCodexRuntimeStateBytes {
		return nil
	}
	var state persistedClampState
	if json.Unmarshal(data, &state) != nil || state.Version != 1 || state.RemovedEfforts == nil {
		return nil
	}
	if state.RuntimePath == "" {
		state.RuntimePath = "codex"
	}
	state.RemovedEfforts = cleanStringList(state.RemovedEfforts)
	state.AffectedModels = cleanStringList(state.AffectedModels)
	return &state.EffortClampDiagnostic
}

func PersistEffortClamp(diagnostic *EffortClampDiagnostic, options ResolveCodexRuntimeOptions) error {
	path := CodexRuntimeClampStatePath(options.ConfigDir)
	if diagnostic == nil || len(diagnostic.RemovedEfforts) == 0 {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return nil
	}
	state := persistedClampState{Version: 1, UpdatedAt: runtimeNow(options).UTC().Format(time.RFC3339Nano), EffortClampDiagnostic: *diagnostic}
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	return atomicWriteFile(path, append(data, '\n'), 0o600)
}

func LoadPersistedCodexRuntime(options ResolveCodexRuntimeOptions) *persistedRuntimeState {
	data, err := readRuntimeFile(options, CodexRuntimeStatePath(options.ConfigDir))
	if err != nil || len(data) > maxCodexRuntimeStateBytes {
		return nil
	}
	var state persistedRuntimeState
	if json.Unmarshal(data, &state) != nil || state.Version != 1 || strings.TrimSpace(state.Command) == "" {
		return nil
	}
	return &state
}

func PersistCodexRuntime(selected ResolvedCodexRuntime, options ResolveCodexRuntimeOptions) error {
	if strings.TrimSpace(selected.Command) == "" {
		return errors.New("Codex runtime command is required")
	}
	state := persistedRuntimeState{1, selected.Command, selected.Source, selected.Version, runtimeNow(options).UTC().Format(time.RFC3339Nano)}
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	if err = atomicWriteFile(CodexRuntimeStatePath(options.ConfigDir), append(data, '\n'), 0o600); err != nil {
		return err
	}
	ResetCodexRuntimeResolveCache()
	return nil
}

var codexVersionPattern = regexp.MustCompile(`\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b`)

func ParseCodexVersionOutput(raw string) string {
	match := codexVersionPattern.FindStringSubmatch(strings.TrimSpace(raw))
	if match == nil {
		return ""
	}
	return match[1]
}

type semVersion struct {
	core []int
	pre  []string
}

func parseSemVersion(value string) semVersion {
	core, pre, found := strings.Cut(value, "-")
	parts := strings.Split(core, ".")
	parsed := semVersion{core: make([]int, len(parts))}
	for index, part := range parts {
		parsed.core[index], _ = strconv.Atoi(part)
	}
	if found && pre != "" {
		parsed.pre = strings.Split(pre, ".")
	}
	return parsed
}
func CompareCodexVersions(left, right string) int {
	if left == "" && right == "" {
		return 0
	}
	if left == "" {
		return -1
	}
	if right == "" {
		return 1
	}
	a, b := parseSemVersion(left), parseSemVersion(right)
	for index := 0; index < max(len(a.core), len(b.core)); index++ {
		av, bv := 0, 0
		if index < len(a.core) {
			av = a.core[index]
		}
		if index < len(b.core) {
			bv = b.core[index]
		}
		if av < bv {
			return -1
		}
		if av > bv {
			return 1
		}
	}
	if len(a.pre) == 0 && len(b.pre) > 0 {
		return 1
	}
	if len(a.pre) > 0 && len(b.pre) == 0 {
		return -1
	}
	for index := 0; index < max(len(a.pre), len(b.pre)); index++ {
		if index >= len(a.pre) {
			return -1
		}
		if index >= len(b.pre) {
			return 1
		}
		an, ae := strconv.Atoi(a.pre[index])
		bn, be := strconv.Atoi(b.pre[index])
		switch {
		case ae == nil && be == nil:
			if an < bn {
				return -1
			}
			if an > bn {
				return 1
			}
		case ae == nil:
			return -1
		case be == nil:
			return 1
		default:
			if a.pre[index] < b.pre[index] {
				return -1
			}
			if a.pre[index] > b.pre[index] {
				return 1
			}
		}
	}
	return 0
}
