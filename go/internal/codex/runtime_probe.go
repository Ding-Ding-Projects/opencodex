package codex

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/lib"
)

type rankedRuntimeCandidate struct {
	Command string
	Source  CodexRuntimeSource
}

func DisplayCodexRuntimePath(command, home string) string {
	if command == "codex" {
		return command
	}
	clean := filepath.Clean(command)
	if home != "" {
		if relative, err := filepath.Rel(home, clean); err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) && !filepath.IsAbs(relative) {
			if relative == "." {
				return "~"
			}
			return "~/" + filepath.ToSlash(relative)
		}
	}
	return lib.RedactUserPath(clean)
}

func isSpawnableRuntimeCandidate(path, goos string) bool {
	if goos != "windows" {
		info, err := os.Stat(path)
		return err == nil && info.Mode().IsRegular() && info.Mode()&0o111 != 0
	}
	switch strings.ToLower(filepath.Ext(path)) {
	case ".exe", ".cmd", ".bat":
		return true
	}
	return false
}

func defaultRuntimeProbe(ctx context.Context, command, goos string, env map[string]string) (string, error) {
	probeHome, err := os.MkdirTemp("", "ocx-codex-probe-")
	if err != nil {
		return "", errors.New("probe sandbox unavailable")
	}
	defer os.RemoveAll(probeHome)
	var invocation *exec.Cmd
	if goos == "windows" && (strings.HasSuffix(strings.ToLower(command), ".cmd") || strings.HasSuffix(strings.ToLower(command), ".bat")) {
		invocation = exec.CommandContext(ctx, "cmd.exe", "/d", "/s", "/c", command, "--version")
	} else {
		invocation = exec.CommandContext(ctx, command, "--version")
	}
	invocation.Stderr = io.Discard
	if env == nil {
		invocation.Env = append(invocation.Env, os.Environ()...)
	} else {
		for key, value := range env {
			invocation.Env = append(invocation.Env, key+"="+value)
		}
	}
	invocation.Env = append(invocation.Env, "CODEX_HOME="+probeHome)
	output, err := invocation.Output()
	if err != nil {
		return "", fmt.Errorf("failed --version (%s)", truncateRuntimeReason(err.Error()))
	}
	version := ParseCodexVersionOutput(string(output))
	if version == "" {
		return "", errors.New("unrecognized --version output")
	}
	return version, nil
}

func probeRuntimeCandidate(candidate rankedRuntimeCandidate, options ResolveCodexRuntimeOptions) (ResolvedCodexRuntime, error) {
	command := strings.TrimSpace(candidate.Command)
	if command == "" {
		return ResolvedCodexRuntime{}, errors.New("empty command")
	}
	if strings.ContainsAny(command, `/\`) || regexp.MustCompile(`^[A-Za-z]:`).MatchString(command) {
		if !runtimeExists(options, command) {
			return ResolvedCodexRuntime{}, errors.New("path does not exist")
		}
		if options.Exists == nil && !isSpawnableRuntimeCandidate(command, runtimeGOOS(options)) {
			return ResolvedCodexRuntime{}, errors.New("not a spawnable Codex launcher on this platform")
		}
	}
	probe := options.Probe
	if probe == nil {
		probe = defaultRuntimeProbe
	}
	ctx, cancel := context.WithTimeout(context.Background(), CodexRuntimeProbeTimeout)
	defer cancel()
	version, err := probe(ctx, command, runtimeGOOS(options), options.Env)
	if err != nil {
		return ResolvedCodexRuntime{}, errors.New(truncateRuntimeReason(err.Error()))
	}
	version = ParseCodexVersionOutput(version)
	if version == "" {
		return ResolvedCodexRuntime{}, errors.New("unrecognized --version output")
	}
	return ResolvedCodexRuntime{command, version, candidate.Source}, nil
}

type shimRuntimeFile struct {
	WrapperPath  string `json:"wrapperPath"`
	OriginalPath string `json:"originalPath"`
	BackupPath   string `json:"backupPath"`
}

func shimRuntimeCandidates(options ResolveCodexRuntimeOptions) []string {
	data, err := readRuntimeFile(options, filepath.Join(options.ConfigDir, "codex-shim.json"))
	if err != nil || len(data) > maxCodexRuntimeStateBytes {
		return nil
	}
	var state struct {
		shimRuntimeFile
		Wrappers []shimRuntimeFile `json:"wrappers"`
	}
	if json.Unmarshal(data, &state) != nil {
		return nil
	}
	files := state.Wrappers
	if len(files) == 0 {
		files = []shimRuntimeFile{state.shimRuntimeFile}
	}
	result := []string{}
	seen := map[string]bool{}
	for _, file := range files {
		for _, path := range []string{file.BackupPath, file.OriginalPath, file.WrapperPath} {
			key := strings.ToLower(path)
			if path == "" || seen[key] {
				continue
			}
			if options.Exists == nil && !isSpawnableRuntimeCandidate(path, runtimeGOOS(options)) {
				continue
			}
			seen[key] = true
			result = append(result, path)
		}
	}
	return result
}

func pathRuntimeCandidates(options ResolveCodexRuntimeOptions) []string {
	separator := string(os.PathListSeparator)
	if runtimeGOOS(options) == "windows" {
		separator = ";"
	}
	result := []string{}
	seen := map[string]bool{}
	for _, directory := range strings.Split(runtimeEnv(options, "PATH"), separator) {
		if strings.TrimSpace(directory) == "" {
			continue
		}
		names := []string{"codex"}
		if runtimeGOOS(options) == "windows" {
			names = []string{"codex.exe", "codex.cmd"}
		}
		for _, name := range names {
			path := filepath.Join(directory, name)
			key := strings.ToLower(path)
			if !seen[key] {
				seen[key] = true
				result = append(result, path)
			}
		}
	}
	return result
}
