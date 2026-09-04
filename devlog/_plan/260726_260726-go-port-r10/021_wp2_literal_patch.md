# 021 — WP2 literal candidate contract

## Authority

Base: `9bf232d4b` (rebased over `origin/dev` `58f0fab3109383b398328c98dcea63089773c693`).

Apply the exact candidate whose tracked diff SHA-256 is
`825372b0f546c6c8169a48bbae80f9d7c620edba12979fddff339d50f5731830`.

| File group | Required effect |
| --- | --- |
| `src/lib/runtime-entry.ts`, service/tray/update owners | Validate and persist stable Node launcher, retain Bun fallback |
| `go/internal/cli/runtime_command*.go` | Exact packaged identity, Node canonicalization, race/symlink rejection |
| Go runtime management/service/tray | Distinct launcher prefix and stable persisted argv |
| `go/internal/update/planning*.go` | Direct-Go and Node-launcher restart plans |
| `src/codex/shim.ts`, CLI, launcher | Transactional TS multi-wrapper `refresh-runtime` before Go forwarding |
| `bin/native-runtime.mjs` | Reject symlinked native selections |
| focused TS/Go/Node tests | Execute transition, rollback, argv, identity, and native forwarding proofs |

Exact files and counts:

| File | Add | Delete |
| --- | ---: | ---: |
| `bin/native-runtime.mjs` | 3 | 3 |
| `bin/ocx.mjs` | 57 | 3 |
| `go/internal/cli/management_backends_test.go` | 1 | 1 |
| `go/internal/cli/runtime_command.go` | 135 | 0 |
| `go/internal/cli/runtime_command_test.go` | 281 | 0 |
| `go/internal/cli/runtime_management.go` | 3 | 6 |
| `go/internal/cli/service.go` | 5 | 2 |
| `go/internal/cli/tray.go` | 8 | 3 |
| `go/internal/update/planning.go` | 10 | 7 |
| `go/internal/update/planning_test.go` | 14 | 4 |
| `go/test/parity/differential_session_platform_test.go` | 1 | 1 |
| `scripts/ocx-native-launcher.test.mjs` | 18 | 1 |
| `src/cli/index.ts` | 10 | 1 |
| `src/codex/shim.ts` | 181 | 16 |
| `src/lib/runtime-entry.ts` | 110 | 0 |
| `src/service.ts` | 10 | 2 |
| `src/tray/windows.ts` | 9 | 2 |
| `src/update/index.ts` | 21 | 15 |
| `src/update/job.ts` | 20 | 7 |
| `tests/bun-runtime.test.ts` | 111 | 1 |
| `tests/codex-shim.test.ts` | 240 | 3 |
| `tests/ocx-launcher-source.test.ts` | 61 | 1 |
| `tests/prebridge-runtime-rebake.test.ts` | 82 | 0 |

Any file, count, or digest change returns the work phase to P and requires another
audit.

## Non-negotiable invariants

- Never persist a versioned package-local Go path in service/tray/shim state.
- Never use a Go binary as the script argument to Node.
- Never discover or replace Codex itself during runtime-only shim refresh.
- State and backup bytes are immutable during shim runtime refresh.
- One failed/raced wrapper rolls back all wrapper bytes and modes.
- Source/direct Go commands have no launcher argv prefix.
- Post-replacement commands load only the replaced package tree.
- Unsupported/malformed/symlinked/raced package identity keeps the safe fallback or
  fails closed; it never fabricates a durable command.

## Focused verification

```bash
bun run typecheck
bun test tests/bun-runtime.test.ts tests/prebridge-runtime-rebake.test.ts \
  tests/service.test.ts tests/windows-tray.test.ts tests/update-job.test.ts \
  tests/update-stop-first.test.ts tests/update-tray-handoff.test.ts \
  tests/codex-shim.test.ts tests/ocx-launcher-source.test.ts
node --test scripts/ocx-native-launcher.test.mjs
cd go
go test ./internal/cli ./internal/update
go test -race ./internal/cli ./internal/update
go vet ./internal/cli ./internal/update
GOOS=windows GOARCH=amd64 go test -c ./internal/cli
```
