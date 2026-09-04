package oauth

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	_ "modernc.org/sqlite"
)

var kiroTokenKeys = []string{"kirocli:odic:token", "kirocli:oidc:token", "kirocli:social:token", "codewhisperer:odic:token"}
var kiroRegistrationKeys = []string{"kirocli:odic:device-registration", "kirocli:oidc:device-registration", "codewhisperer:odic:device-registration"}

type kiroKVRow struct{ Key, Value string }

func (f *KiroFlow) sqlitePaths() ([]string, error) {
	env := f.Env
	if env == nil {
		env = os.Getenv
	}
	if configured := strings.TrimSpace(env("KIROCLI_DB_PATH")); configured != "" {
		return []string{f.expandPath(configured)}, nil
	}
	if configured := strings.TrimSpace(env("KIRO_CLI_DB_FILE")); configured != "" {
		return []string{f.expandPath(configured)}, nil
	}
	homeFn := f.HomeDir
	if homeFn == nil {
		homeFn = os.UserHomeDir
	}
	home, err := homeFn()
	if err != nil {
		return nil, err
	}
	return []string{
		filepath.Join(home, "Library", "Application Support", "kiro-cli", "data.sqlite3"),
		filepath.Join(home, ".local", "share", "kiro-cli", "data.sqlite3"),
		filepath.Join(home, ".local", "share", "amazon-q", "data.sqlite3"),
		filepath.Join(home, ".kiro", "sso", "cache.db"),
	}, nil
}

func (f *KiroFlow) importSQLite() (KiroImportedCredential, bool, error) {
	paths, err := f.sqlitePaths()
	if err != nil {
		return KiroImportedCredential{}, false, nil
	}
	for _, path := range paths {
		if _, statErr := os.Stat(path); errors.Is(statErr, os.ErrNotExist) {
			continue
		} else if statErr != nil {
			continue
		}
		credential, found, readErr := f.readSQLite(path)
		if readErr != nil {
			return KiroImportedCredential{}, false, readErr
		}
		if found {
			return credential, true, nil
		}
	}
	return KiroImportedCredential{}, false, nil
}

func (f *KiroFlow) readSQLite(path string) (KiroImportedCredential, bool, error) {
	dsn := (&url.URL{Scheme: "file", Path: path, RawQuery: "mode=ro&_pragma=busy_timeout%285000%29"}).String()
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return KiroImportedCredential{}, false, fmt.Errorf("open Kiro CLI credential database: %w", err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	rows, err := db.Query("SELECT key, value FROM auth_kv WHERE key LIKE ? ORDER BY key ASC LIMIT 64", "%:token")
	if err != nil {
		return KiroImportedCredential{}, false, nil
	}
	defer rows.Close()
	var tokens []kiroKVRow
	for rows.Next() {
		var row kiroKVRow
		if err := rows.Scan(&row.Key, &row.Value); err != nil {
			return KiroImportedCredential{}, false, nil
		}
		tokens = append(tokens, row)
	}
	if err := rows.Err(); err != nil {
		return KiroImportedCredential{}, false, nil
	}
	token, err := f.selectKiroToken(tokens)
	if err != nil {
		return KiroImportedCredential{}, false, err
	}
	if token == nil {
		return KiroImportedCredential{}, false, nil
	}
	merged := map[string]any{}
	for _, key := range kiroRegistrationKeys {
		var value string
		if db.QueryRow("SELECT value FROM auth_kv WHERE key = ? LIMIT 1", key).Scan(&value) != nil {
			continue
		}
		_ = mergeKiroJSON(merged, value)
		break
	}
	if err := mergeKiroJSON(merged, token.Value); err != nil {
		return KiroImportedCredential{}, false, nil
	}
	var profileValue string
	if db.QueryRow("SELECT value FROM state WHERE key = ? LIMIT 1", "api.codewhisperer.profile").Scan(&profileValue) == nil {
		var profile map[string]any
		if json.Unmarshal([]byte(profileValue), &profile) == nil {
			if arn := firstKiroString(profile, "arn", "profileArn", "profile_arn"); arn != "" {
				merged["profileArn"] = arn
				if region := InferKiroRegionFromProfileARN(arn); region != "" {
					merged["apiRegion"] = region
				}
			}
		}
	}
	data, _ := json.Marshal(merged)
	credential, err := parseKiroCredential(data, f.now())
	if err != nil {
		return KiroImportedCredential{}, false, nil
	}
	credential.Source = SourceLocalCLI
	return credential, true, nil
}

func (f *KiroFlow) selectKiroToken(rows []kiroKVRow) (*kiroKVRow, error) {
	env := f.Env
	if env == nil {
		env = os.Getenv
	}
	if selected := strings.TrimSpace(env("KIROCLI_TOKEN_KEY")); selected != "" {
		for index := range rows {
			if rows[index].Key == selected {
				return &rows[index], nil
			}
		}
		return nil, errors.New("KIROCLI_TOKEN_KEY selection was not found in the Kiro CLI credential database")
	}
	for _, preferred := range kiroTokenKeys {
		for index := range rows {
			if rows[index].Key == preferred {
				return &rows[index], nil
			}
		}
	}
	if len(rows) == 0 {
		return nil, nil
	}
	if len(rows) == 1 {
		return &rows[0], nil
	}
	return nil, errors.New("Kiro CLI credential database contains multiple tokens; set KIROCLI_TOKEN_KEY to select one")
}

func mergeKiroJSON(target map[string]any, value string) error {
	var payload map[string]any
	if err := json.Unmarshal([]byte(value), &payload); err != nil {
		return err
	}
	for key, item := range payload {
		target[key] = item
	}
	return nil
}

func firstKiroString(payload map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := payload[key].(string); ok && value != "" {
			return value
		}
	}
	return ""
}
