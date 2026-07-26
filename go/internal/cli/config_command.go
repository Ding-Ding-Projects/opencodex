package cli

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/config"
)

func runConfig(args []string, streams IO) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: ocx config <path|show|get|set|unset|validate>")
	}
	path, err := configPath()
	if err != nil {
		return err
	}
	switch args[0] {
	case "path":
		if len(args) != 1 {
			return fmt.Errorf("usage: ocx config path")
		}
		_, err = fmt.Fprintln(streams.Out, path)
		return err
	case "show":
		if len(args) != 1 && !(len(args) == 2 && args[1] == "--json") {
			return fmt.Errorf("usage: ocx config show [--json]")
		}
		cfg, _, loadErr := loadConfig()
		if loadErr != nil {
			return loadErr
		}
		return writeConfigJSON(streams.Out, redactedConfig(*cfg))
	case "validate":
		if len(args) != 1 {
			return fmt.Errorf("usage: ocx config validate")
		}
		if _, err := config.Load(path); err != nil {
			if os.IsNotExist(err) {
				return fmt.Errorf("config file does not exist: %s", path)
			}
			return err
		}
		fmt.Fprintln(streams.Out, "Configuration is valid.")
		return nil
	case "get":
		if len(args) != 2 {
			return fmt.Errorf("usage: ocx config get <port|hostname|defaultProvider|streamMode>")
		}
		cfg, _, loadErr := loadConfig()
		if loadErr != nil {
			return loadErr
		}
		value, valueErr := configValue(*cfg, args[1])
		if valueErr != nil {
			return valueErr
		}
		fmt.Fprintln(streams.Out, value)
		return nil
	case "set":
		if len(args) != 3 {
			return fmt.Errorf("usage: ocx config set <port|hostname|defaultProvider|streamMode> <value>")
		}
		cfg, _, loadErr := loadConfig()
		if loadErr != nil {
			return loadErr
		}
		if err := setConfigValue(cfg, args[1], args[2]); err != nil {
			return err
		}
		if err := config.Save(path, cfg); err != nil {
			return err
		}
		fmt.Fprintf(streams.Out, "Updated %s.\n", args[1])
		return nil
	case "unset":
		if len(args) != 2 {
			return fmt.Errorf("usage: ocx config unset <streamMode>")
		}
		cfg, _, loadErr := loadConfig()
		if loadErr != nil {
			return loadErr
		}
		if args[1] != "streamMode" {
			return fmt.Errorf("config key %q cannot be unset", args[1])
		}
		cfg.StreamMode = "auto"
		if err := config.Save(path, cfg); err != nil {
			return err
		}
		fmt.Fprintln(streams.Out, "Reset streamMode to auto.")
		return nil
	default:
		return fmt.Errorf("unknown config subcommand %q", args[0])
	}
}

func configValue(cfg config.Config, key string) (any, error) {
	switch key {
	case "port":
		return cfg.Port, nil
	case "hostname", "host":
		return cfg.Host, nil
	case "defaultProvider":
		return cfg.DefaultProvider, nil
	case "streamMode":
		return cfg.StreamMode, nil
	default:
		return nil, fmt.Errorf("unsupported config key %q", key)
	}
}

func setConfigValue(cfg *config.Config, key, value string) error {
	value = strings.TrimSpace(value)
	switch key {
	case "port":
		port, err := strconv.Atoi(value)
		if err != nil {
			return fmt.Errorf("port must be an integer: %w", err)
		}
		cfg.Port = port
	case "hostname", "host":
		cfg.Host = value
	case "defaultProvider":
		if value != "openai" {
			if _, ok := cfg.Providers[value]; !ok {
				return fmt.Errorf("provider %q is not configured", value)
			}
		}
		cfg.DefaultProvider = value
	case "streamMode":
		cfg.StreamMode = value
	default:
		return fmt.Errorf("unsupported config key %q", key)
	}
	return cfg.Validate()
}

func redactedConfig(cfg config.Config) config.Config {
	cfg.AuthToken = redactValue(cfg.AuthToken)
	cfg.ExtraFields = config.RedactRawFields(cfg.ExtraFields)
	for name, provider := range cfg.Providers {
		provider.APIKey = redactValue(provider.APIKey)
		provider.ExtraFields = config.RedactRawFields(provider.ExtraFields)
		for key, value := range provider.Headers {
			if strings.Contains(strings.ToLower(key), "auth") || strings.Contains(strings.ToLower(key), "key") || strings.Contains(strings.ToLower(key), "token") {
				provider.Headers[key] = redactValue(value)
			}
		}
		cfg.Providers[name] = provider
	}
	return cfg
}

func redactValue(value string) string {
	if strings.TrimSpace(value) == "" {
		return ""
	}
	return "[REDACTED]"
}

func writeConfigJSON(writer interface{ Write([]byte) (int, error) }, value any) error {
	encoder := json.NewEncoder(writer)
	encoder.SetIndent("", "  ")
	return encoder.Encode(value)
}
