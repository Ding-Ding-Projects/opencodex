package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/providers"
)

type providerSummary struct {
	Name         string   `json:"name"`
	Adapter      string   `json:"adapter"`
	BaseURL      string   `json:"baseUrl"`
	AuthMode     string   `json:"authMode"`
	DefaultModel string   `json:"defaultModel,omitempty"`
	Default      bool     `json:"isDefault"`
	Source       string   `json:"source"`
	Models       []string `json:"models"`
}

func providerList(args []string, streams IO) error {
	jsonOutput, rest := consumeBoolFlag(args, "--json")
	if len(rest) != 0 {
		return fmt.Errorf("usage: ocx provider list [--json]")
	}
	cfg, _, err := loadConfig()
	if err != nil {
		return err
	}
	names := sortedProviderNames(cfg.Providers)
	rows := make([]providerSummary, 0, len(names))
	for _, name := range names {
		provider := cfg.Providers[name]
		source := "custom"
		if _, ok := providers.GetProviderRegistryEntry(name); ok {
			source = "registry"
		}
		mode := provider.AuthMode
		if mode == "" {
			mode = "key"
		}
		rows = append(rows, providerSummary{Name: name, Adapter: provider.Adapter, BaseURL: provider.BaseURL, AuthMode: mode, DefaultModel: provider.DefaultModel, Default: name == cfg.DefaultProvider, Source: source, Models: append([]string(nil), provider.Models...)})
	}
	if jsonOutput {
		return writePrettyJSON(streams.Out, map[string]any{"configured": rows, "registryCount": len(providers.ProviderRegistry)})
	}
	fmt.Fprintln(streams.Out, "Configured providers:")
	for _, row := range rows {
		marker := " "
		if row.Default {
			marker = "*"
		}
		model := ""
		if row.DefaultModel != "" {
			model = " model=" + row.DefaultModel
		}
		custom := ""
		if row.Source == "custom" {
			custom = " [custom]"
		}
		fmt.Fprintf(streams.Out, "%s %-24s adapter=%-18s%s%s\n", marker, row.Name, row.Adapter, model, custom)
	}
	configured := make(map[string]bool, len(rows))
	for _, row := range rows {
		configured[row.Name] = true
	}
	available := 0
	for _, entry := range providers.ProviderRegistry {
		if !configured[entry.ID] {
			available++
		}
	}
	if available > 0 {
		fmt.Fprintf(streams.Out, "\nAvailable from registry: %d (add with: ocx provider add <name>)\n", available)
	}
	return nil
}

func providerShow(args []string, streams IO) error {
	jsonOutput, rest := consumeBoolFlag(args, "--json")
	if len(rest) != 1 {
		return fmt.Errorf("usage: ocx provider show <name> [--json]")
	}
	cfg, _, err := loadConfig()
	if err != nil {
		return err
	}
	provider, ok := cfg.Providers[rest[0]]
	if !ok {
		return fmt.Errorf("provider %q is not configured", rest[0])
	}
	provider.APIKey = providers.MaskAPIKey(provider.APIKey)
	if jsonOutput {
		return writePrettyJSON(streams.Out, struct {
			Name      string `json:"name"`
			IsDefault bool   `json:"isDefault"`
			config.ProviderConfig
		}{Name: rest[0], IsDefault: rest[0] == cfg.DefaultProvider, ProviderConfig: provider})
	}
	fmt.Fprintf(streams.Out, "Provider: %s", rest[0])
	if rest[0] == cfg.DefaultProvider {
		fmt.Fprint(streams.Out, " (default)")
	}
	fmt.Fprintf(streams.Out, "\n  adapter:      %s\n  baseUrl:      %s\n", provider.Adapter, provider.BaseURL)
	if provider.AuthMode != "" {
		fmt.Fprintf(streams.Out, "  authMode:     %s\n", provider.AuthMode)
	}
	if provider.APIKey != "" {
		fmt.Fprintf(streams.Out, "  apiKey:       %s\n", provider.APIKey)
	}
	if provider.DefaultModel != "" {
		fmt.Fprintf(streams.Out, "  defaultModel: %s\n", provider.DefaultModel)
	}
	if len(provider.Models) > 0 {
		fmt.Fprintf(streams.Out, "  models:       %s\n", strings.Join(provider.Models, ", "))
	}
	return nil
}

func sortedProviderNames(input map[string]config.ProviderConfig) []string {
	names := make([]string, 0, len(input))
	for name := range input {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func writePrettyJSON(writer io.Writer, value any) error {
	encoder := json.NewEncoder(writer)
	encoder.SetIndent("", "  ")
	return encoder.Encode(value)
}
