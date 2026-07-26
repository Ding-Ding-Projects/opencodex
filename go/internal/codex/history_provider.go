package codex

import (
	"bufio"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

type CodexHistoryProvider string

const (
	HistoryProviderOpenAI     CodexHistoryProvider = "openai"
	HistoryProviderOpenCodex  CodexHistoryProvider = "opencodex"
	DefaultHistoryBusyTimeout                      = 5 * time.Second
	DefaultHistoryRetryDelay                       = 500 * time.Millisecond
)

type CodexHistorySyncResult struct {
	Rows        int  `json:"rows"`
	Files       int  `json:"files"`
	EjectedRows int  `json:"ejectedRows,omitempty"`
	Failed      bool `json:"failed,omitempty"`
}

type PendingHistoryCount struct {
	PendingRows   int  `json:"pendingRows"`
	BackupEntries int  `json:"backupEntries"`
	Failed        bool `json:"failed,omitempty"`
}

type HistorySyncOptions struct {
	Attempts             int
	RetryDelay           time.Duration
	BusyTimeout          time.Duration
	SkipWhenProvablyNoop bool
	Sleep                func(time.Duration)
}

type historyThreadRow struct {
	ID            string
	RolloutPath   string
	ModelProvider string
	Source        string
	HasUserEvent  int
}

type historyBackupEntry struct {
	ID            string `json:"id"`
	RolloutPath   string `json:"rolloutPath"`
	ModelProvider string `json:"modelProvider"`
	Source        string `json:"source"`
	HasUserEvent  int    `json:"hasUserEvent"`
}

type historyBackupManifest struct {
	Version     int                           `json:"version"`
	StateDBPath string                        `json:"stateDbPath,omitempty"`
	Entries     map[string]historyBackupEntry `json:"entries"`
}

type sessionMetaRecord struct {
	Type      any            `json:"type"`
	Timestamp any            `json:"timestamp,omitempty"`
	Payload   map[string]any `json:"payload"`
}

func HistoryBackupPath(stateDBPath, configDir string) string {
	normalized, err := filepath.Abs(stateDBPath)
	if err != nil {
		normalized = filepath.Clean(stateDBPath)
	}
	if filepath.Separator == '\\' {
		normalized = strings.ToLower(normalized)
	}
	digest := sha256.Sum256([]byte(normalized))
	return filepath.Join(configDir, "codex-history-backup-"+hex.EncodeToString(digest[:8])+".json")
}

func readHistoryBackup(path, stateDBPath string) historyBackupManifest {
	empty := historyBackupManifest{Version: 1, StateDBPath: stateDBPath, Entries: map[string]historyBackupEntry{}}
	data, err := os.ReadFile(path)
	if err != nil {
		return empty
	}
	var manifest historyBackupManifest
	if json.Unmarshal(data, &manifest) != nil || manifest.Version != 1 || manifest.Entries == nil {
		return empty
	}
	if manifest.StateDBPath != "" && stateDBPath != "" && !sameHistoryPath(manifest.StateDBPath, stateDBPath) {
		return empty
	}
	if manifest.StateDBPath == "" {
		manifest.StateDBPath = stateDBPath
	}
	return manifest
}

func sameHistoryPath(left, right string) bool {
	left, _ = filepath.Abs(left)
	right, _ = filepath.Abs(right)
	if filepath.Separator == '\\' {
		return strings.EqualFold(left, right)
	}
	return left == right
}

func writeHistoryBackup(path, stateDBPath string, manifest historyBackupManifest) error {
	if len(manifest.Entries) == 0 {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	manifest.Version = 1
	if manifest.StateDBPath == "" {
		manifest.StateDBPath = stateDBPath
	}
	data, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return err
	}
	return atomicWriteFile(path, append(data, '\n'), 0o600)
}

func rememberHistoryOriginal(manifest *historyBackupManifest, row historyThreadRow) {
	if _, exists := manifest.Entries[row.ID]; exists {
		return
	}
	manifest.Entries[row.ID] = historyBackupEntry{ID: row.ID, RolloutPath: row.RolloutPath, ModelProvider: row.ModelProvider, Source: row.Source, HasUserEvent: row.HasUserEvent}
}

func parseSessionMetaLine(line []byte) (sessionMetaRecord, bool) {
	var record sessionMetaRecord
	if json.Unmarshal(line, &record) != nil || record.Type != "session_meta" || record.Payload == nil {
		return sessionMetaRecord{}, false
	}
	return record, true
}

func readLatestSessionMeta(path string) (sessionMetaRecord, bool, error) {
	file, err := os.Open(path)
	if err != nil {
		return sessionMetaRecord{}, false, err
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64<<10), 16<<20)
	var latest sessionMetaRecord
	found := false
	for scanner.Scan() {
		line := scanner.Bytes()
		if !strings.Contains(string(line), `"session_meta"`) {
			continue
		}
		if record, ok := parseSessionMetaLine(line); ok {
			latest, found = record, true
		}
	}
	return latest, found, scanner.Err()
}

func appendRolloutLine(path string, line []byte) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		return err
	}
	defer file.Close()
	line = append(append([]byte(nil), line...), '\n')
	for len(line) > 0 {
		written, writeErr := file.Write(line)
		if writeErr != nil {
			return writeErr
		}
		line = line[written:]
	}
	_ = file.Sync()
	return nil
}

var providerTokenPattern = regexp.MustCompile(`"model_provider"\s*:\s*"([^"\\]*)"`)

// patchFirstLineProviderInPlace only performs length-preserving replacement so
// Codex's cached append handle remains valid and later bytes cannot be clipped.
func patchFirstLineProviderInPlace(path, expectedID, provider string) (bool, error) {
	file, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		return false, err
	}
	defer file.Close()
	reader := bufio.NewReaderSize(file, 64<<10)
	line, err := reader.ReadBytes('\n')
	if err != nil {
		return false, nil
	}
	line = line[:len(line)-1]
	if len(line) > 16<<20 {
		return false, nil
	}
	record, ok := parseSessionMetaLine(line)
	if !ok || record.Payload["id"] != expectedID || record.Payload["model_provider"] == provider {
		return false, nil
	}
	location := providerTokenPattern.FindSubmatchIndex(line)
	if location == nil {
		return false, nil
	}
	replacement := []byte(`"model_provider":"` + provider + `"`)
	originalLen := location[1] - location[0]
	if len(replacement) > originalLen {
		return false, nil
	}
	replacement = append(replacement, []byte(strings.Repeat(" ", originalLen-len(replacement)))...)
	patched := append([]byte(nil), line...)
	copy(patched[location[0]:location[1]], replacement)
	check, ok := parseSessionMetaLine(patched)
	if !ok || check.Payload["model_provider"] != provider {
		return false, nil
	}
	written := 0
	for written < len(patched) {
		n, writeErr := file.WriteAt(patched[written:], int64(written))
		if writeErr != nil {
			return false, writeErr
		}
		written += n
	}
	_ = file.Sync()
	return true, nil
}

func updateSessionMeta(path, expectedID string, provider, source *string) (bool, error) {
	if path == "" {
		return false, nil
	}
	record, ok, err := readLatestSessionMeta(path)
	if err != nil || !ok {
		return false, err
	}
	if record.Payload["id"] != expectedID {
		return false, nil
	}
	changed := false
	if provider != nil && record.Payload["model_provider"] != *provider {
		record.Payload["model_provider"] = *provider
		changed = true
	}
	if source != nil && record.Payload["source"] != *source {
		record.Payload["source"] = *source
		changed = true
	}
	if !changed {
		return false, nil
	}
	if provider != nil {
		_, _ = patchFirstLineProviderInPlace(path, expectedID, *provider)
	}
	record.Timestamp = time.Now().UTC().Format(time.RFC3339Nano)
	line, err := json.Marshal(record)
	if err != nil {
		return false, err
	}
	return true, appendRolloutLine(path, line)
}

func historyDSN(path string, readonly bool, timeout time.Duration) string {
	mode := "rwc"
	if readonly {
		mode = "ro"
	}
	millis := timeout.Milliseconds()
	if millis < 1 {
		millis = 1
	}
	return "file:" + filepath.ToSlash(path) + "?mode=" + mode + "&_pragma=busy_timeout(" + fmt.Sprint(millis) + ")"
}

func openHistoryDB(path string, readonly bool, timeout time.Duration) (*sql.DB, error) {
	db, err := sql.Open("sqlite", historyDSN(path, readonly, timeout))
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	ctx, cancel := context.WithTimeout(context.Background(), timeout+time.Second)
	defer cancel()
	if err = db.PingContext(ctx); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

func IsRecoverableHistoryError(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	for _, fragment := range []string{"sqlite_busy", "sqlite_locked", "database is locked", "database is busy", "resource busy", "operation not permitted", "permission denied"} {
		if strings.Contains(message, fragment) {
			return true
		}
	}
	return errors.Is(err, os.ErrPermission)
}

func withHistoryRetry(options HistorySyncOptions, fn func() (CodexHistorySyncResult, error)) (CodexHistorySyncResult, error) {
	attempts := options.Attempts
	if attempts < 1 {
		attempts = 2
	}
	delay := options.RetryDelay
	if delay <= 0 {
		delay = DefaultHistoryRetryDelay
	}
	sleep := options.Sleep
	if sleep == nil {
		sleep = time.Sleep
	}
	for attempt := 0; attempt < attempts; attempt++ {
		result, err := fn()
		if err == nil {
			return result, nil
		}
		if !IsRecoverableHistoryError(err) {
			return CodexHistorySyncResult{}, err
		}
		if attempt == attempts-1 {
			return CodexHistorySyncResult{Failed: true}, nil
		}
		sleep(delay)
	}
	return CodexHistorySyncResult{Failed: true}, nil
}

func SyncCodexHistoryProvider(provider CodexHistoryProvider, stateDBPath, backupPath string, options HistorySyncOptions) (CodexHistorySyncResult, error) {
	if _, err := os.Stat(stateDBPath); os.IsNotExist(err) {
		return CodexHistorySyncResult{}, nil
	}
	if options.SkipWhenProvablyNoop && provider == HistoryProviderOpenAI {
		pending := CountPendingOpenCodexHistory(stateDBPath, backupPath)
		if !pending.Failed && pending.PendingRows == 0 && pending.BackupEntries == 0 {
			return CodexHistorySyncResult{}, nil
		}
	}
	return withHistoryRetry(options, func() (CodexHistorySyncResult, error) {
		return syncHistoryUnsafe(provider, stateDBPath, backupPath, options)
	})
}

func syncHistoryUnsafe(provider CodexHistoryProvider, stateDBPath, backupPath string, options HistorySyncOptions) (CodexHistorySyncResult, error) {
	timeout := options.BusyTimeout
	if timeout <= 0 {
		timeout = DefaultHistoryBusyTimeout
	}
	db, err := openHistoryDB(stateDBPath, false, timeout)
	if err != nil {
		return CodexHistorySyncResult{}, err
	}
	defer db.Close()
	if provider == HistoryProviderOpenAI {
		return restoreHistory(db, stateDBPath, backupPath)
	}
	openaiRows, err := queryHistoryRows(db, `SELECT id, rollout_path, model_provider, source, has_user_event FROM threads WHERE model_provider = 'openai' AND source IN ('cli','vscode')`)
	if err != nil {
		return CodexHistorySyncResult{}, err
	}
	execRows, err := queryHistoryRows(db, `SELECT id, rollout_path, model_provider, source, has_user_event FROM threads WHERE model_provider = 'opencodex' AND source = 'exec' AND trim(coalesce(first_user_message,'')) != ''`)
	if err != nil {
		return CodexHistorySyncResult{}, err
	}
	manifest := readHistoryBackup(backupPath, stateDBPath)
	for _, row := range append(append([]historyThreadRow{}, openaiRows...), execRows...) {
		rememberHistoryOriginal(&manifest, row)
	}
	if err = writeHistoryBackup(backupPath, stateDBPath, manifest); err != nil {
		return CodexHistorySyncResult{}, err
	}
	files := 0
	opencodex, cli := "opencodex", "cli"
	for _, row := range openaiRows {
		if changed, _ := updateSessionMeta(row.RolloutPath, row.ID, &opencodex, nil); changed {
			files++
		}
	}
	for _, row := range execRows {
		if changed, _ := updateSessionMeta(row.RolloutPath, row.ID, nil, &cli); changed {
			files++
		}
	}
	tx, err := db.Begin()
	if err != nil {
		return CodexHistorySyncResult{}, err
	}
	defer tx.Rollback()
	all := append(append([]historyThreadRow{}, openaiRows...), execRows...)
	for _, row := range all {
		if _, err = tx.Exec(`UPDATE threads SET has_user_event=1 WHERE id=? AND trim(coalesce(first_user_message,'')) != ''`, row.ID); err != nil {
			return CodexHistorySyncResult{}, err
		}
	}
	if _, err = tx.Exec(`UPDATE threads SET model_provider='opencodex' WHERE model_provider='openai' AND source IN ('cli','vscode')`); err != nil {
		return CodexHistorySyncResult{}, err
	}
	if _, err = tx.Exec(`UPDATE threads SET source='cli' WHERE model_provider='opencodex' AND source='exec' AND trim(coalesce(first_user_message,'')) != ''`); err != nil {
		return CodexHistorySyncResult{}, err
	}
	if err = tx.Commit(); err != nil {
		return CodexHistorySyncResult{}, err
	}
	return CodexHistorySyncResult{Rows: len(all), Files: files}, nil
}

func queryHistoryRows(db *sql.DB, query string, args ...any) ([]historyThreadRow, error) {
	rows, err := db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []historyThreadRow{}
	for rows.Next() {
		var row historyThreadRow
		if err = rows.Scan(&row.ID, &row.RolloutPath, &row.ModelProvider, &row.Source, &row.HasUserEvent); err != nil {
			return nil, err
		}
		result = append(result, row)
	}
	return result, rows.Err()
}

func nativeHistoryTarget(entry historyBackupEntry) historyBackupEntry {
	if entry.ModelProvider != "opencodex" {
		return entry
	}
	entry.ModelProvider = "openai"
	if entry.Source == "exec" {
		entry.Source = "cli"
	}
	entry.HasUserEvent = 1
	return entry
}

func restoreHistory(db *sql.DB, stateDBPath, backupPath string) (CodexHistorySyncResult, error) {
	manifest := readHistoryBackup(backupPath, stateDBPath)
	files := 0
	for _, entry := range manifest.Entries {
		target := nativeHistoryTarget(entry)
		if changed, _ := updateSessionMeta(entry.RolloutPath, entry.ID, &target.ModelProvider, &target.Source); changed {
			files++
		}
	}
	tx, err := db.Begin()
	if err != nil {
		return CodexHistorySyncResult{}, err
	}
	defer tx.Rollback()
	for _, entry := range manifest.Entries {
		target := nativeHistoryTarget(entry)
		if _, err = tx.Exec(`UPDATE threads SET model_provider=?, source=?, has_user_event=? WHERE id=?`, target.ModelProvider, target.Source, target.HasUserEvent, target.ID); err != nil {
			return CodexHistorySyncResult{}, err
		}
	}
	if err = tx.Commit(); err != nil {
		return CodexHistorySyncResult{}, err
	}
	if err = writeHistoryBackup(backupPath, stateDBPath, historyBackupManifest{Version: 1, StateDBPath: stateDBPath, Entries: map[string]historyBackupEntry{}}); err != nil {
		return CodexHistorySyncResult{}, err
	}
	ejected, err := ejectRemainingHistory(db)
	if err != nil {
		return CodexHistorySyncResult{}, err
	}
	return CodexHistorySyncResult{Rows: len(manifest.Entries), Files: files + ejected.Files, EjectedRows: ejected.Rows}, nil
}

func ejectRemainingHistory(db *sql.DB) (CodexHistorySyncResult, error) {
	rows, err := queryHistoryRows(db, `SELECT id, rollout_path, model_provider, source, has_user_event FROM threads WHERE model_provider='opencodex' AND trim(coalesce(first_user_message,'')) != ''`)
	if err != nil {
		return CodexHistorySyncResult{}, err
	}
	files := 0
	openai, cli := "openai", "cli"
	for _, row := range rows {
		var source *string
		if row.Source == "exec" {
			source = &cli
		}
		if changed, _ := updateSessionMeta(row.RolloutPath, row.ID, &openai, source); changed {
			files++
		}
	}
	tx, err := db.Begin()
	if err != nil {
		return CodexHistorySyncResult{}, err
	}
	defer tx.Rollback()
	for _, row := range rows {
		if _, err = tx.Exec(`UPDATE threads SET model_provider='openai', source=CASE WHEN source='exec' THEN 'cli' ELSE source END, has_user_event=1 WHERE id=?`, row.ID); err != nil {
			return CodexHistorySyncResult{}, err
		}
	}
	if err = tx.Commit(); err != nil {
		return CodexHistorySyncResult{}, err
	}
	return CodexHistorySyncResult{Rows: len(rows), Files: files}, nil
}

func CountPendingOpenCodexHistory(stateDBPath, backupPath string) PendingHistoryCount {
	manifest := readHistoryBackup(backupPath, stateDBPath)
	result := PendingHistoryCount{BackupEntries: len(manifest.Entries)}
	if _, err := os.Stat(stateDBPath); os.IsNotExist(err) {
		return result
	}
	db, err := openHistoryDB(stateDBPath, true, 100*time.Millisecond)
	if err != nil {
		result.Failed = true
		return result
	}
	defer db.Close()
	if err = db.QueryRow(`SELECT count(*) FROM threads WHERE model_provider='opencodex' AND trim(coalesce(first_user_message,'')) != ''`).Scan(&result.PendingRows); err != nil {
		result.Failed = true
	}
	return result
}

// CopyFirstLine is a narrow test helper kept unexported in production behavior.
func copyFirstLine(reader io.Reader) ([]byte, error) {
	line, err := bufio.NewReader(reader).ReadBytes('\n')
	if err != nil {
		return nil, err
	}
	return line[:len(line)-1], nil
}
