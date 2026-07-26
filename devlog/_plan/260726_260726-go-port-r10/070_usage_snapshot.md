# 070 — Revision-safe native usage snapshots

## Goal

Give the Go management runtime a stable, regular-file-only usage snapshot owner
that avoids duplicate concurrent full reads and detects replacement/truncation.

## Audit fold-back and root-cause record

- H1 confirmed: copying only `[]Entry` shares `Usage`, scalar pointers,
  `Attempts`, and each attempt's nested state across callers. Every returned row
  must therefore be cloned recursively.
- H2 confirmed: holding `Log.mu.RLock` while waiting couples snapshot latency to
  `Append`/`Clear`, and a context-free leader makes cancellation contagious.
  The shared read must run independently while each waiter selects on its own
  request context.
- H3 confirmed: a sleep-based coalescing test does not prove all readers joined
  the same flight. Test-only acquire/read barriers must make that ordering
  deterministic, then the race test is repeated.

## Build delta

- `go/internal/usage/log.go`
  - add a revision value covering path, device, inode, birth/change/modify time,
    and size, with a stable key and explicit missing state;
  - open first, reject non-regular files from `fstat`, and read exactly the
    observed byte length; short reads fail instead of silently mixing revisions;
  - expose `CurrentRevision` and context-aware `ReadSnapshotForManagement`
    without changing
    the existing append/read APIs used by non-management callers;
  - share one in-flight result only when callers observed the same revision;
    run that read independently from any one caller, bound revision churn to
    64 retries, and let cancellation stop only the waiting caller;
  - deep-clone all entry pointers, attempt slices, recovery slices, and nested
    usage values before returning to each caller;
  - never hold `Log.mu` while waiting or parsing, so append/clear remain live;
  - release rows after all waiters finish;
  - add test-only counters for full reads and parsed lines, never production row
    retention.
- `go/internal/usage/revision_{darwin,linux,windows}.go`
  - derive native file identity from the already-open descriptor: device/inode
    and ctime on Unix, birthtime where the platform exposes it, and Windows volume
    serial/file index plus creation/change/write times through `x/sys/windows`;
  - use zero only for a timestamp the OS genuinely does not expose, matching the
    TS revision-key role without inventing unstable identities;
  - keep unsupported-platform compilation behind a conservative fallback that
    still includes path, size, and modify/change observations.
- `go/internal/management/logs.go`
  - activate the snapshot owner in the real `GET /api/usage` handler and pass
    `r.Context()` through the read boundary.
- `go/internal/server/usage_snapshot_concurrency_test.go`
  - drive the registered production server with a large valid JSONL rebuild and
    prove `/healthz` completes while the snapshot call is retained.

Go request handlers already run in independent goroutines, so the TS event-loop
`setTimeout(0)` batching is not copied mechanically. A production concurrency
test must instead prove a large usage rebuild does not prevent `/healthz` from
completing.

## Tests

- missing, directory, regular file, exact revision key, append, truncate, atomic
  replacement, and same-size timestamp/identity change;
- exact observed-length read and short-read failure using injected file seams;
- identical revision callers share one parse; a changed revision does not join
  the old in-flight read; two waiters on that same shared flight receive nested
  values that cannot mutate each other;
- cancellation releases one waiter without cancelling a shared read or blocking
  append, while revision churn terminates at the named retry bound;
- deterministic acquire/read barriers replace timing sleeps, with the focused
  same-flight race test repeated twenty times;
- same-size rewrite changes the revision and Darwin/Linux/Windows expose native
  device/inode identity; all three platform variants cross-compile;
- malformed/partial JSONL tolerance remains unchanged;
- the real `/api/usage` rebuild and `/healthz` run concurrently.

## Gates

```bash
go test -race ./internal/usage -count=1
go test -race ./internal/usage -run 'TestReadSnapshot(SameRevisionSharesOneReadAndClonesSlices|CancellationDoesNotCancelSharedReadOrBlockAppend|DeepClonesNestedEntryState)' -count=20
go test ./internal/usage ./internal/management ./internal/server -count=1
go test ./internal/server -run TestProductionUsageSnapshotRebuildDoesNotBlockHealthz -count=1
go vet ./...
```
