package storage

import (
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	_ "modernc.org/sqlite"
)

func TestScanCountsNewestSQLiteReadonly(t *testing.T) {
	home := t.TempDir()
	dbPath := filepath.Join(home, "state_5.sqlite")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`CREATE TABLE threads (id TEXT PRIMARY KEY); INSERT INTO threads VALUES ('a'), ('b')`); err != nil {
		t.Fatal(err)
	}
	if err = db.Close(); err != nil {
		t.Fatal(err)
	}

	before, err := os.ReadDir(home)
	if err != nil {
		t.Fatal(err)
	}
	report, err := Scan(home)
	if err != nil {
		t.Fatalf("Scan() error = %v", err)
	}
	after, err := os.ReadDir(home)
	if err != nil {
		t.Fatal(err)
	}
	if len(after) != len(before) {
		t.Fatalf("scan created sidecars: before=%d after=%d", len(before), len(after))
	}

	var state *Bucket
	for i := range report.Buckets {
		if report.Buckets[i].Key == BucketStateDB {
			state = &report.Buckets[i]
		}
	}
	if state == nil || state.Rows == nil || *state.Rows != 2 {
		t.Fatalf("state bucket = %#v, want rows=2", state)
	}
}

func TestReadonlySQLiteURLNormalizesWindowsSeparators(t *testing.T) {
	got := readonlySQLiteURL(`C:\Users\runner\state.sqlite`)
	if strings.Contains(got, "%5C") || !strings.HasPrefix(got, "file:///C:/Users/runner/state.sqlite?") {
		t.Fatalf("readonly SQLite URL = %q", got)
	}
}

func TestScanEmitsNullRowsForSQLiteSidecarWithoutMainDatabase(t *testing.T) {
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, "logs_9.sqlite-wal"), []byte("wal"), 0o600); err != nil {
		t.Fatal(err)
	}
	report, err := Scan(home)
	if err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if json.Unmarshal(payload, &decoded) != nil {
		t.Fatal("decode report")
	}
	for _, raw := range decoded["buckets"].([]any) {
		bucket := raw.(map[string]any)
		if bucket["key"] == string(BucketLogsDB) {
			if _, present := bucket["rows"]; !present || bucket["rows"] != nil {
				t.Fatalf("logs bucket rows=%#v payload=%s", bucket["rows"], payload)
			}
			return
		}
	}
	t.Fatal("logs bucket missing")
}
