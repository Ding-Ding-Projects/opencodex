package cli

import (
	"fmt"
	"sort"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/codex"
	"github.com/lidge-jun/opencodex-go/internal/config"
)

type configuredModel struct {
	Provider         string   `json:"provider"`
	Model            string   `json:"model"`
	Default          bool     `json:"isDefault"`
	ContextWindow    *int     `json:"contextWindow"`
	InputModalities  []string `json:"inputModalities"`
	ReasoningEfforts []string `json:"reasoningEfforts"`
	DefaultEffort    string   `json:"defaultEffort,omitempty"`
}

type effortLevel struct {
	Effort      string `json:"effort"`
	Description string `json:"description"`
}

func runModels(args []string, streams IO) error {
	command := "list"
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		command, args = args[0], args[1:]
	}
	switch command {
	case "list":
		return modelsList(args, streams)
	case "efforts", "effort-ladder":
		return modelsEfforts(args, streams)
	case "add", "remove":
		return modelsMutate(command, args, streams)
	default:
		return fmt.Errorf("unknown models subcommand %q", command)
	}
}

func modelsList(args []string, streams IO) error {
	jsonOutput, rest := consumeBoolFlag(args, "--json")
	providerFilter, rest, err := consumeValueFlag(rest, "--provider")
	if err != nil || len(rest) != 0 {
		return fmt.Errorf("usage: ocx models list [--provider NAME] [--json]")
	}
	cfg, _, err := loadConfig()
	if err != nil {
		return err
	}
	if providerFilter != "" {
		if _, ok := cfg.Providers[providerFilter]; !ok {
			return fmt.Errorf("provider %q is not configured", providerFilter)
		}
	}
	rows := collectConfiguredModels(*cfg, providerFilter)
	if jsonOutput {
		return writePrettyJSON(streams.Out, map[string]any{
			"models": rows,
			"note":   "Static config models only. Providers with liveModels may expose more models at runtime.",
		})
	}
	if len(rows) == 0 {
		fmt.Fprintln(streams.Out, "No models found in configured providers.")
		return nil
	}
	current := ""
	for _, row := range rows {
		if row.Provider != current {
			if current != "" {
				fmt.Fprintln(streams.Out)
			}
			current = row.Provider
			suffix := ""
			if row.Provider == cfg.DefaultProvider {
				suffix = " (default provider)"
			}
			fmt.Fprintf(streams.Out, "%s%s:\n", row.Provider, suffix)
		}
		marker := ""
		if row.Default {
			marker = " *"
		}
		contextLabel := ""
		if row.ContextWindow != nil {
			contextLabel = fmt.Sprintf(" (%dk)", *row.ContextWindow/1000)
		}
		effortLabel := ""
		if len(row.ReasoningEfforts) > 0 {
			effortLabel = " efforts=" + strings.Join(row.ReasoningEfforts, ",")
		}
		fmt.Fprintf(streams.Out, "  %s%s%s%s\n", row.Model, marker, contextLabel, effortLabel)
	}
	fmt.Fprintln(streams.Out, "\n* = default model for provider")
	return nil
}

func collectConfiguredModels(cfg config.Config, providerFilter string) []configuredModel {
	providerNames := sortedProviderNames(cfg.Providers)
	rows := []configuredModel{}
	for _, name := range providerNames {
		if providerFilter != "" && name != providerFilter {
			continue
		}
		provider := cfg.Providers[name]
		seen := map[string]bool{}
		models := make([]string, 0, len(provider.Models)+1)
		if strings.TrimSpace(provider.DefaultModel) != "" {
			models = append(models, provider.DefaultModel)
		}
		models = append(models, provider.Models...)
		for _, model := range models {
			model = strings.TrimSpace(model)
			if model == "" || seen[model] {
				continue
			}
			seen[model] = true
			contextWindow := provider.ContextWindow
			if value := provider.ModelContextWindows[model]; value > 0 {
				contextWindow = value
			}
			var contextPointer *int
			if contextWindow > 0 {
				value := contextWindow
				contextPointer = &value
			}
			modalities := append([]string(nil), provider.ModelInputModalities[model]...)
			if len(modalities) == 0 && stringInSlice(provider.NoVisionModels, model) {
				modalities = []string{"text"}
			}
			rows = append(rows, configuredModel{
				Provider: name, Model: model, Default: model == provider.DefaultModel,
				ContextWindow: contextPointer, InputModalities: modalities,
				ReasoningEfforts: config.ConfiguredReasoningEfforts(provider, model),
				DefaultEffort:    provider.ModelDefaultReasoningEfforts[model],
			})
		}
	}
	return rows
}

func modelsEfforts(args []string, streams IO) error {
	jsonOutput, rest := consumeBoolFlag(args, "--json")
	if len(rest) > 1 {
		return fmt.Errorf("usage: ocx models efforts [provider/model] [--json]")
	}
	target := ""
	if len(rest) == 1 {
		target = rest[0]
	}
	levels := modelEffortLadder()
	if target == "" {
		if jsonOutput {
			return writePrettyJSON(streams.Out, map[string]any{"ladder": levels})
		}
		fmt.Fprintln(streams.Out, "Codex reasoning effort ladder:")
		for _, level := range levels {
			fmt.Fprintf(streams.Out, "  %-8s %s\n", level.Effort, level.Description)
		}
		return nil
	}
	providerName, model, ok := strings.Cut(target, "/")
	if !ok || providerName == "" || model == "" {
		return fmt.Errorf("model target must be provider/model")
	}
	cfg, _, err := loadConfig()
	if err != nil {
		return err
	}
	provider, ok := cfg.Providers[providerName]
	if !ok {
		return fmt.Errorf("provider %q is not configured", providerName)
	}
	supported := config.ConfiguredReasoningEfforts(provider, model)
	mapped := make(map[string]string, len(supported))
	for _, effort := range supported {
		mapped[effort] = config.MapReasoningEffort(provider, model, effort)
	}
	result := map[string]any{"provider": providerName, "model": model, "supported": supported, "wireMap": mapped, "default": nullableString(provider.ModelDefaultReasoningEfforts[model]), "ladder": levels}
	if jsonOutput {
		return writePrettyJSON(streams.Out, result)
	}
	fmt.Fprintf(streams.Out, "%s supports: %s\n", target, strings.Join(supported, ", "))
	for _, effort := range supported {
		if mapped[effort] != effort {
			fmt.Fprintf(streams.Out, "  %-8s -> %s\n", effort, mapped[effort])
		}
	}
	return nil
}

func modelEffortLadder() []effortLevel {
	descriptions := map[string]string{
		"none":    "Disable provider reasoning when supported",
		"minimal": "Minimal reasoning for the fastest supported response",
	}
	for _, level := range config.CodexReasoningLevels {
		descriptions[level.Effort] = level.Description
	}
	levels := make([]effortLevel, 0, len(codex.CodexReasoningEfforts))
	for _, effort := range codex.CodexReasoningEfforts {
		levels = append(levels, effortLevel{Effort: effort, Description: descriptions[effort]})
	}
	return levels
}

func modelsMutate(command string, args []string, streams IO) error {
	if len(args) != 2 {
		return fmt.Errorf("usage: ocx models %s <provider> <model>", command)
	}
	cfg, path, err := loadConfig()
	if err != nil {
		return err
	}
	name, model := strings.TrimSpace(args[0]), strings.TrimSpace(args[1])
	if model == "" || strings.Contains(model, "/") {
		return fmt.Errorf("model must be a non-empty provider-local id without /")
	}
	provider, ok := cfg.Providers[name]
	if !ok {
		return fmt.Errorf("provider %q is not configured", name)
	}
	if command == "add" {
		if !stringInSlice(provider.Models, model) {
			provider.Models = append(provider.Models, model)
			sort.Strings(provider.Models)
		}
	} else {
		models := make([]string, 0, len(provider.Models))
		for _, existing := range provider.Models {
			if existing != model {
				models = append(models, existing)
			}
		}
		provider.Models = models
	}
	cfg.Providers[name] = provider
	if err := config.Save(path, cfg); err != nil {
		return err
	}
	action := "Added"
	if command == "remove" {
		action = "Removed"
	}
	fmt.Fprintf(streams.Out, "%s model %s for provider %s.\n", action, model, name)
	return nil
}

func consumeValueFlag(args []string, name string) (string, []string, error) {
	value := ""
	rest := make([]string, 0, len(args))
	for index := 0; index < len(args); index++ {
		if args[index] != name {
			rest = append(rest, args[index])
			continue
		}
		if value != "" || index+1 >= len(args) {
			return "", nil, fmt.Errorf("%s requires one value", name)
		}
		index++
		value = args[index]
	}
	return value, rest, nil
}

func stringInSlice(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
