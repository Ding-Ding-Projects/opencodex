# 060 — Canonical response-state temp recovery

## Goal

Promote the current-dev interrupted response-state write contract from below S1
to S3 in the native runtime without broadening cleanup authority.

## Build delta

- `go/internal/server/responses_state.go`
  - derive the canonical temp prefix from the actual snapshot path
    (`<snapshot>.ocx.<pid>.<sequence>.tmp`) and add exact basename parsing plus the 15-minute, 4,096-entry, and
    512-attempt limits;
  - add a result DTO with matched, removed, failed, and bytes-removed counters;
  - add injectable clock/list/inspect/liveness/unlink seams for deterministic
    package tests while keeping the production entry private;
  - enumerate incrementally, contain open/read/iteration errors, reject symlinks
    and non-regular files, skip current/live/young writers, and unlink only;
  - call recovery once in `ensureLoadedLocked` before snapshot existence/read,
    without allowing recovery failure to block a valid snapshot;
  - replace `.responses-state-*` with an exclusive canonical
    `<snapshot>.ocx.<pid>.<sequence>.tmp` writer using a process-local
    atomic sequence; retain mode 0600, sync, close, rename, and deferred unlink.
- `go/internal/platform/process.go` plus platform-specific helper files if
  required
  - add a conservative process-existence primitive that returns false only for
    definite process absence; do not change lifecycle-oriented `ProcessAlive`.
- `structure/02_config-and-codex-home.md`
  - correct the contradictory truncation sentence to state unlink-only cleanup.

## Activation tests

- Direct helper tests: stale dead PID, live/current PID, young file, malformed
  name, zero/overflow PID or sequence, symlink, directory, inspect failure,
  unlink failure, byte accounting, entry cap, cleanup cap, and iterator failure.
- Writer test: exact canonical name, exclusive creation, mode 0600, and no
  residual after successful rename.
- Production-root test: construct `server.New` with a real `ConfigPath`, place a
  stale Bun-era canonical residual, enter through a Responses request that lazy
  loads state, and prove deletion plus successful request handling.
- Compatibility test: a Go-written abandoned canonical residual is reclaimed by
  the same path.

## Gates

```bash
go test ./internal/server ./internal/platform -count=1
go test ./... -count=1 -timeout 400s
go vet ./...
GOOS=windows GOARCH=amd64 go build ./...
GOOS=linux GOARCH=amd64 go build ./...
```
