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

The CLI slice fixed the startup ordering by creating the listener first and
running `applyGrokFence(...)` from `serveListener`'s `afterStart` callback
(`go/internal/cli/serve.go`). The proxy can now answer the model fetch instead
of waiting on itself. Process tests remain explicitly opt-in because they form
the slower cross-runtime CI matrix, not because startup is deadlocked:

```bash
OCX_RUN_RUNTIME_PARITY=1 go test ./test/parity -count=1 -timeout 1200s
```

The default parity package still runs pure artifact tests and the direct Grok
sync/stop byte differential. This keeps the normal CI gate bounded while
preserving an explicit command for the expensive runtime matrix.

After the split, the default package completed in 2.36 seconds (`go test`
reported 1.708 seconds), down from the 900-second timeout.

Before the CLI fix, an isolated `TestTypeScriptAndGoHealthRoute` took 30.95
seconds. After the fix, the complete runtime matrix is green in 21.46 seconds
of wall time (21.156 seconds reported by `go test`). This is a CI-viable
duration. The first post-fix run exposed a stale chat-envelope assertion:
direct TS/Go execution both preserved `insufficient_quota`, while the test had
expected `rate_limit_error`; correcting the parity oracle closed the suite.

## Parity suite switches

| Environment variable | Additional coverage | Default CI behavior |
| --- | --- | --- |
| `OCX_RUN_RUNTIME_PARITY=1` | Real Go and Bun proxy processes: routing, management mutations, WebSocket/SSE, Grok serve/stop, and Claude Desktop lifecycle | Skipped |
| `OCX_RUN_HEADER_STRESS=1` | Bun oversized-header characterization | Skipped |
| `OCX_RUN_PERF=1` | Short local runtime throughput/RSS measurement | Skipped |
| `OCX_RUN_STREAM_PERF=1` | Long-lived SSE throughput/RSS measurement | Skipped |

The three stress/performance switches do not imply runtime parity; CI jobs that
need those cases should set `OCX_RUN_RUNTIME_PARITY=1` as well. A machine without
Bun safely skips TS-dependent tests. `TestDifferentialHarnessSkipsWithoutBun`
forces the runtime switch on with an `exec.ErrNotFound` lookup to exercise that
skip path rather than merely being skipped by the outer runtime gate.

## Lifecycle differential findings

`TestGrokAndClaudeDesktopCLILifecycleParity` runs Go and TypeScript sequentially
on one fixed loopback port and isolated temporary homes. It covers proxy start,
Grok injection, a real routed request, Claude Desktop apply/status/reapply,
malformed-metadata failure preservation, canonical stop, byte-exact Grok restore,
and cross-feature non-interference.

The lifecycle currently records two source differences without weakening each
implementation's data-safety assertions:

- Go's CLI model source includes the full built-in registry, while TypeScript
  emits native plus configured models. Grok and Claude Desktop catalog files
  therefore differ in total length/digest, though their shared gateway fields
  and configured parity model are equivalent.
- TypeScript's Claude Desktop management reapply rejects the
  `appliedFingerprint` persisted by its first apply as an unknown profile field.
  Go reapply is idempotent. Both leave the first applied Desktop files unchanged.

## Grok safety coverage

Focused boundary tests now cover provider-host canonicalization, default home
resolution without writing it, TOML basic-string escape decoding (including
invalid Unicode scalars), marker line ownership, CRLF consumption, and backup
failure behavior. Package statement coverage increased from 82.3% to 90.4%.
