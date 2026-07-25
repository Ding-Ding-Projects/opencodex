package cli

import (
	"bufio"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/registry"
)

var nonEnvKey = regexp.MustCompile(`[^A-Z0-9]+`)

func runInit(args []string, streams IO) error {
	if len(args) != 0 {
		return fmt.Errorf("usage: ocx init")
	}
	reader := bufio.NewReader(streams.In)
	entries := registry.New().Entries()
	printInitMenu(streams.Out, entries)
	choice, err := readInitPrompt(reader, streams.Out, "\nSelect default provider (number or id): ")
	if err != nil {
		return err
	}

	name, provider, oauthHint, err := chooseInitProvider(reader, streams.Out, entries, choice)
	if err != nil {
		return err
	}
	portText, err := readInitPrompt(reader, streams.Out, "Proxy port [10100]: ")
	if err != nil {
		return err
	}
	port := config.DefaultPort
	if portText != "" {
		port, err = strconv.Atoi(portText)
		if err != nil || port < 1 || port > 65535 {
			return fmt.Errorf("proxy port must be between 1 and 65535")
		}
	}

	cfg := config.Default()
	cfg.Port = port
	cfg.Providers[name] = provider
	cfg.DefaultProvider = name
	_, path, err := loadConfig()
	if err != nil {
		return err
	}
	if err := config.Save(path, &cfg); err != nil {
		return err
	}
	fmt.Fprintf(streams.Out, "Configured %s as the default provider.\nConfig saved to %s\n", name, path)
	if oauthHint {
		fmt.Fprintf(streams.Out, "Authenticate this provider with: ocx login %s\n", name)
	}
	fmt.Fprintln(streams.Out, "Setup complete. Run `ocx start` to start the proxy.")
	return nil
}

func printInitMenu(writer io.Writer, entries []registry.Provider) {
	fmt.Fprintln(writer, "Choose your default provider (you can add more later):")
	lastKind := registry.AuthKind("")
	headings := map[registry.AuthKind]string{
		registry.AuthForward: "ChatGPT login", registry.AuthOAuth: "Account login (OAuth)",
		registry.AuthKey: "API key", registry.AuthLocal: "Local servers",
	}
	for index, entry := range entries {
		if entry.AuthKind != lastKind {
			fmt.Fprintf(writer, "\n  %s:\n", headings[entry.AuthKind])
			lastKind = entry.AuthKind
		}
		fmt.Fprintf(writer, "  %2d. %s [%s]\n", index+1, entry.Label, entry.ID)
	}
	fmt.Fprintf(writer, "\n  %2d. custom (enter URL manually)\n", len(entries)+1)
}

func chooseInitProvider(reader *bufio.Reader, writer io.Writer, entries []registry.Provider, choice string) (string, config.ProviderConfig, bool, error) {
	index, numberErr := strconv.Atoi(choice)
	if strings.EqualFold(choice, "custom") || numberErr == nil && index == len(entries)+1 {
		name, provider, err := readCustomProvider(reader, writer)
		return name, provider, false, err
	}
	var preset registry.Provider
	found := false
	if numberErr == nil && index >= 1 && index <= len(entries) {
		preset, found = entries[index-1], true
	} else {
		for _, entry := range entries {
			if entry.ID == choice {
				preset, found = entry, true
				break
			}
		}
	}
	if !found {
		return "", config.ProviderConfig{}, false, fmt.Errorf("unknown provider selection %q", choice)
	}
	provider := config.ProviderConfig{
		Adapter: preset.Adapter, BaseURL: preset.BaseURL, DefaultModel: preset.DefaultModel,
		AllowPrivateNetwork: preset.AllowPrivateNetworkDefault, AuthMode: string(preset.AuthKind),
		CodexAccountMode: preset.CodexAccountMode, LiveModels: boolPointer(preset.LiveModels),
	}
	for _, model := range preset.Models {
		provider.Models = append(provider.Models, model.ID)
	}
	if strings.Contains(provider.BaseURL, "{") {
		resolved, err := readInitPrompt(reader, writer, "Resolved endpoint URL (replace placeholders): ")
		if err != nil || resolved == "" {
			return "", provider, false, fmt.Errorf("a resolved endpoint URL is required")
		}
		provider.BaseURL = resolved
	}
	if preset.AuthKind == registry.AuthKey || preset.AuthKind == registry.AuthLocal {
		if preset.DashboardURL != "" {
			fmt.Fprintf(writer, "Get your key: %s\n", preset.DashboardURL)
		}
		key, err := readInitPrompt(reader, writer, "API key (blank uses the provider environment variable): ")
		if err != nil {
			return "", provider, false, err
		}
		if key != "" {
			provider.APIKey = key
		} else if preset.AuthKind == registry.AuthKey && !preset.KeyOptional {
			provider.APIKey = "${" + providerEnvKey(preset.ID) + "}"
		}
		model, err := readInitPrompt(reader, writer, fmt.Sprintf("Default model [%s]: ", preset.DefaultModel))
		if err != nil {
			return "", provider, false, err
		}
		if model != "" {
			provider.DefaultModel = model
		}
	}
	return preset.ID, provider, preset.AuthKind == registry.AuthOAuth, nil
}

func readCustomProvider(reader *bufio.Reader, writer io.Writer) (string, config.ProviderConfig, error) {
	name, err := readInitPrompt(reader, writer, "Provider name: ")
	if err != nil {
		return "", config.ProviderConfig{}, err
	}
	baseURL, err := readInitPrompt(reader, writer, "Base URL (for example http://localhost:11434/v1): ")
	if err != nil {
		return "", config.ProviderConfig{}, err
	}
	adapter, err := readInitPrompt(reader, writer, "Adapter [openai-chat]: ")
	if err != nil {
		return "", config.ProviderConfig{}, err
	}
	if adapter == "" {
		adapter = "openai-chat"
	}
	key, err := readInitPrompt(reader, writer, "API key (optional): ")
	if err != nil {
		return "", config.ProviderConfig{}, err
	}
	model, err := readInitPrompt(reader, writer, "Default model (optional): ")
	if err != nil {
		return "", config.ProviderConfig{}, err
	}
	provider := config.ProviderConfig{Adapter: adapter, BaseURL: baseURL, APIKey: key, DefaultModel: model, AuthMode: "key"}
	probe := config.Default()
	probe.DefaultProvider = name
	probe.Providers[name] = provider
	if err := probe.Validate(); err != nil {
		return "", config.ProviderConfig{}, err
	}
	return name, provider, nil
}

func readInitPrompt(reader *bufio.Reader, writer io.Writer, prompt string) (string, error) {
	fmt.Fprint(writer, prompt)
	value, err := reader.ReadString('\n')
	if err != nil && !(err == io.EOF && value != "") {
		return "", err
	}
	return strings.TrimSpace(value), nil
}

func providerEnvKey(id string) string {
	return strings.Trim(nonEnvKey.ReplaceAllString(strings.ToUpper(id), "_"), "_") + "_API_KEY"
}

func boolPointer(value bool) *bool { return &value }
