package codex

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"
)

const BundledCatalogCacheTTL = time.Minute

type BundledCatalogLoader struct {
	mu        sync.Mutex
	Command   string
	Now       func() time.Time
	Run       func(context.Context, string, ...string) ([]byte, error)
	cacheKey  string
	expiresAt time.Time
	cached    *RawCatalog
}

func NewBundledCatalogLoader(command string) *BundledCatalogLoader {
	return &BundledCatalogLoader{Command: command, Now: time.Now, Run: runBundledCatalogCommand}
}

func (loader *BundledCatalogLoader) Invalidate() {
	loader.mu.Lock()
	defer loader.mu.Unlock()
	loader.cacheKey, loader.expiresAt, loader.cached = "", time.Time{}, nil
}

func (loader *BundledCatalogLoader) Load(ctx context.Context) (RawCatalog, error) {
	loader.mu.Lock()
	defer loader.mu.Unlock()
	now := loader.Now
	if now == nil {
		now = time.Now
	}
	command := loader.Command
	if command == "" {
		command = "codex"
	}
	if loader.cacheKey == command && now().Before(loader.expiresAt) && loader.cached != nil {
		return cloneRawCatalog(*loader.cached), nil
	}
	run := loader.Run
	if run == nil {
		run = runBundledCatalogCommand
	}
	commandCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	data, err := run(commandCtx, command, "debug", "models", "--bundled")
	if err != nil {
		return RawCatalog{}, err
	}
	catalog, err := ParseRawCatalog(data)
	if err != nil {
		return RawCatalog{}, err
	}
	if !hasNativeCatalogTemplate(catalog) {
		return RawCatalog{}, errors.New("bundled Codex catalog has no native template")
	}
	copy := cloneRawCatalog(catalog)
	loader.cacheKey, loader.expiresAt, loader.cached = command, now().Add(BundledCatalogCacheTTL), &copy
	return cloneRawCatalog(catalog), nil
}

func (loader *BundledCatalogLoader) Materialize(ctx context.Context, path string) (RawCatalog, error) {
	catalog, err := loader.Load(ctx)
	if err != nil {
		return RawCatalog{}, err
	}
	data, err := json.MarshalIndent(catalog, "", "  ")
	if err != nil {
		return RawCatalog{}, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return RawCatalog{}, err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".catalog-*.tmp")
	if err != nil {
		return RawCatalog{}, err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return RawCatalog{}, err
	}
	if _, err := temporary.Write(append(data, '\n')); err != nil {
		temporary.Close()
		return RawCatalog{}, err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return RawCatalog{}, err
	}
	if err := temporary.Close(); err != nil {
		return RawCatalog{}, err
	}
	if err := atomicReplace(temporaryPath, path); err != nil {
		return RawCatalog{}, err
	}
	return catalog, nil
}

func runBundledCatalogCommand(ctx context.Context, command string, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, command, args...).Output()
}
func hasNativeCatalogTemplate(catalog RawCatalog) bool {
	for _, entry := range catalog.Models {
		slug, _ := entry["slug"].(string)
		if slug != "" && !containsSlash(slug) {
			if _, ok := entry["base_instructions"]; ok {
				return true
			}
		}
	}
	return false
}
func cloneRawCatalog(catalog RawCatalog) RawCatalog {
	data, _ := json.Marshal(catalog)
	var copy RawCatalog
	_ = json.Unmarshal(data, &copy)
	return copy
}
