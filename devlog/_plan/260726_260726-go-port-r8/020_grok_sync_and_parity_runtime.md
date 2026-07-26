# 020 — Grok sync ownership and parity runtime boundary

## Canonical Grok config lifecycle

The command name `sync` is easy to misread as the Grok synchronization entry
point, but the TypeScript source does not currently implement that contract:

- `src/cli/index.ts:721-723` handles literal `ocx sync` by calling only
  `syncModelsToCodex(...)`.
- Grok registration is driven by `syncGrokConfig(...)` from start and both
  ensure branches (`src/cli/index.ts:295-296,323-324,350-351`). Restart reaches
  the same path after stop succeeds.
- Stop removes the managed block through `stripGrokConfig()`.

The Go port follows the lifecycle entry points through
`go/internal/cli/grok_lifecycle.go:13-39`. Differential config tests should
therefore compare the canonical `syncGrokConfig` / `stripGrokConfig` functions,
not claim that literal `ocx sync` owns Grok registration. If product behavior is
later changed so `ocx sync` also refreshes Grok, update this note and add a
command-level parity test.

## Parity runtime profile

Profiling command:

```bash
cd go
go test -json ./test/parity -count=1 -timeout 900s
```

Observed on 2026-07-26:

- Package exceeded 900 seconds.
- `TestTypeScriptAndGoConfigInterpretation` consumed 90.78 seconds.
- Most process-based tests consumed about 30 seconds each, including health,
  HTTP/2, WebSocket, SSE, management, request-log, and error matrices.
- The common delay is not test computation. `go/internal/cli/serve.go:156`
  invokes `applyGrokFence` before `serveListener` starts serving. The fence's
  model fetch (`go/internal/cli/grok_lifecycle.go:20-25`) calls the not-yet-live
  proxy and reaches the 30-second fetch timeout.

That startup ordering is owned by the CLI slice. Until it is fixed, tests that
start real Go/TypeScript proxy processes are explicitly opt-in:

```bash
OCX_RUN_RUNTIME_PARITY=1 go test ./test/parity -count=1 -timeout 1200s
```

The default parity package still runs pure artifact tests and the direct Grok
sync/stop byte differential. This keeps the normal CI gate bounded while
preserving an explicit command for the expensive runtime matrix.

After the split, the default package completed in 2.36 seconds (`go test`
reported 1.708 seconds), down from the 900-second timeout.

The opt-in path was also exercised independently with
`TestTypeScriptAndGoHealthRoute`; it completed successfully in 30.95 seconds,
confirming the deep suite remains runnable rather than silently disabled.

## Grok safety coverage

Focused boundary tests now cover provider-host canonicalization, default home
resolution without writing it, TOML basic-string escape decoding (including
invalid Unicode scalars), marker line ownership, CRLF consumption, and backup
failure behavior. Package statement coverage increased from 82.3% to 90.4%.
