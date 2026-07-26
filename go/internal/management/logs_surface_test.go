package management

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/types"
	"github.com/lidge-jun/opencodex-go/internal/usage"
)

func TestRequestLogRecordPreservesUsageSurface(t *testing.T) {
	persist := usage.NewLog(filepath.Join(t.TempDir(), "usage.jsonl"))
	log := NewRequestLog(10)
	log.SetUsageLog(persist)
	record := &types.UsageRecord{
		RequestID: "req-grok", Provider: "acme", Model: "wire", Surface: string(usage.SurfaceGrok),
		Usage: types.Usage{InputTokens: 3, OutputTokens: 2}, Status: types.OutcomeSuccess,
		StartedAt: time.UnixMilli(1_700_000_000_000), Duration: time.Second,
	}
	if err := log.Record(context.Background(), record); err != nil {
		t.Fatal(err)
	}

	entries := log.Entries("", "", 0)
	if len(entries) != 1 || entries[0].Surface != usage.SurfaceGrok {
		t.Fatalf("request log entries = %#v", entries)
	}
	encoded, err := json.Marshal(entries[0])
	if err != nil {
		t.Fatal(err)
	}
	if !json.Valid(encoded) || !strings.Contains(string(encoded), `"surface":"grok"`) {
		t.Fatalf("serialized request log = %s", encoded)
	}
	persisted, err := persist.ReadAll()
	if err != nil || len(persisted) != 1 || persisted[0].Surface != usage.SurfaceGrok {
		t.Fatalf("persisted entries = %#v, err = %v", persisted, err)
	}
}
