package cli

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

func runChangelog(args []string, streams IO) error {
	jsonOutput := false
	useRegex := false
	from, to, search := "", "", ""
	limit := 20
	value := func(name string) (string, bool, error) {
		for i, arg := range args {
			if arg == name {
				if i+1 >= len(args) || strings.HasPrefix(args[i+1], "--") {
					return "", false, fmt.Errorf("ocx changelog: %s requires a value", name)
				}
				return args[i+1], true, nil
			}
		}
		return "", false, nil
	}
	for i, arg := range args {
		switch arg {
		case "--json":
			jsonOutput = true
		case "--regex":
			useRegex = true
		case "--help", "-h":
			return fmt.Errorf("usage: ocx changelog [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--search text] [--regex] [--limit n] [--json]")
		case "--from", "--to", "--search", "--limit":
			i++
		default:
			if strings.HasPrefix(arg, "--") {
				return fmt.Errorf("ocx changelog: unsupported option %s", arg)
			}
		}
	}
	var err error
	if from, _, err = value("--from"); err != nil {
		return err
	}
	if to, _, err = value("--to"); err != nil {
		return err
	}
	if search, _, err = value("--search"); err != nil {
		return err
	}
	rawLimit, found, err := value("--limit")
	if err != nil {
		return err
	}
	if found {
		limit, err = strconv.Atoi(rawLimit)
		if err != nil || limit < 0 {
			return fmt.Errorf("ocx changelog: --limit expects a non-negative integer")
		}
	}
	if useRegex && search == "" {
		return fmt.Errorf("ocx changelog: --regex requires --search")
	}
	validDate := func(value string) bool {
		parsed, err := time.Parse("2006-01-02", value)
		return err == nil && parsed.Format("2006-01-02") == value
	}
	if (from != "" && !validDate(from)) || (to != "" && !validDate(to)) {
		return fmt.Errorf("ocx changelog: dates must use YYYY-MM-DD")
	}
	if from != "" && to != "" && from > to {
		return fmt.Errorf("ocx changelog: --from must be on or before --to")
	}
	path := findPackagedChangelog()
	var data []byte
	var readErr error
	if path != "" {
		data, readErr = os.ReadFile(path)
	} else {
		readErr = os.ErrNotExist
	}
	if readErr != nil {
		if jsonOutput {
			return json.NewEncoder(streams.Out).Encode(map[string]any{"available": false, "releases": []any{}})
		}
		return fmt.Errorf("ocx changelog: no CHANGELOG.md is packaged with this build")
	}
	releases := parseCLIChangelog(string(data))
	match := func(text string) bool {
		if search == "" {
			return true
		}
		if useRegex {
			re, e := regexp.Compile("(?i)" + search)
			return e == nil && re.MatchString(text)
		}
		return strings.Contains(strings.ToLower(text), strings.ToLower(search))
	}
	filtered := make([]cliRelease, 0, len(releases))
	for _, release := range releases {
		if from != "" && (release.Date == "" || release.Date < from) || to != "" && (release.Date == "" || release.Date > to) {
			continue
		}
		entries := release.Entries
		if search != "" {
			entries = nil
			for _, entry := range release.Entries {
				if match(entry) {
					entries = append(entries, entry)
				}
			}
		}
		if search != "" && len(entries) == 0 && !match(release.Version) {
			continue
		}
		release.Entries = entries
		filtered = append(filtered, release)
	}
	total := len(filtered)
	if limit > 0 && len(filtered) > limit {
		filtered = filtered[:limit]
	}
	if jsonOutput {
		return json.NewEncoder(streams.Out).Encode(map[string]any{"available": true, "releases": filtered, "total": total})
	}
	if len(filtered) == 0 {
		_, err = fmt.Fprintln(streams.Out, "No releases match.")
		return err
	}
	for _, release := range filtered {
		fmt.Fprintf(streams.Out, "\n%s", release.Version)
		if release.Date != "" {
			fmt.Fprintf(streams.Out, "  %s", release.Date)
		}
		fmt.Fprintln(streams.Out)
		for _, entry := range release.Entries {
			fmt.Fprintf(streams.Out, "  - %s\n", entry)
		}
	}
	return nil
}

type cliRelease struct {
	Version string   `json:"version"`
	Date    string   `json:"date"`
	Entries []string `json:"entries"`
}

var cliChangelogHeading = regexp.MustCompile(`^##\s+([^\s—-]+)\s*(?:[—-]\s*(\d{4}-\d{2}-\d{2}))?\s*$`)

func parseCLIChangelog(markdown string) []cliRelease {
	releases := []cliRelease{}
	current := -1
	for _, line := range strings.Split(strings.ReplaceAll(markdown, "\r\n", "\n"), "\n") {
		if m := cliChangelogHeading.FindStringSubmatch(strings.TrimSpace(line)); m != nil {
			releases = append(releases, cliRelease{Version: m[1], Date: m[2], Entries: []string{}})
			current = len(releases) - 1
			continue
		}
		trimmed := strings.TrimSpace(line)
		if current >= 0 && len(trimmed) > 2 && (strings.HasPrefix(trimmed, "- ") || strings.HasPrefix(trimmed, "* ")) {
			releases[current].Entries = append(releases[current].Entries, strings.TrimSpace(trimmed[2:]))
		}
	}
	return releases
}
func findPackagedChangelog() string {
	candidates := []string{}
	if configured := strings.TrimSpace(os.Getenv("OCX_CHANGELOG_PATH")); configured != "" {
		candidates = append(candidates, configured)
	}
	if executable, err := os.Executable(); err == nil {
		dir := filepath.Dir(executable)
		candidates = append(candidates, filepath.Join(dir, "CHANGELOG.md"), filepath.Join(dir, "..", "CHANGELOG.md"))
	}
	if cwd, err := os.Getwd(); err == nil {
		candidates = append(candidates, filepath.Join(cwd, "CHANGELOG.md"))
	}
	if dir, err := configDir(); err == nil {
		candidates = append(candidates, filepath.Join(dir, "CHANGELOG.md"), filepath.Join(filepath.Dir(dir), "CHANGELOG.md"))
	}
	for _, candidate := range candidates {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate
		}
	}
	return ""
}

func runExport(args []string, streams IO) error {
	return runConfig(append([]string{"export"}, args...), streams)
}

func runHost(args []string, streams IO) error {
	jsonOutput := false
	verb := "status"
	for _, arg := range args {
		if arg == "--json" {
			jsonOutput = true
		} else if verb == "status" && !strings.HasPrefix(arg, "--") {
			verb = arg
		} else {
			return fmt.Errorf("usage: ocx host [status|discover] [--json]")
		}
	}
	cfg, _, err := loadConfig()
	if err != nil {
		return err
	}
	if verb != "status" && verb != "discover" {
		return fmt.Errorf("unknown host subcommand %q", verb)
	}
	value := map[string]any{"hostname": cfg.Host, "port": cfg.Port, "exposed": !isLoopbackCLIHost(cfg.Host), "credentialPresent": len(cfg.APIKeys) > 0}
	if verb == "discover" {
		value = map[string]any{"hosts": []any{value}}
	}
	if jsonOutput {
		return json.NewEncoder(streams.Out).Encode(value)
	}
	if verb == "discover" {
		fmt.Fprintf(streams.Out, "local\t%s:%d\n", cfg.Host, cfg.Port)
	} else {
		fmt.Fprintf(streams.Out, "hostname=%s port=%d exposed=%t credentialPresent=%t\n", cfg.Host, cfg.Port, value["exposed"], value["credentialPresent"])
	}
	return nil
}

func runLaunch(args []string, streams IO) error {
	jsonOutput := false
	positional := []string{}
	for _, arg := range args {
		if arg == "--json" {
			jsonOutput = true
		} else if strings.HasPrefix(arg, "--") {
			return fmt.Errorf("unsupported launch option %q", arg)
		} else {
			positional = append(positional, arg)
		}
	}
	if len(positional) > 1 {
		return fmt.Errorf("usage: ocx launch [target] [--json]")
	}
	targets := []map[string]any{{"id": "codex", "kind": "cli", "label": "Codex", "available": false}, {"id": "claude", "kind": "cli", "label": "Claude Code", "available": false}, {"id": "grok", "kind": "cli", "label": "Grok", "available": false}}
	if len(positional) == 1 {
		for _, target := range targets {
			if target["id"] == positional[0] {
				return jsonOrTextUnavailable(streams, jsonOutput, target)
			}
		}
		return fmt.Errorf("unknown launch target %q", positional[0])
	}
	if jsonOutput {
		return json.NewEncoder(streams.Out).Encode(map[string]any{"targets": targets})
	}
	for _, target := range targets {
		fmt.Fprintf(streams.Out, "%s\t%s\tnot installed\n", target["id"], target["label"])
	}
	return nil
}

func runTerminal(args []string, streams IO) error {
	jsonOutput := false
	verb := "list"
	for _, arg := range args {
		if arg == "--json" {
			jsonOutput = true
		} else if verb == "list" && !strings.HasPrefix(arg, "--") {
			verb = arg
		} else {
			return fmt.Errorf("usage: ocx terminal [list] [--json]")
		}
	}
	if verb != "list" {
		return fmt.Errorf("terminal sessions require the authenticated management host; use ocx terminal list")
	}
	presets := []map[string]any{{"id": "shell", "label": "Shell", "available": false}, {"id": "powershell", "label": "PowerShell", "available": false}}
	if jsonOutput {
		return json.NewEncoder(streams.Out).Encode(map[string]any{"presets": presets})
	}
	for _, preset := range presets {
		fmt.Fprintf(streams.Out, "%s\t%s\tnot available\n", preset["id"], preset["label"])
	}
	return nil
}

func jsonOrTextUnavailable(streams IO, jsonOutput bool, target map[string]any) error {
	target["reason"] = "target_unavailable"
	if jsonOutput {
		return json.NewEncoder(streams.Out).Encode(target)
	}
	return fmt.Errorf("%s is not installed", target["label"])
}

func isLoopbackCLIHost(host string) bool {
	host = strings.Trim(strings.ToLower(strings.TrimSpace(host)), "[]")
	return host == "" || host == "localhost" || host == "127.0.0.1" || host == "::1"
}
