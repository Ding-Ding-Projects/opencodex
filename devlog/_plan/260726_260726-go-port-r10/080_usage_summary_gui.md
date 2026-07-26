# 080 — Native usage summary cache and current GUI

## Goal

Cache only compact `/api/usage` responses for exact revisions and ship the
current GUI polling and Claude auth-auto contracts through the Go embedded server.
This phase runs after `wp-orca-home`, so the rebuilt GUI is not committed before
the management API and all current-dev native behavior it consumes are present.

## Build delta

- `go/internal/management/api.go`, `go/internal/management/logs.go`
  - add an API-owned `range:surface` cache containing the final
    `usageSummaryResponseDTO`, revision key, and expiry only;
  - protect the cache with an API-owned mutex because management requests run in
    parallel goroutines; keep its key space bounded by parsed range/surface enums;
  - rebuild from context-aware `ReadSnapshotForManagement`, preserving
    resolved-model output without retaining raw rows;
  - invalidate on any revision change, the earliest matching 7d/30d entry
    expiry, or next local midnight;
  - refresh `since` and `generatedAt` on hits;
  - match the TS read-failure contract with HTTP 200, empty summary, and
    `error: "read_failed"` rather than a native-only 500.
- `go/internal/server/static/**`
  - build the current `gui/` source and replace the complete generated embedded
    tree, including root `index.html`, every hashed asset, and deletion of stale
    hashed files;
  - do not hand-edit generated JavaScript.
- `go/internal/server/static_test.go` and focused management tests
  - make source-vs-embedded verification non-skipping in the normal prepared
    workspace;
  - assert the core five-second poll excludes usage, the independent usage poll
    is sixty seconds, and a failed refresh preserves the last success.

The generated tree is synchronized mechanically from `gui/dist/`, not represented
as hand-authored minified hunks. The literal packet must provide the exact clean
build, full-tree replacement, stale-file deletion, inventory receipt, and
source-vs-embedded hash/content assertion.

## Production activation tests

- Real `/api/usage`: unchanged hit, append invalidation, replacement
  invalidation, local-midnight expiry, 7d/30d boundary expiry, and surface-key
  separation.
- Read failure returns the exact stable empty DTO and does not poison a later
  successful rebuild.
- Retain the large-rebuild `/healthz` production-path proof established by 071;
  cached and uncached `/api/usage` requests must preserve that independence.
- Cache inspection/test hooks prove compact DTO retention only; no `[]usage.Entry`
  survives the request.

## Gates

```bash
bun run build:gui
go test -race ./internal/usage ./internal/management ./internal/server -count=1
go test ./... -count=1 -timeout 400s
go vet ./...
```
