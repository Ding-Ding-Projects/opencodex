package cli

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/oauth"
)

func keyProvider(name string) bool {
	cfg, _, err := loadConfig()
	if err != nil {
		return false
	}
	provider, ok := cfg.Providers[name]
	return ok && config.IsKeyAuthProvider(provider)
}

func loadKeyConfig(name string) (*config.Config, string, error) {
	cfg, path, err := loadConfig()
	if err != nil {
		return nil, "", err
	}
	provider, ok := cfg.Providers[name]
	if !ok {
		return nil, "", fmt.Errorf("provider %q is not configured", name)
	}
	if !config.IsKeyAuthProvider(provider) {
		return nil, "", fmt.Errorf("provider %q does not use API-key auth", name)
	}
	return cfg, path, nil
}

func accountKeyList(name string, jsonOutput bool, streams IO) error {
	cfg, _, err := loadKeyConfig(name)
	if err != nil {
		return err
	}
	activeID, keys := config.ListAPIKeys(cfg, name)
	if jsonOutput {
		return writePrettyJSON(streams.Out, map[string]any{"provider": name, "activeId": nullableString(activeID), "keys": keys})
	}
	if len(keys) == 0 {
		fmt.Fprintf(streams.Out, "%s: no stored API keys\n", name)
		return nil
	}
	for _, key := range keys {
		marker := " "
		if key.Active {
			marker = "*"
		}
		label := key.Label
		if label != "" {
			label = " (" + label + ")"
		}
		fmt.Fprintf(streams.Out, "%s %-8s  %s%s\n", marker, key.ID, key.Masked, label)
	}
	return nil
}

func accountKeyCurrent(name string, jsonOutput bool, streams IO) error {
	cfg, _, err := loadKeyConfig(name)
	if err != nil {
		return err
	}
	activeID, keys := config.ListAPIKeys(cfg, name)
	for _, key := range keys {
		if key.ID != activeID {
			continue
		}
		if jsonOutput {
			return writePrettyJSON(streams.Out, map[string]any{"provider": name, "activeId": activeID, "key": key})
		}
		fmt.Fprintf(streams.Out, "%s: %s %s\n", name, key.ID, key.Masked)
		return nil
	}
	return fmt.Errorf("no API keys for %s", name)
}

func accountKeyUse(name, id string, jsonOutput bool, streams IO) error {
	cfg, path, err := loadKeyConfig(name)
	if err != nil {
		return err
	}
	if !config.SetActiveAPIKey(cfg, name, id) {
		return fmt.Errorf("API key %q was not found for %s", id, name)
	}
	if err := config.Save(path, cfg); err != nil {
		return err
	}
	if jsonOutput {
		return writePrettyJSON(streams.Out, map[string]any{"ok": true, "provider": name, "activeId": id})
	}
	fmt.Fprintf(streams.Out, "Active %s API key: %s\n", name, id)
	return nil
}

func accountKeyRemove(name, id string, jsonOutput bool, streams IO) error {
	cfg, path, err := loadKeyConfig(name)
	if err != nil {
		return err
	}
	if !config.RemoveAPIKey(cfg, name, id) {
		return fmt.Errorf("API key %q was not found for %s", id, name)
	}
	if err := config.Save(path, cfg); err != nil {
		return err
	}
	activeID, keys := config.ListAPIKeys(cfg, name)
	if jsonOutput {
		return writePrettyJSON(streams.Out, map[string]any{"ok": true, "provider": name, "id": id, "remaining": len(keys), "activeId": nullableString(activeID)})
	}
	if len(keys) == 0 {
		fmt.Fprintf(streams.Out, "%s: no keys remaining\n", name)
	} else {
		fmt.Fprintf(streams.Out, "%s: active key is now %s\n", name, activeID)
	}
	return nil
}

func accountAddKey(args []string, streams IO) error {
	jsonOutput, rest := consumeBoolFlag(args, "--json")
	label, rest, err := consumeValueFlag(rest, "--label")
	if err != nil || len(rest) != 1 {
		return fmt.Errorf("usage: ocx account add-key <provider> [--label LABEL] [--json]")
	}
	name := normalizeAccountProvider(rest[0])
	reader := bufio.NewReader(io.LimitReader(streams.In, 1<<20))
	key, readErr := reader.ReadString('\n')
	if readErr != nil && readErr != io.EOF {
		return fmt.Errorf("read API key from stdin: %w", readErr)
	}
	key = strings.TrimSpace(key)
	if key == "" {
		return fmt.Errorf("API key input was empty")
	}
	cfg, path, err := loadKeyConfig(name)
	if err != nil {
		return err
	}
	id, err := config.AddAPIKey(cfg, name, key, label, time.Now())
	if err != nil {
		return err
	}
	if err := config.Save(path, cfg); err != nil {
		return err
	}
	if jsonOutput {
		return writePrettyJSON(streams.Out, map[string]any{"ok": true, "id": id, "label": nullableString(strings.TrimSpace(label))})
	}
	fmt.Fprintf(streams.Out, "%s: added API key %s\n", name, id)
	return nil
}

func accountAlias(ctx context.Context, store *oauth.CredentialStore, args []string, streams IO) error {
	jsonOutput, rest := consumeBoolFlag(args, "--json")
	if len(rest) != 3 {
		return fmt.Errorf("usage: ocx account alias <provider> <id> <display-name|-> [--json]")
	}
	name, id, alias := normalizeAccountProvider(rest[0]), rest[1], strings.TrimSpace(rest[2])
	if alias == "-" {
		alias = ""
	}
	if len(alias) > 80 || strings.ContainsAny(alias, "\x00\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0a\x0b\x0c\x0d\x0e\x0f\x10\x11\x12\x13\x14\x15\x16\x17\x18\x19\x1a\x1b\x1c\x1d\x1e\x1f\x7f") {
		return fmt.Errorf("alias must be at most 80 printable characters")
	}
	if keyProvider(name) {
		cfg, path, err := loadKeyConfig(name)
		if err != nil {
			return err
		}
		if !config.SetAPIKeyLabel(cfg, name, id, alias) {
			return fmt.Errorf("API key %q was not found for %s", id, name)
		}
		if err := config.Save(path, cfg); err != nil {
			return err
		}
	} else {
		found, err := store.SetAccountAlias(ctx, name, id, alias)
		if err != nil {
			return err
		}
		if !found {
			return fmt.Errorf("account %q was not found for %s", id, name)
		}
	}
	if jsonOutput {
		return writePrettyJSON(streams.Out, map[string]any{"ok": true, "provider": name, "id": id, "alias": nullableString(alias)})
	}
	if alias == "" {
		fmt.Fprintf(streams.Out, "%s: cleared alias for %s\n", name, id)
	} else {
		fmt.Fprintf(streams.Out, "%s: %s is now %q\n", name, id, alias)
	}
	return nil
}
