package cli

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"
	"time"

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
	case "list-custom":
		return modelsListCustom(args, streams)
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
	if providerFilter == "" || providerFilter == "cursor" {
		if store, storeErr := accountStore(); storeErr == nil {
			if discovered, discoveryErr := discoverConfiguredCursorModels(context.Background(), *cfg, store, nil); discoveryErr == nil {
				provider := cfg.Providers["cursor"]
				provider.Models = append(provider.Models, discovered...)
				cfg.Providers["cursor"] = provider
			} else if streams.Err != nil {
				fmt.Fprintf(streams.Err, "Warning: Cursor model discovery failed; showing configured models: %v\n", discoveryErr)
			}
		}
	}
	rows := collectConfiguredModels(*cfg, providerFilter)
	if jsonOutput {
		return writePrettyJSON(streams.Out, map[string]any{
			"models": rows,
			"note":   "Configured models plus live Cursor discovery when credentials are available. Other liveModels providers may expose more models at runtime.",
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
	cfg, path, err := loadConfig()
	if err != nil {
		return err
	}
	if command == "add" {
		entry, parseErr := parseCustomModelAdd(args)
		if parseErr != nil {
			return parseErr
		}
		if _, ok := cfg.Providers[entry.Provider]; !ok {
			return fmt.Errorf("provider %q is not configured", entry.Provider)
		}
		entry.ID, err = newUUID()
		if err != nil {
			return fmt.Errorf("generate custom model id: %w", err)
		}
		entry.AddedAt = time.Now().UTC().Format(time.RFC3339Nano)
		if err := config.AddCustomModel(cfg, entry); err != nil {
			return err
		}
		if err := config.Save(path, cfg); err != nil {
			return err
		}
		fmt.Fprintf(streams.Out, "Added custom model %s/%s (%s).\n", entry.Provider, entry.ModelID, entry.ID)
		return nil
	}
	confirmed, rest := consumeBoolFlag(args, "--yes")
	if len(rest) != 1 {
		return fmt.Errorf("usage: ocx models remove <customId|provider/modelId> [--yes]")
	}
	if !confirmed {
		return fmt.Errorf("remove requires --yes in non-interactive mode")
	}
	removed, ok := config.RemoveCustomModel(cfg, strings.TrimSpace(rest[0]))
	if !ok {
		return fmt.Errorf("custom model %q not found", rest[0])
	}
	if err := config.Save(path, cfg); err != nil {
		return err
	}
	fmt.Fprintf(streams.Out, "Removed custom model %s/%s.\n", removed.Provider, removed.ModelID)
	return nil
}

func parseCustomModelAdd(args []string) (config.CustomModel, error) {
	if len(args) < 2 {
		return config.CustomModel{}, fmt.Errorf("usage: ocx models add <provider> <modelId> [--display-name NAME] [--context-window TOKENS] [--modalities LIST]")
	}
	entry := config.CustomModel{Provider: strings.TrimSpace(args[0]), ModelID: strings.TrimSpace(args[1])}
	rest := args[2:]
	var err error
	entry.DisplayName, rest, err = consumeValueFlag(rest, "--display-name")
	if err != nil {
		return entry, err
	}
	contextValue, rest, err := consumeValueFlag(rest, "--context-window")
	if err != nil {
		return entry, err
	}
	modalitiesValue, rest, err := consumeValueFlag(rest, "--modalities")
	if err != nil || len(rest) != 0 {
		return entry, fmt.Errorf("invalid models add arguments")
	}
	if entry.Provider == "" || !validProviderName.MatchString(entry.Provider) || entry.ModelID == "" || strings.Contains(entry.ModelID, "/") {
		return entry, fmt.Errorf("provider must be valid and modelId must be nonblank without /")
	}
	entry.DisplayName = strings.TrimSpace(entry.DisplayName)
	if strings.Contains(entry.DisplayName, "/") {
		return entry, fmt.Errorf("displayName must not contain /")
	}
	if contextValue != "" {
		entry.ContextWindow, err = strconv.Atoi(contextValue)
		if err != nil || entry.ContextWindow <= 0 {
			return entry, fmt.Errorf("context window must be a positive integer")
		}
	}
	if modalitiesValue != "" {
		seen := map[string]bool{}
		for _, value := range strings.Split(modalitiesValue, ",") {
			value = strings.TrimSpace(value)
			if value != "text" && value != "image" && value != "audio" {
				return entry, fmt.Errorf("modalities must be comma-separated values from text|image|audio")
			}
			if !seen[value] {
				entry.InputModalities = append(entry.InputModalities, value)
				seen[value] = true
			}
		}
	}
	return entry, nil
}

func modelsListCustom(args []string, streams IO) error {
	jsonOutput, rest := consumeBoolFlag(args, "--json")
	if len(rest) != 0 {
		return fmt.Errorf("usage: ocx models list-custom [--json]")
	}
	cfg, _, err := loadConfig()
	if err != nil {
		return err
	}
	if jsonOutput {
		return writePrettyJSON(streams.Out, cfg.CustomModels)
	}
	if len(cfg.CustomModels) == 0 {
		fmt.Fprintln(streams.Out, "No custom models registered.")
		return nil
	}
	current := ""
	for _, model := range cfg.CustomModels {
		if model.Provider != current {
			current = model.Provider
			fmt.Fprintf(streams.Out, "%s:\n", current)
		}
		context := "-"
		if model.ContextWindow > 0 {
			context = fmt.Sprintf("%dk", model.ContextWindow/1000)
		}
		modalities := "-"
		if len(model.InputModalities) > 0 {
			modalities = strings.Join(model.InputModalities, ",")
		}
		display := model.DisplayName
		if display == "" {
			display = "-"
		}
		id := model.ID
		if len(id) > 8 {
			id = id[:8]
		}
		fmt.Fprintf(streams.Out, "  %-8s  %-24s  %-20s  %-8s  %s\n", id, model.ModelID, display, context, modalities)
	}
	return nil
}

func newUUID() (string, error) {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return "", err
	}
	bytes[6] = bytes[6]&0x0f | 0x40
	bytes[8] = bytes[8]&0x3f | 0x80
	hexValue := hex.EncodeToString(bytes[:])
	return hexValue[:8] + "-" + hexValue[8:12] + "-" + hexValue[12:16] + "-" + hexValue[16:20] + "-" + hexValue[20:], nil
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
