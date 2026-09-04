# 081 — Literal source patch and generated GUI receipt

Date: 2026-07-27
Base: `77b2aa8b`

The fenced diff below is the complete hand-authored source candidate. Generated
GUI bytes are defined by the frozen-lockfile build recipe and exact SHA-256
manifest that follow; minified build output is not duplicated as hand-authored
Markdown.

## Exact hand-authored diff

```diff
diff --git a/go/internal/management/api.go b/go/internal/management/api.go
index 120533d8..2a4c430c 100644
--- a/go/internal/management/api.go
+++ b/go/internal/management/api.go
@@ -6,6 +6,7 @@ import (
 	"runtime"
 	"strings"
 	"sync"
+	"time"
 
 	"github.com/lidge-jun/opencodex-go/internal/claude"
 	"github.com/lidge-jun/opencodex-go/internal/codex"
@@ -94,6 +95,9 @@ type API struct {
 	contextCaps         map[string]int
 	combos              map[string]Combo
 	agents              AgentSettings
+	now                 func() time.Time
+	usageCacheMu        sync.Mutex
+	usageSummaryCache   map[string]usageSummaryCacheEntry
 	debugEnabled        bool
 }
 
@@ -132,7 +136,7 @@ func New(options Options) (*API, error) {
 	if options.InjectionLogs == nil {
 		options.InjectionLogs = ocxlib.NewDebugLogBuffer()
 	}
-	api := &API{config: cfg, configPath: options.ConfigPath, configPersistence: options.ConfigPersistence, registry: options.Registry, usageLog: options.UsageLog, debugLog: options.DebugLog, requestLogs: options.RequestLogs, advancedRequestLogs: options.AdvancedRequestLogs, memoryWatchdog: options.MemoryWatchdog, responseState: options.ResponseState, providerDNSLookup: options.ProviderDNSLookup, oauth: options.OAuth, codexAuth: options.CodexAuth, codexRouter: options.CodexRouter, providerDebug: options.DebugLogs, injectionDebug: options.InjectionLogs, claudeDebug: options.ClaudeDebug, providerQuotas: options.ProviderQuotas, claudeRuntime: options.ClaudeRuntime, runtimeControl: options.RuntimeControl, grokPort: options.GrokPort, grokHostname: options.GrokHostname, fetchModels: options.FetchModels, storageHome: options.StorageHome, version: options.Version, stop: options.Stop, refreshCatalog: options.RefreshCatalog, onAPIKeysChanged: options.OnAPIKeysChanged, modelCache: options.ModelCache, authorize: options.Authorize, customModels: customModels, aliases: map[string]string{}, contextCaps: cloneIntMap(cfg.ProviderContextCaps), combos: map[string]Combo{}, agents: agents}
+	api := &API{config: cfg, configPath: options.ConfigPath, configPersistence: options.ConfigPersistence, registry: options.Registry, usageLog: options.UsageLog, debugLog: options.DebugLog, requestLogs: options.RequestLogs, advancedRequestLogs: options.AdvancedRequestLogs, memoryWatchdog: options.MemoryWatchdog, responseState: options.ResponseState, providerDNSLookup: options.ProviderDNSLookup, oauth: options.OAuth, codexAuth: options.CodexAuth, codexRouter: options.CodexRouter, providerDebug: options.DebugLogs, injectionDebug: options.InjectionLogs, claudeDebug: options.ClaudeDebug, providerQuotas: options.ProviderQuotas, claudeRuntime: options.ClaudeRuntime, runtimeControl: options.RuntimeControl, grokPort: options.GrokPort, grokHostname: options.GrokHostname, fetchModels: options.FetchModels, storageHome: options.StorageHome, version: options.Version, stop: options.Stop, refreshCatalog: options.RefreshCatalog, onAPIKeysChanged: options.OnAPIKeysChanged, modelCache: options.ModelCache, authorize: options.Authorize, customModels: customModels, aliases: map[string]string{}, contextCaps: cloneIntMap(cfg.ProviderContextCaps), combos: map[string]Combo{}, agents: agents, now: time.Now, usageSummaryCache: make(map[string]usageSummaryCacheEntry, 12)}
 	if api.configPersistence != nil {
 		api.configPersistence.BindConfigMutex(&api.mu)
 	}
diff --git a/go/internal/management/logs.go b/go/internal/management/logs.go
index 50f27911..fc864404 100644
--- a/go/internal/management/logs.go
+++ b/go/internal/management/logs.go
@@ -293,17 +293,7 @@ func (a *API) handleLogs(w http.ResponseWriter, r *http.Request) bool {
 	case "GET /api/usage":
 		window := usage.ParseRange(r.URL.Query().Get("range"))
 		surface := usage.ParseSurface(r.URL.Query().Get("surface"))
-		if a.usageLog == nil {
-			writeJSON(w, http.StatusOK, usage.Summarize(nil, window, time.Now(), surface))
-			return true
-		}
-		snapshot, err := a.usageLog.ReadSnapshotForManagement(r.Context())
-		if err != nil {
-			writeError(w, http.StatusInternalServerError, "usage log could not be read")
-			return true
-		}
-		entries := snapshot.Entries
-		writeJSON(w, http.StatusOK, usageSummaryResponse(usage.Summarize(entries, window, time.Now(), surface), entries))
+		writeJSON(w, http.StatusOK, a.usageSummary(r.Context(), window, surface, a.now()))
 		return true
 	case "GET /api/storage":
 		home := a.storageHome
@@ -338,6 +328,12 @@ type usageModelResponse struct {
 	EstimatedCostUSD  float64 `json:"estimatedCostUsd,omitempty"`
 }
 
+type usageSummaryCacheEntry struct {
+	revisionKey string
+	expiresAt   time.Time
+	response    usageSummaryResponseDTO
+}
+
 type usageSummaryResponseDTO struct {
 	Range       usage.Range             `json:"range"`
 	Surface     string                  `json:"surface"`
@@ -347,6 +343,7 @@ type usageSummaryResponseDTO struct {
 	Days        []usage.Day             `json:"days"`
 	Models      []usageModelResponse    `json:"models"`
 	Providers   []usage.ProviderSummary `json:"providers"`
+	Error       string                  `json:"error,omitempty"`
 }
 
 func usageSummaryResponse(summary usage.Summary, entries []usage.Entry) usageSummaryResponseDTO {
@@ -372,6 +369,108 @@ func usageSummaryResponse(summary usage.Summary, entries []usage.Entry) usageSum
 	}
 }
 
+func (a *API) usageSummary(ctx context.Context, window usage.Range, surface string, now time.Time) usageSummaryResponseDTO {
+	if a.usageLog == nil {
+		return usageSummaryResponse(usage.Summarize(nil, window, now, surface), nil)
+	}
+
+	key := string(window) + ":" + surface
+	a.usageCacheMu.Lock()
+	defer a.usageCacheMu.Unlock()
+
+	revision, err := a.usageLog.CurrentRevision()
+	if err != nil {
+		return usageReadFailedResponse(window, surface, now)
+	}
+	if cached, ok := a.usageSummaryCache[key]; ok && cached.revisionKey == revision.Key() && now.Before(cached.expiresAt) {
+		response := cached.response
+		response.Since = usageWindowSince(window, now)
+		response.GeneratedAt = now.UnixMilli()
+		return response
+	}
+
+	snapshot, err := a.usageLog.ReadSnapshotForManagement(ctx)
+	if err != nil {
+		return usageReadFailedResponse(window, surface, now)
+	}
+	response := usageSummaryResponse(usage.Summarize(snapshot.Entries, window, now, surface), snapshot.Entries)
+	a.usageSummaryCache[key] = usageSummaryCacheEntry{
+		revisionKey: snapshot.Revision.Key(),
+		expiresAt:   usageSummaryExpiresAt(snapshot.Entries, window, surface, now),
+		response:    response,
+	}
+	return response
+}
+
+func usageWindowSince(window usage.Range, now time.Time) *int64 {
+	days := 0
+	switch window {
+	case usage.Range7D:
+		days = 7
+	case usage.Range30D:
+		days = 30
+	default:
+		return nil
+	}
+	value := now.Add(-time.Duration(days) * 24 * time.Hour).UnixMilli()
+	return &value
+}
+
+func usageSummaryExpiresAt(entries []usage.Entry, window usage.Range, surface string, now time.Time) time.Time {
+	expiresAt := nextLocalMidnight(now)
+	days := 0
+	switch window {
+	case usage.Range7D:
+		days = 7
+	case usage.Range30D:
+		days = 30
+	default:
+		return expiresAt
+	}
+	windowDuration := time.Duration(days) * 24 * time.Hour
+	for _, entry := range entries {
+		if !usageEntryMatchesSurface(entry, surface) {
+			continue
+		}
+		// Summary cutoffs are millisecond integers and include timestamp == since.
+		// Expire one millisecond after the nominal boundary, when that row first
+		// becomes ineligible, so a boundary rebuild cannot cache it until midnight.
+		expiry := time.UnixMilli(entry.Timestamp).Add(windowDuration + time.Millisecond)
+		if expiry.After(now) && expiry.Before(expiresAt) {
+			expiresAt = expiry
+		}
+	}
+	return expiresAt
+}
+
+func nextLocalMidnight(now time.Time) time.Time {
+	year, month, day := now.Date()
+	return time.Date(year, month, day+1, 0, 0, 0, 0, now.Location())
+}
+
+func usageEntryMatchesSurface(entry usage.Entry, surface string) bool {
+	switch surface {
+	case "claude":
+		return entry.Surface == usage.SurfaceClaude || entry.Surface == usage.SurfaceClaudeDesktop
+	case "grok":
+		return entry.Surface == usage.SurfaceGrok
+	case "codex":
+		return entry.Surface == ""
+	default:
+		return true
+	}
+}
+
+func usageReadFailedResponse(window usage.Range, surface string, now time.Time) usageSummaryResponseDTO {
+	response := usageSummaryResponse(usage.Summarize(nil, window, now, surface), nil)
+	response.Since = nil
+	response.Days = []usage.Day{}
+	response.Models = []usageModelResponse{}
+	response.Providers = []usage.ProviderSummary{}
+	response.Error = "read_failed"
+	return response
+}
+
 func debugLogQuery(r *http.Request) (int, int) {
 	afterRaw := r.URL.Query().Get("after")
 	if afterRaw == "" {
diff --git a/go/internal/management/usage_cache_test.go b/go/internal/management/usage_cache_test.go
new file mode 100644
index 00000000..d5e26577
--- /dev/null
+++ b/go/internal/management/usage_cache_test.go
@@ -0,0 +1,235 @@
+package management
+
+import (
+	"encoding/json"
+	"fmt"
+	"net/http"
+	"net/http/httptest"
+	"os"
+	"path/filepath"
+	"reflect"
+	"sync"
+	"testing"
+	"time"
+
+	"github.com/lidge-jun/opencodex-go/internal/types"
+	"github.com/lidge-jun/opencodex-go/internal/usage"
+)
+
+func usageTestEntry(id string, at time.Time, surface usage.Surface) usage.Entry {
+	return usage.Entry{
+		RequestID: id, Timestamp: at.UnixMilli(), Provider: "acme", Model: "wire",
+		ResolvedModel: "resolved-wire", Surface: surface, Status: http.StatusOK,
+		DurationMS: 1, UsageStatus: usage.StatusReported,
+		Usage: &types.Usage{InputTokens: 3, OutputTokens: 2, TotalTokens: 5},
+	}
+}
+
+func usageRequest(t *testing.T, api *API, target string) (int, usageSummaryResponseDTO) {
+	t.Helper()
+	request := httptest.NewRequest(http.MethodGet, target, nil)
+	response := httptest.NewRecorder()
+	api.ServeHTTP(response, request)
+	var body usageSummaryResponseDTO
+	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
+		t.Fatalf("decode %s: %v; body=%s", target, err, response.Body.String())
+	}
+	return response.Code, body
+}
+
+func newUsageTestAPI(t *testing.T, log *usage.Log) *API {
+	t.Helper()
+	api, err := NewAPI(Options{UsageLog: log})
+	if err != nil {
+		t.Fatal(err)
+	}
+	return api
+}
+
+func TestUsageSummaryCacheInvalidationAndSurfaceKeys(t *testing.T) {
+	path := filepath.Join(t.TempDir(), "usage.jsonl")
+	log := usage.NewLog(path)
+	now := time.Date(2026, 7, 26, 12, 0, 0, 0, time.Local)
+	if err := log.Append(usageTestEntry("codex-1", now.Add(-time.Hour), "")); err != nil {
+		t.Fatal(err)
+	}
+	api := newUsageTestAPI(t, log)
+
+	_, first := usageRequest(t, api, "/api/usage?range=30d&surface=codex")
+	_, hit := usageRequest(t, api, "/api/usage?range=30d&surface=codex")
+	if first.Summary.Requests != 1 || hit.Summary.Requests != 1 {
+		t.Fatalf("unchanged cache responses = %#v %#v", first.Summary, hit.Summary)
+	}
+	if len(api.usageSummaryCache) != 1 {
+		t.Fatalf("cache entries = %d, want 1", len(api.usageSummaryCache))
+	}
+
+	if err := log.Append(usageTestEntry("claude-1", now, usage.SurfaceClaude)); err != nil {
+		t.Fatal(err)
+	}
+	_, appended := usageRequest(t, api, "/api/usage?range=30d&surface=codex")
+	_, claude := usageRequest(t, api, "/api/usage?range=30d&surface=claude")
+	if appended.Summary.Requests != 1 || claude.Summary.Requests != 1 || len(api.usageSummaryCache) != 2 {
+		t.Fatalf("append/surface responses = codex:%#v claude:%#v cache=%d", appended.Summary, claude.Summary, len(api.usageSummaryCache))
+	}
+
+	replacement := path + ".replacement"
+	replacementLog := usage.NewLog(replacement)
+	if err := replacementLog.Append(usageTestEntry("codex-2", now, "")); err != nil {
+		t.Fatal(err)
+	}
+	if err := replacementLog.Append(usageTestEntry("codex-3", now, "")); err != nil {
+		t.Fatal(err)
+	}
+	if err := os.Rename(replacement, path); err != nil {
+		t.Fatal(err)
+	}
+	_, replaced := usageRequest(t, api, "/api/usage?range=30d&surface=codex")
+	if replaced.Summary.Requests != 2 {
+		t.Fatalf("replacement requests = %d, want 2", replaced.Summary.Requests)
+	}
+}
+
+func TestUsageSummaryCacheSerializesConcurrentColdMisses(t *testing.T) {
+	path := filepath.Join(t.TempDir(), "usage.jsonl")
+	log := usage.NewLog(path)
+	if err := log.Append(usageTestEntry("concurrent", time.Now(), "")); err != nil {
+		t.Fatal(err)
+	}
+	api := newUsageTestAPI(t, log)
+	const callers = 32
+	start := make(chan struct{})
+	results := make(chan error, callers)
+	var group sync.WaitGroup
+	for range callers {
+		group.Add(1)
+		go func() {
+			defer group.Done()
+			<-start
+			request := httptest.NewRequest(http.MethodGet, "/api/usage?range=30d&surface=codex", nil)
+			response := httptest.NewRecorder()
+			api.ServeHTTP(response, request)
+			var body usageSummaryResponseDTO
+			if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
+				results <- err
+				return
+			}
+			if response.Code != http.StatusOK || body.Summary.Requests != 1 {
+				results <- fmt.Errorf("status=%d requests=%d", response.Code, body.Summary.Requests)
+				return
+			}
+			results <- nil
+		}()
+	}
+	close(start)
+	group.Wait()
+	close(results)
+	for err := range results {
+		if err != nil {
+			t.Fatal(err)
+		}
+	}
+	if reads := log.SnapshotStatsForTests().FullReads; reads != 1 {
+		t.Fatalf("concurrent cold misses performed %d full reads, want 1", reads)
+	}
+	if len(api.usageSummaryCache) != 1 {
+		t.Fatalf("concurrent cache entries=%d, want 1", len(api.usageSummaryCache))
+	}
+}
+
+func TestUsageSummaryExpiryAndRefreshedClockFields(t *testing.T) {
+	now := time.Date(2026, 7, 26, 23, 59, 0, 0, time.Local)
+	entry := usageTestEntry("boundary", now.Add(-7*24*time.Hour+30*time.Second), "")
+	expiry := usageSummaryExpiresAt([]usage.Entry{entry}, usage.Range7D, "codex", now)
+	if want := time.UnixMilli(entry.Timestamp).Add(7*24*time.Hour + time.Millisecond); !expiry.Equal(want) {
+		t.Fatalf("range expiry = %s, want %s", expiry, want)
+	}
+	entry30d := usageTestEntry("boundary-30d", now.Add(-30*24*time.Hour+30*time.Second), "")
+	if got, want := usageSummaryExpiresAt([]usage.Entry{entry30d}, usage.Range30D, "codex", now), time.UnixMilli(entry30d.Timestamp).Add(30*24*time.Hour+time.Millisecond); !got.Equal(want) {
+		t.Fatalf("30d range expiry = %s, want %s", got, want)
+	}
+	if midnight := usageSummaryExpiresAt(nil, usage.RangeAll, "all", now); !midnight.Equal(nextLocalMidnight(now)) {
+		t.Fatalf("midnight expiry = %s", midnight)
+	}
+
+	path := filepath.Join(t.TempDir(), "usage.jsonl")
+	log := usage.NewLog(path)
+	if err := log.Append(entry); err != nil {
+		t.Fatal(err)
+	}
+	api := newUsageTestAPI(t, log)
+	current := now
+	api.now = func() time.Time { return current }
+	_, first := usageRequest(t, api, "/api/usage?range=7d")
+	readsAfterBuild := log.SnapshotStatsForTests().FullReads
+	current = now.Add(30 * time.Second)
+	_, hit := usageRequest(t, api, "/api/usage?range=7d")
+	if first.GeneratedAt >= hit.GeneratedAt || first.Since == nil || hit.Since == nil || *first.Since >= *hit.Since {
+		t.Fatalf("clock fields were not refreshed: first=%#v hit=%#v", first, hit)
+	}
+	if reads := log.SnapshotStatsForTests().FullReads; reads != readsAfterBuild {
+		t.Fatalf("cache hit performed a full read: before=%d after=%d", readsAfterBuild, reads)
+	}
+	boundary := time.UnixMilli(entry.Timestamp).Add(7 * 24 * time.Hour)
+	current = boundary
+	_, atBoundary := usageRequest(t, api, "/api/usage?range=7d")
+	current = boundary.Add(time.Millisecond - time.Nanosecond)
+	_, beforeFirstExcludedMillisecond := usageRequest(t, api, "/api/usage?range=7d")
+	if atBoundary.Summary.Requests != 1 || beforeFirstExcludedMillisecond.Summary.Requests != 1 ||
+		log.SnapshotStatsForTests().FullReads != readsAfterBuild {
+		t.Fatalf("inclusive boundary rebuilt early: boundary=%#v before=%#v stats=%#v", atBoundary, beforeFirstExcludedMillisecond, log.SnapshotStatsForTests())
+	}
+	current = boundary.Add(time.Millisecond)
+	_, expired := usageRequest(t, api, "/api/usage?range=7d")
+	if expired.Summary.Requests != 0 || log.SnapshotStatsForTests().FullReads != readsAfterBuild+1 {
+		t.Fatalf("first excluded millisecond remained cached: body=%#v stats=%#v", expired, log.SnapshotStatsForTests())
+	}
+	current = now
+	_, _ = usageRequest(t, api, "/api/usage?range=all")
+	beforeMidnight := api.usageSummaryCache["all:all"].expiresAt
+	current = nextLocalMidnight(now).Add(time.Minute)
+	_, _ = usageRequest(t, api, "/api/usage?range=all")
+	afterMidnight := api.usageSummaryCache["all:all"].expiresAt
+	if !afterMidnight.After(beforeMidnight) {
+		t.Fatalf("local-midnight cache did not rebuild: before=%s after=%s", beforeMidnight, afterMidnight)
+	}
+}
+
+func TestUsageReadFailureIsStableHTTP200AndDoesNotPoisonRecovery(t *testing.T) {
+	root := t.TempDir()
+	path := filepath.Join(root, "usage.jsonl")
+	if err := os.Mkdir(path, 0o700); err != nil {
+		t.Fatal(err)
+	}
+	api := newUsageTestAPI(t, usage.NewLog(path))
+	status, failed := usageRequest(t, api, "/api/usage?range=7d&surface=grok")
+	if status != http.StatusOK || failed.Error != "read_failed" || failed.Since != nil || failed.Summary.Requests != 0 || len(failed.Days) != 0 || len(failed.Models) != 0 || len(failed.Providers) != 0 {
+		t.Fatalf("read failure contract = status:%d body:%#v", status, failed)
+	}
+	if len(api.usageSummaryCache) != 0 {
+		t.Fatalf("failed response poisoned cache: %#v", api.usageSummaryCache)
+	}
+	if err := os.Remove(path); err != nil {
+		t.Fatal(err)
+	}
+	if err := api.usageLog.Append(usageTestEntry("recovered", time.Now(), usage.SurfaceGrok)); err != nil {
+		t.Fatal(err)
+	}
+	_, recovered := usageRequest(t, api, "/api/usage?range=7d&surface=grok")
+	if recovered.Error != "" || recovered.Summary.Requests != 1 {
+		t.Fatalf("recovered response = %#v", recovered)
+	}
+}
+
+func TestUsageSummaryCacheRetainsCompactDTOOnly(t *testing.T) {
+	entryType := reflect.TypeOf(usageSummaryCacheEntry{})
+	for index := 0; index < entryType.NumField(); index++ {
+		field := entryType.Field(index)
+		if field.Type == reflect.TypeOf([]usage.Entry{}) {
+			t.Fatalf("cache retains raw usage rows in field %s", field.Name)
+		}
+	}
+	if entryType.Field(2).Type != reflect.TypeOf(usageSummaryResponseDTO{}) {
+		t.Fatalf("cache payload = %s, want compact DTO", entryType.Field(2).Type)
+	}
+}
diff --git a/go/internal/server/static.go b/go/internal/server/static.go
index b41e2843..39cbc504 100644
--- a/go/internal/server/static.go
+++ b/go/internal/server/static.go
@@ -10,7 +10,7 @@ import (
 	"strings"
 )
 
-//go:embed static/*
+//go:embed static/* static-manifest.json
 var staticAssets embed.FS
 
 var guiMIME = map[string]string{
diff --git a/go/internal/server/static_test.go b/go/internal/server/static_test.go
index 3fbbe271..130915c7 100644
--- a/go/internal/server/static_test.go
+++ b/go/internal/server/static_test.go
@@ -1,6 +1,9 @@
 package server
 
 import (
+	"crypto/sha256"
+	"encoding/json"
+	"fmt"
 	"io/fs"
 	"net/http"
 	"net/http/httptest"
@@ -50,6 +53,68 @@ func TestStaticHandlerSPAFallbackAndAssetBoundaries(t *testing.T) {
 	}
 }
 
+type embeddedStaticManifest struct {
+	Algorithm string `json:"algorithm"`
+	Files     []struct {
+		Path   string `json:"path"`
+		SHA256 string `json:"sha256"`
+	} `json:"files"`
+}
+
+func TestEmbeddedGUIBundleMatchesCommittedManifest(t *testing.T) {
+	manifestData, err := fs.ReadFile(staticAssets, "static-manifest.json")
+	if err != nil {
+		t.Fatal(err)
+	}
+	var manifest embeddedStaticManifest
+	if err := json.Unmarshal(manifestData, &manifest); err != nil {
+		t.Fatalf("decode static manifest: %v", err)
+	}
+	if manifest.Algorithm != "sha256" || len(manifest.Files) == 0 {
+		t.Fatalf("invalid static manifest header: %#v", manifest)
+	}
+	want := make(map[string]string, len(manifest.Files))
+	for _, file := range manifest.Files {
+		if file.Path == "" || file.SHA256 == "" {
+			t.Fatalf("invalid static manifest row: %#v", file)
+		}
+		if _, duplicate := want[file.Path]; duplicate {
+			t.Fatalf("duplicate static manifest path: %s", file.Path)
+		}
+		want[file.Path] = file.SHA256
+	}
+	embedded, err := fs.Sub(staticAssets, "static")
+	if err != nil {
+		t.Fatal(err)
+	}
+	err = fs.WalkDir(embedded, ".", func(name string, entry fs.DirEntry, walkErr error) error {
+		if walkErr != nil || entry.IsDir() {
+			return walkErr
+		}
+		data, readErr := fs.ReadFile(embedded, name)
+		if readErr != nil {
+			return readErr
+		}
+		got := fmt.Sprintf("%x", sha256.Sum256(data))
+		expected, ok := want[name]
+		if !ok {
+			t.Errorf("embedded GUI has stale unmanifested file: %s", name)
+			return nil
+		}
+		delete(want, name)
+		if got != expected {
+			t.Errorf("embedded GUI hash mismatch: %s got=%s want=%s", name, got, expected)
+		}
+		return nil
+	})
+	if err != nil {
+		t.Fatal(err)
+	}
+	for missing := range want {
+		t.Errorf("manifest references missing embedded GUI file: %s", missing)
+	}
+}
+
 func TestEmbeddedGUIBundleMatchesSourceDistWhenPresent(t *testing.T) {
 	dist := os.Getenv("OPENCODEX_GUI_DIST")
 	if dist == "" {
```

## Generated replacement receipt

The clean build contains 46 files. It deletes the two stale assets
`assets/index-B340_XKi.js` and `assets/index-CMip1DzF.css`, adds
`assets/index-DTh7bh_K.js` and `assets/index-B2J4t3te.css`, updates
`index.html`, and preserves every other existing static path.

The committed manifest must equal:

```json
{
  "algorithm": "sha256",
  "files": [
    {
      "path": "assets/index-B2J4t3te.css",
      "sha256": "0836fadd0f15a54ed54c024bf9e9b35a82bef1bca5d430baa01f893533841a65"
    },
    {
      "path": "assets/index-DTh7bh_K.js",
      "sha256": "2b614720b78e05187f8753eb852f66976a7ae2113ea3a085b018e63a7c42c916"
    },
    {
      "path": "favicon.png",
      "sha256": "0dfa176e08be157972df8fc20026fdb90d2119796f3158de30c07bcefbc88ef8"
    },
    {
      "path": "icons.svg",
      "sha256": "b45fa506195cfcdef406ba9f0c77b36ddc1a7c224040926ec70abc2fdea7b93a"
    },
    {
      "path": "index.html",
      "sha256": "e72ea53c6ef4b59d90b8f18c2dfab253ea3234b6f6646c21eb913bd415d500a4"
    },
    {
      "path": "logo.png",
      "sha256": "33d8e0753ca43f1d598e49800a2a9386346469ec32edf3e93f254160e2942132"
    },
    {
      "path": "provider-icons/README.md",
      "sha256": "44da8bd21ac3f75f383ba150604500ef55c8c8058a61a5796b466b40a4d3e4f2"
    },
    {
      "path": "provider-icons/alibaba-color.svg",
      "sha256": "bd57c416a7e64e6e10a017c1589c97093d5f482179259e42811884a5fc664401"
    },
    {
      "path": "provider-icons/antigravity-color.svg",
      "sha256": "ccf54fbd7d2b7384421ed03fc980ea8e6b08bf9d616e1f49c92cf0bff9706a35"
    },
    {
      "path": "provider-icons/antigravity.svg",
      "sha256": "078f2fbe3ab6d60c62e91bad10d265c6bf796acc5fefc5ded61eb41aa44daec0"
    },
    {
      "path": "provider-icons/claude-color.svg",
      "sha256": "a3101f3047a119aa11825ad9369510f0c472428c8c52d420e31bc62db44a8364"
    },
    {
      "path": "provider-icons/claude.svg",
      "sha256": "365a70a7eb3956d9b9a96086058ebe04e1dbd8e291a756ad964e8a283fbd6d38"
    },
    {
      "path": "provider-icons/cloudflare-ai-gateway-color.svg",
      "sha256": "dc0cd6400a99a38669a66d3a8c16a6e2e6a6be3585f286c725d0dac8288ad5f1"
    },
    {
      "path": "provider-icons/copilot-color.svg",
      "sha256": "8a72bfcbb38c3ee6c8d6cead727db8fbbf6df59270758aca313f01431c91ddfc"
    },
    {
      "path": "provider-icons/copilot.svg",
      "sha256": "8a72bfcbb38c3ee6c8d6cead727db8fbbf6df59270758aca313f01431c91ddfc"
    },
    {
      "path": "provider-icons/cursor-color.svg",
      "sha256": "d8c3200003ff0e629f003f8ed19414ce8a559c851c8784f8187c318d9b24a04e"
    },
    {
      "path": "provider-icons/cursor.svg",
      "sha256": "1398c920f3d6eabca015a53736183db63a06139c723039898efa48bd5e3769a3"
    },
    {
      "path": "provider-icons/deepseek-color.svg",
      "sha256": "7c589762f606473ebe6472eb79f2189221af136f8474ed9c8e8c43549ae6d80e"
    },
    {
      "path": "provider-icons/discord.svg",
      "sha256": "eb19bf9eb26474246b8d8993556b57727a9621be5b2d42c54516302bfe2183dd"
    },
    {
      "path": "provider-icons/firepass-color.svg",
      "sha256": "ab4d12ace56969e5b829b4ae28e6c32de77cb529131aa737657ad3b8eb2fa477"
    },
    {
      "path": "provider-icons/fireworks-color.svg",
      "sha256": "ab4d12ace56969e5b829b4ae28e6c32de77cb529131aa737657ad3b8eb2fa477"
    },
    {
      "path": "provider-icons/gemini-color.svg",
      "sha256": "8ab0a9bafec11f7e69bcb9fc4ffd8f1bc927d1ddcbbb6ff36dee5ae8b5a9d602"
    },
    {
      "path": "provider-icons/gemini.svg",
      "sha256": "87d5b3c4be75a66f54c1936482a263df68185545b741129badd1b7c2449c18d3"
    },
    {
      "path": "provider-icons/github-copilot-color.svg",
      "sha256": "1d8a4a13c08d5fa0eba2a830ba531dfadbad26dc093000fd6da734de16a011d8"
    },
    {
      "path": "provider-icons/gitlab-duo-color.svg",
      "sha256": "eea41a3fdcb9ce948412f8787a8fec356ca6d529fc39fe892d17f1f89353c37c"
    },
    {
      "path": "provider-icons/grok-color.svg",
      "sha256": "28b94bc472bc26504f8ab8c6922b36871ad3f1986aea5e378a4e3afcb417c474"
    },
    {
      "path": "provider-icons/grok.svg",
      "sha256": "28b94bc472bc26504f8ab8c6922b36871ad3f1986aea5e378a4e3afcb417c474"
    },
    {
      "path": "provider-icons/groq-color.svg",
      "sha256": "7f4650654b1ca5cd6f0c4c9249e026fdd0e0b42031a814c396512739d21c2c88"
    },
    {
      "path": "provider-icons/huggingface-color.svg",
      "sha256": "9de53676f200f24c390edbdb54892d9d5059e1880b5ee45e8281130fcc36c47c"
    },
    {
      "path": "provider-icons/kimi-color.svg",
      "sha256": "6a61b1d38b6baba60e2637f1a10074ac6823b252e2f50ac0f1ae53210ac927fc"
    },
    {
      "path": "provider-icons/kiro-color.svg",
      "sha256": "6fae5cb4a621f0f6d1c0c903d92e156c28715cdfe9d954c4260d6b9413b04ecf"
    },
    {
      "path": "provider-icons/kiro.svg",
      "sha256": "3d7376c4dfb1f47a8889ba5d0c2c8bd8cc6b0ff1c639f7b5db1be60479d0dc0a"
    },
    {
      "path": "provider-icons/lm-studio-color.svg",
      "sha256": "c7efedbfe06dc5467a6bf8eb924331daf5ee8da089ec17d1bc6cfb72c2f4cbf1"
    },
    {
      "path": "provider-icons/mistral-color.svg",
      "sha256": "35c9162a6a94a0205bece86a701cf29c21776ab42b3149d64e2a915d99bd5e83"
    },
    {
      "path": "provider-icons/moonshot-color.svg",
      "sha256": "6a61b1d38b6baba60e2637f1a10074ac6823b252e2f50ac0f1ae53210ac927fc"
    },
    {
      "path": "provider-icons/nvidia-color.svg",
      "sha256": "c2cc8b409c548cf8b24ca8a9110af8445bec470b18f1eed455b79ce8a711aa17"
    },
    {
      "path": "provider-icons/ollama-color.svg",
      "sha256": "75bd6714d474b5802f171fd7e01aa975a18057e4ea74868f62631e743a3fb5ff"
    },
    {
      "path": "provider-icons/openai.svg",
      "sha256": "a595df6b423920c67a7f8f73c063e4bfb72d415948097b6cac063a2366bb5186"
    },
    {
      "path": "provider-icons/opencode.svg",
      "sha256": "cd7bfba5cd532ea2ab04f4cd38da807b74753bf327769f117277636108fcbbf2"
    },
    {
      "path": "provider-icons/openrouter-color.svg",
      "sha256": "25a9dffc13c2b7b51b57fa959f2ebdb69e36ae09222b07c3b3b33d1a93961d28"
    },
    {
      "path": "provider-icons/qianfan-color.svg",
      "sha256": "2ab1b388595337bb3950bb520be943404dfb9c9abcd7fb2fcab87ea30aa7f184"
    },
    {
      "path": "provider-icons/qwen-portal-color.svg",
      "sha256": "d3a18b76f02dedfdda0b5324c0a725a93db0c79aa98cb5d9f79aef20fcf7356f"
    },
    {
      "path": "provider-icons/telegram.svg",
      "sha256": "2c1711092b15e5a305480159474cb99cca21638803295740f1b4e158dfd66c44"
    },
    {
      "path": "provider-icons/vercel-ai-gateway-color.svg",
      "sha256": "79e4798fd9d404bda70aab8103f4408579094aa5cb0f6d0c535a15cc169f041f"
    },
    {
      "path": "provider-icons/vllm-color.svg",
      "sha256": "5f0fe3440618d77f80fb88575f62faf5ef34d2b95855769a7b6099adf18b47f4"
    },
    {
      "path": "provider-icons/xiaomi-color.svg",
      "sha256": "d3735c77781b564e4baaabd75ab8c6d30e74432de76c8de64e53b48d90218b8c"
    }
  ]
}
```

## Deterministic build and sync

```bash
bun install --frozen-lockfile
(
  cd gui
  bun install --frozen-lockfile
  bun run test
  bun run build
)
test -f gui/dist/index.html
test -n "$(find gui/dist -type f -print -quit)"
git rm -r --ignore-unmatch go/internal/server/static
mkdir -p go/internal/server/static
cp -R gui/dist/. go/internal/server/static/
diff -ru --no-dereference gui/dist go/internal/server/static
bun -e 'import { createHash } from "node:crypto"; import { readdirSync, readFileSync, writeFileSync } from "node:fs"; import { join, relative, sep } from "node:path"; const root="go/internal/server/static"; const order=(a,b)=>a<b?-1:a>b?1:0; const files=[]; const walk=(dir)=>{for(const entry of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>order(a.name,b.name))){const full=join(dir,entry.name); if(entry.isDirectory()) walk(full); else if(entry.isFile()){const path=relative(root,full).split(sep).join("/"); const sha256=createHash("sha256").update(readFileSync(full)).digest("hex"); files.push({path,sha256});} else throw new Error("unsupported static entry: "+full);}}; walk(root); files.sort((a,b)=>order(a.path,b.path)); if(files.length===0) throw new Error("empty static tree"); writeFileSync("go/internal/server/static-manifest.json",JSON.stringify({algorithm:"sha256",files},null,2)+"\n");'
```

After generation, the manifest bytes must match the JSON receipt above,
recursive `gui/dist` and `go/internal/server/static` diffs must be empty, and
`TestEmbeddedGUIBundleMatchesCommittedManifest` must pass from a fresh clone.



