package management

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/types"
	"github.com/lidge-jun/opencodex-go/internal/usage"
)

func usageTestEntry(id string, at time.Time, surface usage.Surface) usage.Entry {
	return usage.Entry{
		RequestID: id, Timestamp: at.UnixMilli(), Provider: "acme", Model: "wire",
		ResolvedModel: "resolved-wire", Surface: surface, Status: http.StatusOK,
		DurationMS: 1, UsageStatus: usage.StatusReported,
		Usage: &types.Usage{InputTokens: 3, OutputTokens: 2, TotalTokens: 5},
	}
}

func usageRequest(t *testing.T, api *API, target string) (int, usageSummaryResponseDTO) {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, target, nil)
	response := httptest.NewRecorder()
	api.ServeHTTP(response, request)
	var body usageSummaryResponseDTO
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode %s: %v; body=%s", target, err, response.Body.String())
	}
	return response.Code, body
}

func newUsageTestAPI(t *testing.T, log *usage.Log) *API {
	t.Helper()
	api, err := NewAPI(Options{UsageLog: log})
	if err != nil {
		t.Fatal(err)
	}
	return api
}

func TestUsageSummaryCacheInvalidationAndSurfaceKeys(t *testing.T) {
	path := filepath.Join(t.TempDir(), "usage.jsonl")
	log := usage.NewLog(path)
	now := time.Date(2026, 7, 26, 12, 0, 0, 0, time.Local)
	if err := log.Append(usageTestEntry("codex-1", now.Add(-time.Hour), "")); err != nil {
		t.Fatal(err)
	}
	api := newUsageTestAPI(t, log)

	_, first := usageRequest(t, api, "/api/usage?range=30d&surface=codex")
	_, hit := usageRequest(t, api, "/api/usage?range=30d&surface=codex")
	if first.Summary.Requests != 1 || hit.Summary.Requests != 1 {
		t.Fatalf("unchanged cache responses = %#v %#v", first.Summary, hit.Summary)
	}
	if len(api.usageSummaryCache) != 1 {
		t.Fatalf("cache entries = %d, want 1", len(api.usageSummaryCache))
	}

	if err := log.Append(usageTestEntry("claude-1", now, usage.SurfaceClaude)); err != nil {
		t.Fatal(err)
	}
	_, appended := usageRequest(t, api, "/api/usage?range=30d&surface=codex")
	_, claude := usageRequest(t, api, "/api/usage?range=30d&surface=claude")
	if appended.Summary.Requests != 1 || claude.Summary.Requests != 1 || len(api.usageSummaryCache) != 2 {
		t.Fatalf("append/surface responses = codex:%#v claude:%#v cache=%d", appended.Summary, claude.Summary, len(api.usageSummaryCache))
	}

	replacement := path + ".replacement"
	replacementLog := usage.NewLog(replacement)
	if err := replacementLog.Append(usageTestEntry("codex-2", now, "")); err != nil {
		t.Fatal(err)
	}
	if err := replacementLog.Append(usageTestEntry("codex-3", now, "")); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(replacement, path); err != nil {
		t.Fatal(err)
	}
	_, replaced := usageRequest(t, api, "/api/usage?range=30d&surface=codex")
	if replaced.Summary.Requests != 2 {
		t.Fatalf("replacement requests = %d, want 2", replaced.Summary.Requests)
	}
}

func TestUsageSummaryCacheSerializesConcurrentColdMisses(t *testing.T) {
	path := filepath.Join(t.TempDir(), "usage.jsonl")
	log := usage.NewLog(path)
	if err := log.Append(usageTestEntry("concurrent", time.Now(), "")); err != nil {
		t.Fatal(err)
	}
	api := newUsageTestAPI(t, log)
	const callers = 32
	start := make(chan struct{})
	results := make(chan error, callers)
	var group sync.WaitGroup
	for range callers {
		group.Add(1)
		go func() {
			defer group.Done()
			<-start
			request := httptest.NewRequest(http.MethodGet, "/api/usage?range=30d&surface=codex", nil)
			response := httptest.NewRecorder()
			api.ServeHTTP(response, request)
			var body usageSummaryResponseDTO
			if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
				results <- err
				return
			}
			if response.Code != http.StatusOK || body.Summary.Requests != 1 {
				results <- fmt.Errorf("status=%d requests=%d", response.Code, body.Summary.Requests)
				return
			}
			results <- nil
		}()
	}
	close(start)
	group.Wait()
	close(results)
	for err := range results {
		if err != nil {
			t.Fatal(err)
		}
	}
	if reads := log.SnapshotStatsForTests().FullReads; reads != 1 {
		t.Fatalf("concurrent cold misses performed %d full reads, want 1", reads)
	}
	if len(api.usageSummaryCache) != 1 {
		t.Fatalf("concurrent cache entries=%d, want 1", len(api.usageSummaryCache))
	}
}

func TestUsageSummaryExpiryAndRefreshedClockFields(t *testing.T) {
	now := time.Date(2026, 7, 26, 23, 59, 0, 0, time.Local)
	entry := usageTestEntry("boundary", now.Add(-7*24*time.Hour+30*time.Second), "")
	expiry := usageSummaryExpiresAt([]usage.Entry{entry}, usage.Range7D, "codex", now)
	if want := time.UnixMilli(entry.Timestamp).Add(7*24*time.Hour + time.Millisecond); !expiry.Equal(want) {
		t.Fatalf("range expiry = %s, want %s", expiry, want)
	}
	entry30d := usageTestEntry("boundary-30d", now.Add(-30*24*time.Hour+30*time.Second), "")
	if got, want := usageSummaryExpiresAt([]usage.Entry{entry30d}, usage.Range30D, "codex", now), time.UnixMilli(entry30d.Timestamp).Add(30*24*time.Hour+time.Millisecond); !got.Equal(want) {
		t.Fatalf("30d range expiry = %s, want %s", got, want)
	}
	if midnight := usageSummaryExpiresAt(nil, usage.RangeAll, "all", now); !midnight.Equal(nextLocalMidnight(now)) {
		t.Fatalf("midnight expiry = %s", midnight)
	}

	path := filepath.Join(t.TempDir(), "usage.jsonl")
	log := usage.NewLog(path)
	if err := log.Append(entry); err != nil {
		t.Fatal(err)
	}
	api := newUsageTestAPI(t, log)
	current := now
	api.now = func() time.Time { return current }
	_, first := usageRequest(t, api, "/api/usage?range=7d")
	readsAfterBuild := log.SnapshotStatsForTests().FullReads
	current = now.Add(30 * time.Second)
	_, hit := usageRequest(t, api, "/api/usage?range=7d")
	if first.GeneratedAt >= hit.GeneratedAt || first.Since == nil || hit.Since == nil || *first.Since >= *hit.Since {
		t.Fatalf("clock fields were not refreshed: first=%#v hit=%#v", first, hit)
	}
	if reads := log.SnapshotStatsForTests().FullReads; reads != readsAfterBuild {
		t.Fatalf("cache hit performed a full read: before=%d after=%d", readsAfterBuild, reads)
	}
	boundary := time.UnixMilli(entry.Timestamp).Add(7 * 24 * time.Hour)
	current = boundary
	_, atBoundary := usageRequest(t, api, "/api/usage?range=7d")
	current = boundary.Add(time.Millisecond - time.Nanosecond)
	_, beforeFirstExcludedMillisecond := usageRequest(t, api, "/api/usage?range=7d")
	if atBoundary.Summary.Requests != 1 || beforeFirstExcludedMillisecond.Summary.Requests != 1 ||
		log.SnapshotStatsForTests().FullReads != readsAfterBuild {
		t.Fatalf("inclusive boundary rebuilt early: boundary=%#v before=%#v stats=%#v", atBoundary, beforeFirstExcludedMillisecond, log.SnapshotStatsForTests())
	}
	current = boundary.Add(time.Millisecond)
	_, expired := usageRequest(t, api, "/api/usage?range=7d")
	if expired.Summary.Requests != 0 || log.SnapshotStatsForTests().FullReads != readsAfterBuild+1 {
		t.Fatalf("first excluded millisecond remained cached: body=%#v stats=%#v", expired, log.SnapshotStatsForTests())
	}
	current = now
	_, _ = usageRequest(t, api, "/api/usage?range=all")
	beforeMidnight := api.usageSummaryCache["all:all"].expiresAt
	current = nextLocalMidnight(now).Add(time.Minute)
	_, _ = usageRequest(t, api, "/api/usage?range=all")
	afterMidnight := api.usageSummaryCache["all:all"].expiresAt
	if !afterMidnight.After(beforeMidnight) {
		t.Fatalf("local-midnight cache did not rebuild: before=%s after=%s", beforeMidnight, afterMidnight)
	}
}

func TestUsageReadFailureIsStableHTTP200AndDoesNotPoisonRecovery(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "usage.jsonl")
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatal(err)
	}
	api := newUsageTestAPI(t, usage.NewLog(path))
	status, failed := usageRequest(t, api, "/api/usage?range=7d&surface=grok")
	if status != http.StatusOK || failed.Error != "read_failed" || failed.Since != nil || failed.Summary.Requests != 0 || len(failed.Days) != 0 || len(failed.Models) != 0 || len(failed.Providers) != 0 {
		t.Fatalf("read failure contract = status:%d body:%#v", status, failed)
	}
	if len(api.usageSummaryCache) != 0 {
		t.Fatalf("failed response poisoned cache: %#v", api.usageSummaryCache)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := api.usageLog.Append(usageTestEntry("recovered", time.Now(), usage.SurfaceGrok)); err != nil {
		t.Fatal(err)
	}
	_, recovered := usageRequest(t, api, "/api/usage?range=7d&surface=grok")
	if recovered.Error != "" || recovered.Summary.Requests != 1 {
		t.Fatalf("recovered response = %#v", recovered)
	}
}

func TestUsageSummaryCacheRetainsCompactDTOOnly(t *testing.T) {
	entryType := reflect.TypeOf(usageSummaryCacheEntry{})
	for index := 0; index < entryType.NumField(); index++ {
		field := entryType.Field(index)
		if field.Type == reflect.TypeOf([]usage.Entry{}) {
			t.Fatalf("cache retains raw usage rows in field %s", field.Name)
		}
	}
	if entryType.Field(2).Type != reflect.TypeOf(usageSummaryResponseDTO{}) {
		t.Fatalf("cache payload = %s, want compact DTO", entryType.Field(2).Type)
	}
}
