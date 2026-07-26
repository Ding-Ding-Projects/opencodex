# 081 — Usage summary cache and embedded GUI literal patch

## Preconditions and apply order

Apply this packet after the full dependency prefix:

`061 → 071 → 091 → 101 → 111 → 121 → 123 → 127`

It depends directly on `071_usage_snapshot_literal_patch.md` and also assumes
the `API` constructor fields introduced by `101` and the Codex router wiring
introduced by `123`/`127`. Its native usage API must have these exact semantics:
native usage API having these exact semantics:

```go
revision, err := log.CurrentRevision()
snapshot, err := log.ReadSnapshotForManagement()
revision.Key() string
snapshot.Revision.Key() string
snapshot.Entries []usage.Entry
```

These are the exact names exported by 071: `usage.Revision`, `usage.Snapshot`,
`(*usage.Log).CurrentRevision`, `(*usage.Log).ReadSnapshotForManagement`, and
`(*usage.Log).SnapshotStatsForTests`. The snapshot identifies missing files as a
stable revision, rejects non-regular files, reads only the observed length, and
coalesces concurrent reads for one revision.

Apply the hand-authored diffs below, run `gofmt` on changed Go files, then run
the deterministic GUI build/sync packet. Generated `gui/dist/**` and
`go/internal/server/static/**` are build output and must never be hand-edited.

## Hand-authored patch

```diff
diff --git a/go/internal/management/api.go b/go/internal/management/api.go
--- a/go/internal/management/api.go
+++ b/go/internal/management/api.go
@@ -5,5 +5,6 @@ import (
 	"net/url"
 	"runtime"
 	"sync"
+	"time"
 
 	"github.com/lidge-jun/opencodex-go/internal/claude"
@@ -87,5 +88,8 @@ type API struct {
 	contextCaps         map[string]int
 	combos              map[string]Combo
 	agents              AgentSettings
+	now                 func() time.Time
+	usageCacheMu        sync.Mutex
+	usageSummaryCache   map[string]usageSummaryCacheEntry
 	debugEnabled        bool
 }
@@ -130,2 +134,2 @@ func New(options Options) (*API, error) {
-	return &API{config: cfg, configPath: options.ConfigPath, configPersistence: options.ConfigPersistence, registry: options.Registry, usageLog: options.UsageLog, debugLog: options.DebugLog, requestLogs: options.RequestLogs, advancedRequestLogs: options.AdvancedRequestLogs, memoryWatchdog: options.MemoryWatchdog, responseState: options.ResponseState, providerDNSLookup: options.ProviderDNSLookup, oauth: options.OAuth, codexAuth: options.CodexAuth, codexRouter: options.CodexRouter, providerDebug: options.DebugLogs, injectionDebug: options.InjectionLogs, claudeDebug: options.ClaudeDebug, providerQuotas: options.ProviderQuotas, claudeRuntime: options.ClaudeRuntime, runtimeControl: options.RuntimeControl, grokPort: options.GrokPort, grokHostname: options.GrokHostname, fetchModels: options.FetchModels, storageHome: options.StorageHome, version: options.Version, stop: options.Stop, refreshCatalog: options.RefreshCatalog, onAPIKeysChanged: options.OnAPIKeysChanged, modelCache: options.ModelCache, authorize: options.Authorize, customModels: customModels, aliases: map[string]string{}, contextCaps: cloneIntMap(cfg.ProviderContextCaps), combos: map[string]Combo{}, agents: agents}, nil
+	return &API{config: cfg, configPath: options.ConfigPath, configPersistence: options.ConfigPersistence, registry: options.Registry, usageLog: options.UsageLog, debugLog: options.DebugLog, requestLogs: options.RequestLogs, advancedRequestLogs: options.AdvancedRequestLogs, memoryWatchdog: options.MemoryWatchdog, responseState: options.ResponseState, providerDNSLookup: options.ProviderDNSLookup, oauth: options.OAuth, codexAuth: options.CodexAuth, codexRouter: options.CodexRouter, providerDebug: options.DebugLogs, injectionDebug: options.InjectionLogs, claudeDebug: options.ClaudeDebug, providerQuotas: options.ProviderQuotas, claudeRuntime: options.ClaudeRuntime, runtimeControl: options.RuntimeControl, grokPort: options.GrokPort, grokHostname: options.GrokHostname, fetchModels: options.FetchModels, storageHome: options.StorageHome, version: options.Version, stop: options.Stop, refreshCatalog: options.RefreshCatalog, onAPIKeysChanged: options.OnAPIKeysChanged, modelCache: options.ModelCache, authorize: options.Authorize, customModels: customModels, aliases: map[string]string{}, contextCaps: cloneIntMap(cfg.ProviderContextCaps), combos: map[string]Combo{}, agents: agents, now: time.Now, usageSummaryCache: make(map[string]usageSummaryCacheEntry, 12)}, nil
 }
diff --git a/go/internal/management/logs.go b/go/internal/management/logs.go
--- a/go/internal/management/logs.go
+++ b/go/internal/management/logs.go
@@ -293,14 +293,5 @@ func (a *API) handleLogs(w http.ResponseWriter, r *http.Request) bool {
 	case "GET /api/usage":
 		window := usage.ParseRange(r.URL.Query().Get("range"))
 		surface := usage.ParseSurface(r.URL.Query().Get("surface"))
-		if a.usageLog == nil {
-			writeJSON(w, http.StatusOK, usage.Summarize(nil, window, time.Now(), surface))
-			return true
-		}
-		entries, err := a.usageLog.ReadAll()
-		if err != nil {
-			writeError(w, http.StatusInternalServerError, "usage log could not be read")
-			return true
-		}
-		writeJSON(w, http.StatusOK, usageSummaryResponse(usage.Summarize(entries, window, time.Now(), surface), entries))
+		writeJSON(w, http.StatusOK, a.usageSummary(window, surface, a.now()))
 		return true
@@ -337,6 +328,12 @@ type usageModelResponse struct {
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
@@ -347,3 +344,4 @@ type usageSummaryResponseDTO struct {
 	Models      []usageModelResponse    `json:"models"`
 	Providers   []usage.ProviderSummary `json:"providers"`
+	Error       string                  `json:"error,omitempty"`
 }
@@ -369,4 +367,103 @@ func usageSummaryResponse(summary usage.Summary, entries []usage.Entry) usageSummaryResponseDTO {
 	}
 }
+
+func (a *API) usageSummary(window usage.Range, surface string, now time.Time) usageSummaryResponseDTO {
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
+	snapshot, err := a.usageLog.ReadSnapshotForManagement()
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
+		expiry := time.UnixMilli(entry.Timestamp).Add(windowDuration)
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
 
 func debugLogQuery(r *http.Request) (int, int) {
diff --git a/go/internal/management/usage_cache_test.go b/go/internal/management/usage_cache_test.go
new file mode 100644
--- /dev/null
+++ b/go/internal/management/usage_cache_test.go
@@ -0,0 +1,177 @@
+package management
+
+import (
+	"encoding/json"
+	"net/http"
+	"net/http/httptest"
+	"os"
+	"path/filepath"
+	"reflect"
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
+func TestUsageSummaryExpiryAndRefreshedClockFields(t *testing.T) {
+	now := time.Date(2026, 7, 26, 23, 59, 0, 0, time.Local)
+	entry := usageTestEntry("boundary", now.Add(-7*24*time.Hour+time.Minute), "")
+	expiry := usageSummaryExpiresAt([]usage.Entry{entry}, usage.Range7D, "codex", now)
+	if want := time.UnixMilli(entry.Timestamp).Add(7 * 24 * time.Hour); !expiry.Equal(want) {
+		t.Fatalf("range expiry = %s, want %s", expiry, want)
+	}
+	entry30d := usageTestEntry("boundary-30d", now.Add(-30*24*time.Hour+time.Minute), "")
+	if got, want := usageSummaryExpiresAt([]usage.Entry{entry30d}, usage.Range30D, "codex", now), time.UnixMilli(entry30d.Timestamp).Add(30*24*time.Hour); !got.Equal(want) {
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
+	current = now.Add(61 * time.Second)
+	_, expired := usageRequest(t, api, "/api/usage?range=7d")
+	if expired.Summary.Requests != 0 || log.SnapshotStatsForTests().FullReads != readsAfterBuild+1 {
+		t.Fatalf("expired entry remained cached: body=%#v stats=%#v", expired, log.SnapshotStatsForTests())
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
--- a/go/internal/server/static.go
+++ b/go/internal/server/static.go
@@ -13,2 +13,2 @@ import (
-//go:embed static/*
+//go:embed static/* static-manifest.json
 var staticAssets embed.FS
diff --git a/go/internal/server/static_test.go b/go/internal/server/static_test.go
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
@@ -50,4 +53,66 @@ func TestStaticHandlerSPAFallbackAndAssetBoundaries(t *testing.T) {
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
```

The HTTP tests above use the real registered `API.ServeHTTP` production route,
not a helper-only summary call. Revision append/replacement and range/surface
keys are therefore activation evidence. The API mutex covers revision observe,
cache lookup, snapshot rebuild, and publish as one transaction, preventing two
parallel requests from publishing different revisions. It does not block
`/healthz`, which is owned by the server mux and runs in another goroutine. The
071 same-revision coalescing test plus `go test -race` proves the lower-level
read owner; a sleep-based HTTP concurrency test would be nondeterministic and is
intentionally excluded.

## Deterministic GUI build and full-tree sync

Run from the repository root on a clean prepared worktree. `git rm` first is
intentional: it deletes every stale hashed asset and every stale root or nested
file before copying the complete current dist tree.

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
bun -e 'import { createHash } from "node:crypto"; import { readdirSync, readFileSync, writeFileSync } from "node:fs"; import { join, relative, sep } from "node:path"; const root="go/internal/server/static"; const order=(a,b)=>a<b?-1:a>b?1:0; const files=[]; const walk=(dir)=>{for(const entry of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>order(a.name,b.name))){const full=join(dir,entry.name); if(entry.isDirectory()) walk(full); else if(entry.isFile()){const path=relative(root,full).split(sep).join("/"); const sha256=createHash("sha256").update(readFileSync(full)).digest("hex"); files.push({path,sha256});} else throw new Error(`unsupported static entry: ${full}`);}}; walk(root); files.sort((a,b)=>order(a.path,b.path)); if(files.length===0) throw new Error("empty static tree"); writeFileSync("go/internal/server/static-manifest.json",JSON.stringify({algorithm:"sha256",files},null,2)+"\n");'
test -s go/internal/server/static-manifest.json
(
  cd gui/dist
  find . -type f -print | LC_ALL=C sort
) > /tmp/opencodex-gui-dist.inventory
(
  cd go/internal/server/static
  find . -type f -print | LC_ALL=C sort
) > /tmp/opencodex-go-static.inventory
cmp /tmp/opencodex-gui-dist.inventory /tmp/opencodex-go-static.inventory
(
  cd gui/dist
  find . -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256
) > /tmp/opencodex-gui-dist.sha256
(
  cd go/internal/server/static
  find . -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256
) > /tmp/opencodex-go-static.sha256
cmp /tmp/opencodex-gui-dist.sha256 /tmp/opencodex-go-static.sha256
```

The sync includes `index.html`, root images, `provider-icons/**`, every hashed
asset, and any future nested output. No allowlist is permitted. The two
inventories must be byte-identical. `static-manifest.json` is generated after
the replacement and committed beside, not inside, the embedded tree. Its
always-on Go test hashes every embedded file and catches stale, missing, changed,
root-level, and nested files in fresh-clone Go CI. The existing source-vs-dist
comparison remains conditional because `gui/dist` is ignored, while the sync
packet's `diff` and inventory checks make it mandatory in the prepared build.

## Patch-integrity and gates

After 071 and this packet are both materialized, extract the fenced diff and
require `git apply --check` before applying it. Then run:

```bash
gofmt -w go/internal/management/api.go go/internal/management/logs.go \
  go/internal/management/usage_cache_test.go go/internal/server/static_test.go
bun test gui/tests/dashboard-contracts.test.ts
go test -race ./internal/usage ./internal/management ./internal/server -count=1
go test ./... -count=1 -timeout 400s
go vet ./...
diff -ru --no-dereference ../gui/dist internal/server/static
```

Run the final `diff` from `go/`. Commit `go/internal/server/static-manifest.json`
with the fully replaced static tree. `gui/tests/dashboard-contracts.test.ts` already
locks the source contract: core polling excludes `/api/usage`, the independent
resource calls `fetchDashboardUsage`, and its cadence is 60 seconds. The
always-on manifest test proves the committed bytes are complete and unchanged;
the prepared sync comparison proves those bytes are the tested GUI build.
