# 070 — Revision-safe native usage snapshots

## Goal

Give the Go management runtime a stable, regular-file-only usage snapshot owner
that avoids duplicate concurrent full reads and detects replacement/truncation.

## Build delta

- `go/internal/usage/log.go`
  - add a revision value covering path, device, inode, birth/change/modify time,
    and size, with a stable key and explicit missing state;
  - open first, reject non-regular files from `fstat`, and read exactly the
    observed byte length; short reads fail instead of silently mixing revisions;
  - expose `CurrentRevision` and `ReadSnapshotForManagement` without changing
    the existing append/read APIs used by non-management callers;
  - share one in-flight result only when callers observed the same revision;
    return cloned entry slices and release rows after all waiters finish;
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

Go request handlers already run in independent goroutines, so the TS event-loop
`setTimeout(0)` batching is not copied mechanically. A production concurrency
test must instead prove a large usage rebuild does not prevent `/healthz` from
completing.

## Tests

- missing, directory, regular file, exact revision key, append, truncate, atomic
  replacement, and same-size timestamp/identity change;
- exact observed-length read and short-read failure using injected file seams;
- identical revision callers share one parse; a changed revision does not join
  the old in-flight read; returned slices cannot mutate each other;
- malformed/partial JSONL tolerance remains unchanged;
- race and repeated tests for the in-flight owner.

## Gates

```bash
go test -race ./internal/usage -count=1
go test ./internal/usage ./internal/management ./internal/server -count=1
go vet ./...
```
