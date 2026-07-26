package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/claude"
	"github.com/lidge-jun/opencodex-go/internal/codex"
	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

type desktopCLIModel struct {
	claude.DesktopProfileModel
	Available  bool                     `json:"available"`
	Assignment claude.DesktopAssignment `json:"assignment"`
}

type desktopCLIState struct {
	Profile     claude.DesktopProfile         `json:"profile"`
	Models      []desktopCLIModel             `json:"models"`
	NativeSlugs []string                      `json:"-"`
	Routed      []claude.Desktop3pRoutedModel `json:"-"`
}

func runClaudeDesktop(ctx context.Context, args []string, streams IO) error {
	if len(args) > 0 && (args[0] == "help" || args[0] == "--help" || args[0] == "-h") {
		printClaudeDesktopHelp(streams.Out)
		return nil
	}
	cfg, path, err := loadConfig()
	if err != nil {
		return err
	}
	state, err := loadClaudeDesktopState(ctx, cfg, nil)
	if err != nil {
		return err
	}
	command := "apply"
	if len(args) > 0 && !strings.HasPrefix(args[0], "--") {
		command, args = args[0], args[1:]
	}
	switch command {
	case "apply":
		mode, err := claude.ParseDesktop3pModeArgs(args)
		if err != nil {
			return err
		}
		return applyClaudeDesktopProfile(ctx, cfg, path, state, mode, streams)
	case "show":
		if len(args) > 1 || len(args) == 1 && args[0] != "--json" {
			return fmt.Errorf("usage: ocx claude-desktop show [--json]")
		}
		if len(args) == 1 {
			return json.NewEncoder(streams.Out).Encode(state)
		}
		for _, family := range claude.DesktopFamilyValues() {
			defaultRoute := state.Profile.Defaults[family]
			fmt.Fprint(streams.Out, strings.ToUpper(string(family)))
			if defaultRoute != nil {
				fmt.Fprintf(streams.Out, " (default: %s)", *defaultRoute)
			}
			fmt.Fprintln(streams.Out)
			for _, model := range state.Models {
				if model.Assignment.Family == family {
					fmt.Fprintf(streams.Out, "  %s -> %s", model.Route, model.Assignment.Alias)
					if !model.Available {
						fmt.Fprint(streams.Out, " (unavailable)")
					}
					fmt.Fprintln(streams.Out)
				}
			}
		}
		return nil
	case "move":
		if len(args) < 2 || len(args) > 3 || len(args) == 3 && args[2] != "--default" {
			return fmt.Errorf("usage: ocx claude-desktop move <route> <family> [--default]")
		}
		family, ok := desktopFamily(args[1])
		if !ok || !desktopRouteAvailable(state, args[0]) {
			return fmt.Errorf("invalid or unavailable Claude Desktop route/family")
		}
		profile, err := claude.MoveDesktopRoute(state.Profile, args[0], family, len(args) == 3)
		if err != nil {
			return err
		}
		return saveClaudeDesktopProfile(cfg, path, profile)
	case "default":
		if len(args) != 2 {
			return fmt.Errorf("usage: ocx claude-desktop default <family> <route|none>")
		}
		family, ok := desktopFamily(args[0])
		if !ok {
			return fmt.Errorf("unknown Claude Desktop family %q", args[0])
		}
		var route *string
		if args[1] != "none" {
			if !desktopRouteAvailable(state, args[1]) {
				return fmt.Errorf("currently unavailable model: %s", args[1])
			}
			value := args[1]
			route = &value
		}
		profile, err := claude.SetDesktopFamilyDefault(state.Profile, family, route)
		if err != nil {
			return err
		}
		return saveClaudeDesktopProfile(cfg, path, profile)
	case "export":
		if len(args) != 1 {
			return fmt.Errorf("usage: ocx claude-desktop export <path|->")
		}
		data, err := json.MarshalIndent(state.Profile, "", "  ")
		if err != nil {
			return err
		}
		data = append(data, '\n')
		if args[0] == "-" {
			_, err = streams.Out.Write(data)
			return err
		}
		return os.WriteFile(filepath.Clean(args[0]), data, 0o600)
	case "import":
		if len(args) < 1 || len(args) > 2 || len(args) == 2 && args[1] != "--apply" {
			return fmt.Errorf("usage: ocx claude-desktop import <path> [--apply]")
		}
		data, err := os.ReadFile(filepath.Clean(args[0]))
		if err != nil {
			return err
		}
		profile, err := claude.DecodeDesktopProfile(data)
		if err != nil {
			return err
		}
		state, err = loadClaudeDesktopState(ctx, cfg, &profile)
		if err != nil {
			return err
		}
		if err := saveClaudeDesktopProfile(cfg, path, state.Profile); err != nil {
			return err
		}
		if len(args) == 2 {
			return applyClaudeDesktopProfile(ctx, cfg, path, state, claude.Desktop3pStatic, streams)
		}
		return nil
	default:
		printClaudeDesktopHelp(streams.Out)
		return fmt.Errorf("unknown Claude Desktop command %q", command)
	}
}

func loadClaudeDesktopState(ctx context.Context, cfg *config.Config, stored *claude.DesktopProfile) (desktopCLIState, error) {
	models := codex.FilterVisibleRuntimeModels(configuredRegistry(*cfg).ListModels(), *cfg)
	if live := findLiveProxy(ctx, cfg); live != nil {
		if fetched, err := fetchRuntimeModels(ctx, *cfg, live.Port); err == nil {
			models = codex.FilterVisibleRuntimeModels(fetched, *cfg)
		}
	}
	if stored == nil && cfg.ClaudeCode != nil && cfg.ClaudeCode.DesktopProfile != nil {
		profile := cfg.ClaudeCode.DesktopProfile.Clone()
		stored = &profile
	}
	disabled := make(map[string]bool, len(cfg.DisabledModels))
	for _, id := range cfg.DisabledModels {
		disabled[strings.TrimSpace(id)] = true
	}
	profileModels := make([]claude.DesktopProfileModel, 0, len(models))
	availableModels := make(map[string]claude.DesktopProfileModel, len(models))
	var native []string
	var routed []claude.Desktop3pRoutedModel
	for _, model := range models {
		route, provider, id, isNative := cliDesktopRoute(model)
		if route == "" || disabled[route] || disabled[model.ID] {
			continue
		}
		profileModel := claude.DesktopProfileModel{Route: route, Label: model.DisplayName, ContextWindow: model.ContextWindow}
		if profileModel.Label == "" {
			profileModel.Label = route
		}
		profileModels = append(profileModels, profileModel)
		availableModels[route] = profileModel
		if isNative {
			native = append(native, id)
		} else {
			routed = append(routed, claude.Desktop3pRoutedModel{Provider: provider, ID: id, ContextWindow: model.ContextWindow})
		}
	}
	var storedValue any
	if stored != nil {
		storedValue = *stored
	}
	profile, err := claude.ReconcileDesktopProfile(storedValue, profileModels)
	if err != nil {
		return desktopCLIState{}, err
	}
	routes := make([]string, 0, len(profile.Assignments))
	for route := range profile.Assignments {
		routes = append(routes, route)
	}
	sort.Strings(routes)
	result := desktopCLIState{Profile: profile, NativeSlugs: native, Routed: routed}
	for _, route := range routes {
		model, available := availableModels[route]
		if !available {
			model = claude.DesktopProfileModel{Route: route, Label: route}
		}
		result.Models = append(result.Models, desktopCLIModel{DesktopProfileModel: model, Available: available, Assignment: profile.Assignments[route]})
	}
	return result, nil
}

func applyClaudeDesktopProfile(ctx context.Context, cfg *config.Config, path string, state desktopCLIState, mode claude.Desktop3pConfigMode, streams IO) error {
	if err := saveClaudeDesktopProfile(cfg, path, state.Profile); err != nil {
		return err
	}
	libraryPath, err := claude.DefaultDesktop3pLibraryPath()
	if err != nil {
		return err
	}
	port := cfg.Port
	if live := findLiveProxy(ctx, cfg); live != nil {
		port = live.Port
	}
	apiKey := ""
	if len(cfg.APIKeys) > 0 {
		apiKey = cfg.APIKeys[0].Key
	}
	result, err := claude.ApplyDesktop3pConfig(libraryPath, port, state.NativeSlugs, state.Routed, apiKey, mode, &state.Profile)
	if err != nil {
		return err
	}
	state.Profile.AppliedFingerprint = result.Fingerprint
	state.Profile.AppliedAt = time.Now().UTC().Format(time.RFC3339)
	if err := saveClaudeDesktopProfile(cfg, path, state.Profile); err != nil {
		return err
	}
	fmt.Fprintf(streams.Out, "Claude Desktop configuration applied: %s\n", result.Path)
	return nil
}

func saveClaudeDesktopProfile(cfg *config.Config, path string, profile claude.DesktopProfile) error {
	if cfg.ClaudeCode == nil {
		cfg.ClaudeCode = &config.ClaudeCodeConfig{}
	}
	clone := profile.Clone()
	cfg.ClaudeCode.DesktopProfile = &clone
	return config.Save(path, cfg)
}

func cliDesktopRoute(model types.ModelEntry) (route, provider, id string, native bool) {
	id, provider = strings.TrimSpace(model.ID), strings.TrimSpace(model.Provider)
	if provider == "openai" && !strings.Contains(id, "/") {
		return "native/" + id, provider, id, true
	}
	if slash := strings.IndexByte(id, '/'); slash > 0 {
		return id, id[:slash], id[slash+1:], false
	}
	if provider == "" || id == "" {
		return "", "", "", false
	}
	return provider + "/" + id, provider, id, false
}

func desktopFamily(value string) (claude.DesktopFamily, bool) {
	for _, family := range claude.DesktopFamilyValues() {
		if string(family) == value {
			return family, true
		}
	}
	return "", false
}

func desktopRouteAvailable(state desktopCLIState, route string) bool {
	for _, model := range state.Models {
		if model.Route == route {
			return model.Available
		}
	}
	return false
}

func printClaudeDesktopHelp(w interface{ Write([]byte) (int, error) }) {
	fmt.Fprint(w, `Usage:
  ocx claude-desktop [apply] [--static|--hybrid|--discovery-only]
  ocx claude-desktop show [--json]
  ocx claude-desktop move <provider/model> <opus|fable|sonnet|haiku> [--default]
  ocx claude-desktop default <family> <provider/model|none>
  ocx claude-desktop export <path|->
  ocx claude-desktop import <path> [--apply]
`)
}
