package claude

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
)

type Desktop3pApplyResult struct {
	Written     bool   `json:"written"`
	Path        string `json:"path"`
	Fingerprint string `json:"fingerprint"`
}

type Desktop3pStatus struct {
	Applied           bool                `json:"applied"`
	AppliedAt         *string             `json:"appliedAt"`
	SavedFingerprint  *string             `json:"savedFingerprint"`
	OnDiskFingerprint *string             `json:"onDiskFingerprint"`
	ConfigPath        *string             `json:"configPath"`
	Stale             bool                `json:"stale"`
	Health            DesktopHealthStatus `json:"health"`
}

type desktopFileWriter func(path string, data []byte, mode os.FileMode) error

var desktopApplyMu sync.Mutex

func DefaultDesktop3pLibraryPath() (string, error) {
	if configured := strings.TrimSpace(os.Getenv("OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR")); configured != "" {
		return configured, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve home directory: %w", err)
	}
	if runtime.GOOS != "darwin" {
		return "", fmt.Errorf("Claude Desktop 3P config is supported only on macOS")
	}
	return filepath.Join(home, "Library", "Application Support", "Claude-3p", "configLibrary"), nil
}

func ApplyDesktop3pConfig(libraryPath string, port int, nativeSlugs []string, routed []Desktop3pRoutedModel, apiKey string, mode Desktop3pConfigMode, profile *DesktopProfile) (Desktop3pApplyResult, error) {
	return applyDesktop3pConfig(libraryPath, port, nativeSlugs, routed, apiKey, mode, profile, atomicWriteFile)
}

func PersistDesktop3pConfig(libraryPath string, port int, nativeSlugs []string, routed []Desktop3pRoutedModel, apiKey string, mode Desktop3pConfigMode) (string, error) {
	result, err := ApplyDesktop3pConfig(libraryPath, port, nativeSlugs, routed, apiKey, mode, nil)
	return result.Path, err
}

func applyDesktop3pConfig(libraryPath string, port int, nativeSlugs []string, routed []Desktop3pRoutedModel, apiKey string, mode Desktop3pConfigMode, profile *DesktopProfile, writer desktopFileWriter) (Desktop3pApplyResult, error) {
	if strings.TrimSpace(libraryPath) == "" {
		return Desktop3pApplyResult{}, fmt.Errorf("desktop config library path must not be blank")
	}
	desktopApplyMu.Lock()
	defer desktopApplyMu.Unlock()
	cfg, err := GenerateDesktop3pConfigWithProfile(port, nativeSlugs, routed, apiKey, mode, profile)
	if err != nil {
		return Desktop3pApplyResult{}, err
	}
	if err := os.MkdirAll(libraryPath, 0o700); err != nil {
		return Desktop3pApplyResult{}, fmt.Errorf("create desktop config library: %w", err)
	}
	metadataPath := filepath.Join(libraryPath, "_meta.json")
	metadata, entries, err := readDesktop3pMetadata(metadataPath)
	if err != nil {
		return Desktop3pApplyResult{}, err
	}
	id := desktopMetadataEntryID(entries)
	if id == "" {
		id, err = randomUUID()
		if err != nil {
			return Desktop3pApplyResult{}, err
		}
		entries = append(entries, map[string]any{"id": id, "name": "opencodex"})
	}
	metadata["appliedId"] = id
	metadata["entries"] = entries
	configData, err := marshalDesktopJSON(cfg)
	if err != nil {
		return Desktop3pApplyResult{}, fmt.Errorf("encode desktop config: %w", err)
	}
	metadataData, err := marshalDesktopJSON(metadata)
	if err != nil {
		return Desktop3pApplyResult{}, fmt.Errorf("encode desktop metadata: %w", err)
	}
	configPath := filepath.Join(libraryPath, id+".json")
	result := Desktop3pApplyResult{Path: configPath, Fingerprint: Desktop3pFingerprint(configData)}
	originalConfig, configExists, err := readOptionalFile(configPath)
	if err != nil {
		return result, fmt.Errorf("read existing desktop config: %w", err)
	}
	originalMetadata, metadataExists, err := readOptionalFile(metadataPath)
	if err != nil {
		return result, fmt.Errorf("read existing desktop metadata: %w", err)
	}
	configChanged := !configExists || !bytes.Equal(originalConfig, configData)
	metadataChanged := !metadataExists || !bytes.Equal(originalMetadata, metadataData)
	if !configChanged && !metadataChanged {
		return result, nil
	}
	if configChanged {
		if err := writer(configPath, configData, 0o600); err != nil {
			return result, fmt.Errorf("write desktop config: %w", err)
		}
	}
	if metadataChanged {
		if err := writer(metadataPath, metadataData, 0o600); err != nil {
			rollbackErr := rollbackDesktopConfig(configPath, originalConfig, configExists, configChanged)
			if rollbackErr != nil {
				return result, errors.Join(fmt.Errorf("write desktop metadata: %w", err), fmt.Errorf("rollback desktop config: %w", rollbackErr))
			}
			return result, fmt.Errorf("write desktop metadata: %w", err)
		}
	}
	result.Written = true
	return result, nil
}

func Desktop3pFingerprint(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])[:16]
}

func ReadDesktop3pStatus(libraryPath, savedFingerprint, appliedAt string) Desktop3pStatus {
	status := Desktop3pStatus{Applied: savedFingerprint != "", Health: GetDesktopHealth()}
	if savedFingerprint != "" {
		status.SavedFingerprint = stringPointer(savedFingerprint)
	}
	if appliedAt != "" {
		status.AppliedAt = stringPointer(appliedAt)
	}
	_, entries, err := readDesktop3pMetadata(filepath.Join(libraryPath, "_meta.json"))
	if err == nil {
		id := desktopMetadataEntryID(entries)
		if id != "" {
			path := filepath.Join(libraryPath, id+".json")
			if data, readErr := os.ReadFile(path); readErr == nil {
				fingerprint := Desktop3pFingerprint(data)
				status.ConfigPath = stringPointer(path)
				status.OnDiskFingerprint = stringPointer(fingerprint)
			}
		}
	}
	status.Stale = status.SavedFingerprint != nil && status.OnDiskFingerprint != nil && *status.SavedFingerprint != *status.OnDiskFingerprint
	return status
}

func ValidateDesktopProfileAvailability(current, next DesktopProfile, unavailableRoutes []string) error {
	parsedCurrent, err := ParseDesktopProfile(current)
	if err != nil {
		return err
	}
	parsedNext, err := ParseDesktopProfile(next)
	if err != nil {
		return err
	}
	unavailable := make(map[string]bool, len(unavailableRoutes))
	for _, route := range unavailableRoutes {
		unavailable[route] = true
		if parsedCurrent.Assignments[route] != parsedNext.Assignments[route] {
			return fmt.Errorf("currently unavailable desktop route cannot be changed: %s", route)
		}
	}
	for _, family := range desktopFamilies {
		before, after := parsedCurrent.Defaults[family], parsedNext.Defaults[family]
		if equalStringPointers(before, after) || after == nil {
			continue
		}
		if unavailable[*after] {
			return fmt.Errorf("currently unavailable desktop route cannot become a default: %s", *after)
		}
	}
	return nil
}

func readDesktop3pMetadata(path string) (map[string]any, []map[string]any, error) {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return map[string]any{}, []map[string]any{}, nil
	}
	if err != nil {
		return nil, nil, fmt.Errorf("read desktop metadata: %w", err)
	}
	var metadata map[string]any
	if err := json.Unmarshal(data, &metadata); err != nil {
		return nil, nil, fmt.Errorf("decode desktop metadata: %w", err)
	}
	rawEntries, ok := metadata["entries"].([]any)
	if !ok {
		return nil, nil, fmt.Errorf("Claude Desktop _meta.json has no entries array")
	}
	entries := make([]map[string]any, 0, len(rawEntries))
	for _, raw := range rawEntries {
		entry, ok := raw.(map[string]any)
		if !ok {
			return nil, nil, fmt.Errorf("Claude Desktop _meta.json contains an invalid entry")
		}
		entries = append(entries, entry)
	}
	return metadata, entries, nil
}

func desktopMetadataEntryID(entries []map[string]any) string {
	for _, entry := range entries {
		if entry["name"] == "opencodex" {
			if id, ok := entry["id"].(string); ok && id != "" {
				return id
			}
		}
	}
	return ""
}

func marshalDesktopJSON(value any) ([]byte, error) {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(data, '\n'), nil
}

func readOptionalFile(path string) ([]byte, bool, error) {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil, false, nil
	}
	return data, err == nil, err
}

func rollbackDesktopConfig(path string, original []byte, existed, changed bool) error {
	if !changed {
		return nil
	}
	if existed {
		return atomicWriteFile(path, original, 0o600)
	}
	err := os.Remove(path)
	if os.IsNotExist(err) {
		return nil
	}
	return err
}

func equalStringPointers(left, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func randomUUID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", fmt.Errorf("generate desktop config id: %w", err)
	}
	value[6] = (value[6] & 0x0f) | 0x40
	value[8] = (value[8] & 0x3f) | 0x80
	hexValue := hex.EncodeToString(value[:])
	return hexValue[:8] + "-" + hexValue[8:12] + "-" + hexValue[12:16] + "-" + hexValue[16:20] + "-" + hexValue[20:], nil
}

// atomicWriteFile intentionally mirrors the package-local codex writer. Keeping
// the implementation local avoids a cross-package dependency for user config writes.
func atomicWriteFile(path string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".ocx-*.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer func() {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
	}()
	if err := tmp.Chmod(mode); err != nil {
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		return err
	}
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return atomicReplace(tmpPath, path)
}
