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
	if len(args) != 0 {
		return fmt.Errorf("usage: ocx sync")
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
	models, err := fetchRuntimeModels(ctx, runtimeCfg, port)
	if err != nil {
		return err
	}
	codexHome := codexHomePath()
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
	configPath := filepath.Join(codexHome, "config.toml")
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
	if err := codex.InvalidateCodexModelsCache(catalogPath, filepath.Join(codexHome, "models_cache.json")); err != nil {
		return err
	}
	fmt.Fprintf(streams.Out, "Synced %d model(s) to Codex.\n", len(models))
	return nil
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
	var payload struct {
		Models []types.ModelEntry `json:"models"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 16<<20)).Decode(&payload); err != nil {
		return nil, err
	}
	return payload.Models, nil
}
