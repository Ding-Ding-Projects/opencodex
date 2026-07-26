# WP15 — Revision-keyed usage summaries and current embedded GUI

Date: 2026-07-27
Base: `77b2aa8b`
Class: C3 (production management API cache and generated embedded dashboard)

## Outcome

Make repeated `GET /api/usage` requests retain only compact response DTOs for
an exact usage-log revision, while keeping time-window results correct and
serving the current independently polled dashboard from the Go binary.

The cache must never retain `[]usage.Entry`. It is bounded to the parsed
`range × surface` key space (3 × 4), invalidates on revision change, expires
at the earliest moving-window boundary or local midnight, and refreshes
`since` and `generatedAt` on hits. Read failures return the TypeScript
contract's stable HTTP 200 empty DTO with `error: "read_failed"` and do not
poison recovery.

## Current-lineage findings

The historical hand packet did not apply at `77b2aa8b` because WP13 changed
`management.New` from a direct return literal to a constructed `api` value
that binds the shared config mutex. The candidate preserves that constructor
shape, appends the cache clock/map initialization to the existing value, and
leaves mutex binding order unchanged.

The first isolated GUI test attempt lacked root dependencies and failed to
resolve `zod/v4`; after the required root `bun install --frozen-lockfile`,
the unchanged GUI source passed 294/0 and built successfully. This is a prepared
workspace prerequisite, not a source workaround.

One affected-package race run observed the pre-existing watchdog shutdown timing
test fail once under package-wide load. The unchanged base and candidate both
passed the isolated race test 20/20. This remains baseline timing evidence, not
a waived candidate failure; the final C gate reruns the full race suite.

## First audit and redesign

The first independent `gpt-5.6-sol` medium-priority audit returned
`VERDICT: FAIL`. It found that rebuilding during the sub-millisecond interval
after a nominal row boundary could include the row under the summary's
millisecond cutoff, then ignore its already-past expiry and cache the overcount
until midnight.

The TypeScript cache has the same flaw, but copying it would violate this
phase's moving-window correctness gate. The Go cache now expires at
`timestamp + window + 1ms`, the first millisecond at which
`usage.Summarize` excludes the row. Tests cover the exact boundary, the final
nanosecond before exclusion, and the first excluded millisecond. The TypeScript
source remains unchanged and the verified oracle defect is recorded rather
than hidden as a runtime-diff exemption.

## Cache ownership

`management.API` owns:

- a mutex protecting revision observation, cache lookup, snapshot rebuild, and
  publish;
- an injected clock used by deterministic expiry tests;
- at most twelve `usageSummaryCacheEntry` values containing only revision key,
  expiry, and compact `usageSummaryResponseDTO`.

A cold-miss concurrency regression releases 32 registered HTTP requests at
once, requires identical responses, one cache row, and exactly one full log
read under `-race`. The existing usage snapshot owner remains responsible for
exact-revision file reads and cancellation.

## Expiry and failure behavior

- 7d/30d entries expire one millisecond after the nominal fixed-window
  boundary, exactly when the millisecond summary cutoff first excludes the row.
- Every key expires at the next local midnight so day buckets are rebuilt.
- Hits refresh only `since` and `generatedAt`; compact aggregate slices are
  immutable and reused.
- Append, replacement, truncation, or identity change produces a new revision
  key and rebuild.
- Read failure returns normalized range/surface, zero totals, empty non-null
  arrays, `since: null`, and `error: "read_failed"`; no failed response is
  cached.

## Embedded GUI contract

No GUI source or design is changed. The existing React dashboard remains the
source of truth and its 294 tests lock the independent 60-second usage poll
apart from the five-second core poll.

A clean Vite build replaces the complete embedded tree mechanically. The
candidate contains 46 files and a sorted SHA-256 manifest. The replacement:

- deletes stale `assets/index-B340_XKi.js` and
  `assets/index-CMip1DzF.css`;
- adds `assets/index-DTh7bh_K.js` and
  `assets/index-B2J4t3te.css`;
- updates `index.html`;
- preserves every root image, SVG, README, and provider icon exactly;
- embeds and verifies `static-manifest.json` in normal Go CI.

The source-dist and embedded trees must have identical recursive inventory and
bytes. Generated minified assets are never hand-edited.

Headless Chrome rendered the built bundle at 1440×779 and 500×723. The
dashboard shell, Usage navigation, surface/range controls, retry state, and
mobile menu remained visible without clipping, and a reload produced no console
errors. The static-only Vite preview intentionally returned its HTML fallback
for `/api/usage`, so the visible read error is not treated as backend evidence;
the registered Go API behavior is covered by the production HTTP tests.

## File map

Hand-authored source: five files, 11 hunks, 416 insertions and 13 deletions:

- `go/internal/management/api.go`
- `go/internal/management/logs.go`
- new `go/internal/management/usage_cache_test.go`
- `go/internal/server/static.go`
- `go/internal/server/static_test.go`

Generated output adds `go/internal/server/static-manifest.json`, replaces the
complete static tree, and yields a total candidate delta of 11 files,
673 insertions and 68 deletions.

## Acceptance criteria

- Unchanged revision hits perform no second full read and refresh clock fields.
- Append and atomic replacement invalidate; range/surface keys remain isolated.
- 7d/30d rows remain included at the exact boundary and through its
  sub-millisecond remainder, then rebuild at the first excluded millisecond;
  local-midnight boundaries also rebuild.
- Thirty-two concurrent cold misses publish one compact cache row after one
  full read and remain race-clean.
- Read failure is stable HTTP 200 and a later valid append recovers.
- Reflection and public-path tests prove no raw usage row retention.
- Current GUI source passes 294/0, builds, matches the embedded tree byte for
  byte, and its manifest has no stale or missing file.
- The rendered dashboard is smoke-tested at desktop and mobile without a
  source/design delta.

## Resource and safety bounds

Writes are limited to the five Go source/test files, generated
`go/internal/server/static/**`, its manifest, and these two plan files. No
provider credentials, network API, publish, workflow, release, or TypeScript
oracle edit is allowed. Root/GUI dependency installation is frozen-lockfile
only. Individual test/build/browser waits are bounded; the user imposed no
overall time or token budget.

## Gates

```bash
bun install --frozen-lockfile
(cd gui && bun install --frozen-lockfile && bun run test && bun run build)
diff -ru --no-dereference gui/dist go/internal/server/static
bun test gui/tests/dashboard-contracts.test.ts
cd go
go test ./internal/usage ./internal/management ./internal/server -count=1 -timeout 180s
go test -race ./internal/usage ./internal/management ./internal/server -count=3 -timeout 240s
go test ./... -count=1 -timeout 400s
go test -race ./... -count=1 -timeout 600s
go vet ./...
GOOS=windows GOARCH=amd64 go build ./...
GOOS=linux GOARCH=amd64 go build ./...
```

Before D, fetch `origin/dev`, regenerate the source packet and generated
manifest if the parent moved, require an independent `gpt-5.6-sol`
medium-priority `VERDICT: PASS`, and visually inspect the real built dashboard.
