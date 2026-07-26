package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/providers"
)

var validProviderName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

const providerUsage = `Usage: ocx provider <subcommand>

Subcommands:
  list [--json]             List configured and available providers
  add <name> [options]      Add a registry or custom provider
  remove <name> [--json]    Remove a non-default provider
  show <name> [--json]      Show provider config with secrets masked
  set-default <name>        Change the default provider
  test <name> [--json]      Test via the running proxy`

func configDir() (string, error) {
	if value := strings.TrimSpace(os.Getenv("OPENCODEX_HOME")); value != "" {
		if value == "~" || strings.HasPrefix(value, "~/") {
			home, err := os.UserHomeDir()
			if err != nil {
				return "", err
			}
			value = filepath.Join(home, strings.TrimPrefix(strings.TrimPrefix(value, "~"), "/"))
		}
		return filepath.Abs(value)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".opencodex"), nil
}

func configPath() (string, error) {
	dir, err := configDir()
	return filepath.Join(dir, "config.json"), err
}

func loadConfig() (*config.Config, string, error) {
	path, err := configPath()
	if err != nil {
		return nil, "", err
	}
	cfg, err := loadConfigFile(path, os.Stderr)
	return cfg, path, err
}

func loadConfigFile(path string, warning io.Writer) (*config.Config, error) {
	cfg, err := config.LoadMigrated(path)
	if os.IsNotExist(err) || err != nil && strings.Contains(strings.ToLower(err.Error()), "no such file") {
		defaults := config.FreshInstall()
		return &defaults, nil
	}
	if err == nil {
		return cfg, nil
	}
	backup, backupErr := config.BackupInvalidConfig(path, time.Now())
	if warning != nil {
		backupNote := ""
		if backupErr == nil {
			backupNote = " A backup was written to " + backup + "."
		}
		fmt.Fprintf(warning, "Could not load opencodex config at %s: %v. Using default config.%s\n", path, err, backupNote)
	}
	defaults := config.FreshInstall()
	return &defaults, nil
}

func runProvider(args []string, streams IO) error {
	if len(args) == 0 || args[0] == "help" || args[0] == "--help" || args[0] == "-h" {
		_, err := fmt.Fprintln(streams.Out, providerUsage)
		return err
	}
	switch args[0] {
	case "list":
		return providerList(args[1:], streams)
	case "add":
		return providerAdd(args[1:], streams)
	case "remove":
		return providerRemove(args[1:], streams)
	case "show":
		return providerShow(args[1:], streams)
	case "default", "set-default":
		return providerSetDefault(args[1:], streams)
	case "test":
		return providerTest(args[1:], streams)
	default:
		return fmt.Errorf("unknown provider subcommand %q\n%s", args[0], providerUsage)
	}
}

type providerAddOptions struct {
	Name, Adapter, BaseURL, APIKey, DefaultModel string
	AllowPrivate, SetDefault, Force, JSON        bool
}

func parseProviderAdd(args []string) (providerAddOptions, error) {
	options := providerAddOptions{}
	for index := 0; index < len(args); index++ {
		arg := args[index]
		switch arg {
		case "--allow-private-network":
			options.AllowPrivate = true
		case "--set-default":
			options.SetDefault = true
		case "--force":
			options.Force = true
		case "--json":
			options.JSON = true
		case "--adapter", "--base-url", "--api-key", "--default-model", "--model":
			if index+1 >= len(args) {
				return options, fmt.Errorf("%s requires a value", arg)
			}
			index++
			value := strings.TrimSpace(args[index])
			switch arg {
			case "--adapter":
				options.Adapter = value
			case "--base-url":
				options.BaseURL = value
			case "--api-key":
				options.APIKey = value
			default:
				options.DefaultModel = value
			}
		default:
			if strings.HasPrefix(arg, "-") {
				return options, fmt.Errorf("unknown provider add flag %q", arg)
			}
			if options.Name != "" {
				return options, fmt.Errorf("unexpected provider add argument %q", arg)
			}
			options.Name = strings.TrimSpace(arg)
		}
	}
	if options.Name == "" {
		return options, fmt.Errorf("usage: ocx provider add <name> [--adapter NAME --base-url URL]")
	}
	if !validProviderName.MatchString(options.Name) || options.Name == "constructor" || options.Name == "prototype" || options.Name == "__proto__" {
		return options, fmt.Errorf("invalid provider name %q", options.Name)
	}
	return options, nil
}

func providerAdd(args []string, streams IO) error {
	options, err := parseProviderAdd(args)
	if err != nil {
		return err
	}
	cfg, path, err := loadConfig()
	if err != nil {
		return err
	}
	if _, exists := cfg.Providers[options.Name]; exists && !options.Force {
		return fmt.Errorf("provider %q already exists; use --force to overwrite", options.Name)
	}
	provider := config.ProviderConfig{Adapter: options.Adapter, BaseURL: options.BaseURL, APIKey: options.APIKey, DefaultModel: options.DefaultModel}
	registryEntry, registered := providers.GetProviderRegistryEntry(options.Name)
	if registered {
		seed := providers.ProviderConfigSeed(registryEntry)
		provider = configProviderFromSeed(seed)
		if options.Adapter != "" {
			provider.Adapter = options.Adapter
		}
		if options.BaseURL != "" {
			if !registryEntry.AllowBaseURLOverride {
				return fmt.Errorf("provider %q does not allow a base URL override", options.Name)
			}
			provider.BaseURL = options.BaseURL
		}
		if options.DefaultModel != "" {
			provider.DefaultModel = options.DefaultModel
		}
		if options.APIKey != "" {
			if registryEntry.AuthKind == providers.AuthOAuth || registryEntry.AuthKind == providers.AuthForward {
				fmt.Fprintf(streams.Err, "Warning: provider %q uses %s authentication; --api-key is ignored.\n", options.Name, registryEntry.AuthKind)
			} else {
				provider.APIKey = options.APIKey
			}
		}
	} else if provider.Adapter == "" || provider.BaseURL == "" {
		return fmt.Errorf("custom providers require --adapter and --base-url")
	}
	provider.AllowPrivateNetwork = provider.AllowPrivateNetwork || options.AllowPrivate
	if cfg.Providers == nil {
		cfg.Providers = make(map[string]config.ProviderConfig)
	}
	cfg.Providers[options.Name] = provider
	if options.SetDefault || len(cfg.Providers) == 1 && cfg.DefaultProvider == "openai" {
		cfg.DefaultProvider = options.Name
	}
	if err := config.Save(path, cfg); err != nil {
		return err
	}
	if options.JSON {
		return writePrettyJSON(streams.Out, map[string]any{"action": "added", "provider": options.Name, "adapter": provider.Adapter, "baseUrl": provider.BaseURL, "defaultModel": nullableString(provider.DefaultModel), "isDefault": cfg.DefaultProvider == options.Name, "source": map[bool]string{true: "registry", false: "custom"}[registered], "needsSync": true})
	}
	fmt.Fprintf(streams.Out, "Configured provider %s.\n", options.Name)
	if registered && registryEntry.AuthKind == providers.AuthOAuth {
		fmt.Fprintf(streams.Out, "Authenticate with: ocx login %s\n", options.Name)
	}
	return nil
}

func providerRemove(args []string, streams IO) error {
	jsonOutput, rest := consumeBoolFlag(args, "--json")
	if len(rest) != 1 {
		return fmt.Errorf("usage: ocx provider remove <name> [--json]")
	}
	name := rest[0]
	cfg, path, err := loadConfig()
	if err != nil {
		return err
	}
	if _, ok := cfg.Providers[name]; !ok {
		return fmt.Errorf("provider %q is not configured", name)
	}
	if name == cfg.DefaultProvider {
		return fmt.Errorf("cannot remove %q because it is the default provider; change the default first", name)
	}
	if len(cfg.Providers) <= 1 {
		return fmt.Errorf("cannot remove the last provider")
	}
	delete(cfg.Providers, name)
	if err := config.Save(path, cfg); err != nil {
		return err
	}
	if jsonOutput {
		return writePrettyJSON(streams.Out, map[string]any{"action": "removed", "provider": name, "remainingProviders": sortedProviderNames(cfg.Providers), "defaultProvider": cfg.DefaultProvider, "needsSync": true})
	}
	fmt.Fprintf(streams.Out, "Removed provider %s.\n", name)
	return nil
}

func providerSetDefault(args []string, streams IO) error {
	jsonOutput, rest := consumeBoolFlag(args, "--json")
	if len(rest) != 1 {
		return fmt.Errorf("usage: ocx provider set-default <name> [--json]")
	}
	cfg, path, err := loadConfig()
	if err != nil {
		return err
	}
	if _, ok := cfg.Providers[rest[0]]; !ok {
		return fmt.Errorf("provider %q is not configured", rest[0])
	}
	action := "set-default"
	if cfg.DefaultProvider == rest[0] {
		action = "noop"
	} else {
		cfg.DefaultProvider = rest[0]
		if err := config.Save(path, cfg); err != nil {
			return err
		}
	}
	if jsonOutput {
		return writePrettyJSON(streams.Out, map[string]any{"action": action, "provider": rest[0], "defaultProvider": rest[0], "needsSync": action != "noop"})
	}
	if action == "noop" {
		fmt.Fprintf(streams.Out, "%q is already the default provider.\n", rest[0])
	} else {
		fmt.Fprintf(streams.Out, "Default provider set to %s.\n", rest[0])
	}
	return nil
}

func providerTest(args []string, streams IO) error {
	jsonOutput, rest := consumeBoolFlag(args, "--json")
	if len(rest) != 1 {
		return fmt.Errorf("usage: ocx provider test <name> [--json]")
	}
	cfg, _, err := loadConfig()
	if err != nil {
		return err
	}
	if _, ok := cfg.Providers[rest[0]]; !ok {
		return fmt.Errorf("provider %q is not configured", rest[0])
	}
	_, port := readRuntime()
	if port <= 0 {
		return fmt.Errorf("proxy is not running; start it before testing a provider")
	}
	endpoint := serviceBaseURLAt(*cfg, port) + "/api/providers/test?" + url.Values{"name": {rest[0]}}.Encode()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader([]byte(`{}`)))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	if token := strings.TrimSpace(os.Getenv("OPENCODEX_API_AUTH_TOKEN")); token != "" {
		request.Header.Set("X-OpenCodex-API-Key", token)
	} else if cfg.AuthToken != "" {
		request.Header.Set("X-OpenCodex-API-Key", cfg.AuthToken)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return fmt.Errorf("provider test request: %w", err)
	}
	defer response.Body.Close()
	var result struct {
		OK     bool   `json:"ok"`
		Models int    `json:"models"`
		Error  string `json:"error"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&result); err != nil {
		return fmt.Errorf("decode provider test response: %w", err)
	}
	if jsonOutput {
		return writePrettyJSON(streams.Out, map[string]any{"provider": rest[0], "status": response.StatusCode, "ok": result.OK, "models": result.Models, "error": nullableString(result.Error)})
	}
	if !result.OK || response.StatusCode < 200 || response.StatusCode >= 300 {
		if result.Error == "" {
			result.Error = response.Status
		}
		return fmt.Errorf("provider %s test failed: %s", rest[0], result.Error)
	}
	fmt.Fprintf(streams.Out, "Provider %s is reachable (%d model(s)).\n", rest[0], result.Models)
	return nil
}

func consumeBoolFlag(args []string, flag string) (bool, []string) {
	found := false
	rest := make([]string, 0, len(args))
	for _, arg := range args {
		if arg == flag {
			found = true
		} else {
			rest = append(rest, arg)
		}
	}
	return found, rest
}
