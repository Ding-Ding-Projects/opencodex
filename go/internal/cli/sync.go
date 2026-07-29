package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/codex"
	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

func runSync(ctx context.Context, args []string, streams IO) error {
	restartCodex, err := parseRestartCodexFlag("ocx sync", args)
	if err != nil {
		return err
	}
	cfg, _, err := loadConfig()
	if err != nil {
		return err
	}
	runtimeCfg, err := config.ResolveEnvironment(*cfg)
	if err != nil {
		return err
	}
	_, port := readRuntime()
	if port <= 0 || !probeHealth(ctx, runtimeCfg.Host, port) {
		return errors.New("no running proxy found; run 'ocx start' first")
	}
	codexHome := codexHomePath()
	configPath := filepath.Join(codexHome, "config.toml")
	if data, readErr := os.ReadFile(configPath); readErr == nil {
		if external := codex.ExternalCodexModelProvider(string(data)); external != "" {
			if _, err := codex.InjectCodexConfig(configPath, codex.InjectOptions{
				Port: port, Hostname: runtimeCfg.Host,
				SupportsWebSockets:   runtimeCfg.WebSockets,
				IncludeAPIAuthHeader: codex.ShouldInjectAPIAuthHeader(runtimeCfg.Host),
			}); err != nil {
				return err
			}
			reportCodexHomeTarget(streams, collectCodexHomeDiagnostic)
			fmt.Fprintf(streams.Out, "Preserved external Codex provider %q; skipped catalog sync.\n", external)
			return nil
		}
	} else if !errors.Is(readErr, os.ErrNotExist) {
		return fmt.Errorf("read Codex config: %w", readErr)
	}
	models, err := fetchRuntimeModels(ctx, runtimeCfg, port)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(codexHome, 0o700); err != nil {
		return err
	}
	catalogPath := filepath.Join(codexHome, "opencodex-catalog.json")
	catalog, err := codex.ReadRawCatalog(catalogPath)
	if errors.Is(err, os.ErrNotExist) {
		catalog, err = codex.NewBundledCatalogLoader("codex").Materialize(ctx, catalogPath)
	}
	if err != nil {
		return fmt.Errorf("load Codex catalog: %w", err)
	}
	configHome, err := configDir()
	if err != nil {
		return err
	}
	backupPath := codex.CatalogBackupPathFor(catalogPath, configHome)
	if err := codex.EnsureCatalogBackup(catalogPath, backupPath, catalog); err != nil {
		return err
	}
	catalogModels := make([]codex.CatalogModel, 0, len(models))
	gathered := make(map[string]bool)
	for _, model := range models {
		gathered[model.Provider] = true
		catalogModels = append(catalogModels, codex.CatalogModel{
			ID: model.ID, Provider: model.Provider, DisplayName: model.DisplayName,
			Metadata: map[string]any{"reasoning_efforts": model.ReasoningEfforts, "context_window": model.ContextWindow},
		})
	}
	options := codex.CatalogBuildOptions{MultiAgentMode: runtimeCfg.MultiAgentMode, Featured: runtimeCfg.SubagentModels, WebSockets: runtimeCfg.WebSockets}
	fresh := codex.BuildCatalogEntries(codex.FindNativeCatalogTemplate(catalog), catalogModels, options)
	merged := codex.MergeCatalogEntriesWithPolicy(catalog.Models, fresh, codex.CatalogMergePolicy{
		CatalogBuildOptions: options, NativeBaseline: codex.ReadNativeBaseline(backupPath), GatheredProviders: gathered,
		Template: codex.FindNativeCatalogTemplate(catalog),
	})
	if err := codex.SyncCatalogModels(catalogPath, codex.RawCatalog{Models: merged}); err != nil {
		return err
	}
	if _, err := os.Stat(configPath); errors.Is(err, os.ErrNotExist) {
		if err := os.WriteFile(configPath, nil, 0o600); err != nil {
			return err
		}
	}
	if _, err := codex.InjectCodexConfig(configPath, codex.InjectOptions{
		Port: port, Hostname: runtimeCfg.Host, CatalogPath: catalogPath,
		SupportsWebSockets:   runtimeCfg.WebSockets,
		IncludeAPIAuthHeader: codex.ShouldInjectAPIAuthHeader(runtimeCfg.Host),
	}); err != nil {
		return err
	}
	reportCodexHomeTarget(streams, collectCodexHomeDiagnostic)
	if err := codex.InvalidateCodexModelsCache(catalogPath, filepath.Join(codexHome, "models_cache.json")); err != nil {
		return err
	}
	// The catalog and cache were both rewritten by this point, which is exactly when a
	// long-lived app-server is still serving the old model list from memory.
	codex.AfterCatalogWriteHandleAppServers(codex.AfterCatalogWriteAppServerOptions{
		Restart: restartCodex, Log: streamLogger(streams),
	})
	fmt.Fprintf(streams.Out, "Synced %d model(s) to Codex.\n", len(models))
	return nil
}

// parseRestartCodexFlag accepts the oracle's only sync flag and rejects anything else, so
// `ocx sync --restart-codex` stops being a usage error the root help advertises.
func parseRestartCodexFlag(usage string, args []string) (bool, error) {
	restart := false
	for _, arg := range args {
		if arg == "--restart-codex" {
			restart = true
			continue
		}
		return false, fmt.Errorf("usage: %s [--restart-codex]", usage)
	}
	return restart, nil
}

// streamLogger adapts the CLI streams to the app-server progress logger: normal progress on
// stdout, warnings and failures on stderr, matching the oracle's console.log/console.error.
func streamLogger(streams IO) codex.AppServerLogger { return cliAppServerLogger{streams: streams} }

type cliAppServerLogger struct{ streams IO }

func (l cliAppServerLogger) Log(message string)   { writeLine(l.streams.Out, message) }
func (l cliAppServerLogger) Error(message string) { writeLine(l.streams.Err, message) }

// writeLine tolerates an unset stream: callers that only capture stdout (or nothing) must not
// crash the sync just because an app-server warning had nowhere to go.
func writeLine(writer io.Writer, message string) {
	if writer == nil {
		return
	}
	fmt.Fprintln(writer, message)
}

func reportCodexHomeTarget(streams IO, collect func() codex.OrcaCodexHomeDiagnostic) {
	diagnostic := collect()
	fmt.Fprintf(streams.Out, "   Target Codex home: %s\n", diagnostic.EffectiveCodexHome)
	if diagnostic.Warning != nil {
		fmt.Fprintf(streams.Err, "WARNING: %s\n", *diagnostic.Warning)
		if diagnostic.Action != nil {
			fmt.Fprintf(streams.Err, "Action: %s\n", *diagnostic.Action)
		}
	}
}

func collectCodexHomeDiagnostic() codex.OrcaCodexHomeDiagnostic {
	home, _ := os.UserHomeDir()
	return codex.CollectOrcaCodexHomeDiagnostic(codex.OrcaCodexHomeOptions{HomeOptions: codex.HomeOptions{HomeDir: home}})
}

func fetchRuntimeModels(parent context.Context, cfg config.Config, port int) ([]types.ModelEntry, error) {
	ctx, cancel := context.WithTimeout(parent, 30*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, serviceBaseURLAt(cfg, port)+"/api/models", nil)
	if err != nil {
		return nil, err
	}
	if cfg.AuthToken != "" {
		request.Header.Set("X-OpenCodex-API-Key", cfg.AuthToken)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return nil, fmt.Errorf("model catalog request failed: %s: %s", response.Status, body)
	}
	// The management response IS the row array; `namespaced` is the routed selector
	// that ModelEntry.ID carries internally.
	var rows []struct {
		Provider         string   `json:"provider"`
		Namespaced       string   `json:"namespaced"`
		DisplayName      string   `json:"displayName"`
		ReasoningEfforts []string `json:"reasoningEfforts"`
		ContextWindow    int      `json:"contextWindow"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 16<<20)).Decode(&rows); err != nil {
		return nil, err
	}
	models := make([]types.ModelEntry, 0, len(rows))
	for _, row := range rows {
		models = append(models, types.ModelEntry{
			ID: row.Namespaced, Provider: row.Provider, DisplayName: row.DisplayName,
			ReasoningEfforts: row.ReasoningEfforts, ContextWindow: row.ContextWindow,
		})
	}
	return models, nil
}
