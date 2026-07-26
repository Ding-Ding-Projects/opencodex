# 020 — WP2: legacy preview transition and durable runtime rebake

Literal implementation hunks: `021_wp2_literal_patch.md`.

## Outcome

Prove an updater already running under the old npm/Bun package can replace package
files, enter the new Go executable, and rewrite every durable service/tray/shim path
before any later major cutover removes the dormant package-local Bun dependency.

## NEW `src/lib/runtime-entry.ts` — complete content contract

```ts
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface DurableRuntimeEntry { runtime: string; cli: string }

function nodeExecutable(): string {
  return execFileSync(process.platform === "win32" ? "where.exe" : "which", ["node"], {
    encoding: "utf8", windowsHide: true,
  }).split(/\r?\n/, 1)[0]!.trim();
}

export function packagedNativeBinary(root: string, platform = process.platform, arch = process.arch): string | null {
  const os = { darwin: "darwin", linux: "linux", win32: "windows" }[platform];
  const goarch = { x64: "amd64", arm64: "arm64" }[arch];
  if (!os || !goarch) return null;
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string };
  if (!version) return null;
  const path = join(root, "bin", "native", `ocx_${version}_${os}_${goarch}${os === "windows" ? ".exe" : ""}`);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    if (platform !== "win32" && (stat.mode & 0o111) === 0) return null;
    return path;
  } catch { return null; }
}

export function preferredDurableRuntime(
  root: string,
  fallback: DurableRuntimeEntry,
): DurableRuntimeEntry {
  return packagedNativeBinary(root)
    ? { runtime: nodeExecutable(), cli: join(root, "bin", "ocx.mjs") }
    : fallback;
}
```

This helper does not execute the Go binary; it only chooses the durable Node launcher
when the exact packaged target is present. `tests/bun-runtime.test.ts` imports it
and covers supported/missing/stale/symlink/non-executable and Node lookup failure.

## MODIFY `src/service.ts`, `src/tray/windows.ts`, `src/codex/shim.ts`

Each existing `cliEntry/currentEntry` keeps its Bun fallback but wraps it with the
new helper. Exact shape:

```diff
-return { bun: durableBunPath(), cli: join(import.meta.dir, "...", "cli", "index.ts") };
+const fallback = { runtime: durableBunPath(), cli: join(import.meta.dir, "...", "cli", "index.ts") };
+const entry = preferredDurableRuntime(packageRoot, fallback);
+return { bun: entry.runtime, cli: entry.cli };
```

The existing builders continue using their `bun` field name for serialization
compatibility, but persisted value is absolute Node and `cli` is `bin/ocx.mjs`.
Thus an old updater's dynamically loaded lifecycle owner writes Node launcher → Go.

The shim owner is the exception: a pre-bridge CLI may have cached it before package
replacement. Dormant Bun remains installed, so that cached shim stays valid. The
fresh launcher path below refreshes it on the first post-update `ocx` invocation.

## MODIFY `src/update/job.ts` — bridge behavior

- Change Bun/source restart and tray-refresh commands from `process.execPath +
  process.argv[1]` to Node + the freshly installed package launcher:

```diff
-const bin = process.execPath;
-const args = svcArgs;
+const bin = nodeBin();
+const args = svcArgs;
...
-runLoggedCommand(job, process.execPath, trayArgs, 20_000)
+runLoggedCommand(job, nodeBin(), [packageLauncherPath(), ...installArgs], 20_000)
```

- `restartCommand` continues to use the installed launcher for npm and now does the
  same for Bun. The launcher chooses packaged Go. Source checkouts keep the existing
  source command and are not sent through package-native logic.

## MODIFY `src/update/index.ts` — direct CLI bridge behavior

- Add local `nodeBin()` and `packageLauncherPath()` owners matching
  `src/update/job.ts`.
- After successful npm/Bun package replacement, invoke shim, tray, service reinstall,
  direct fallback start, and tray restoration via
  `node <new-package>/bin/ocx.mjs ...`, never `process.execPath src/cli/index.ts`.
- Keep the allowlisted `npm install -g` and `bun add -g` replacement commands.
- The first bridge package keeps its Bun dependency so immutable old code can finish
  spawning. Its newly loaded service/tray/shim owners nevertheless persist Node
  launcher → Go where the owner is newly loaded; cached shim converges on first fresh
  launcher invocation.

## MODIFY `bin/ocx.mjs` and Go shim owner

- Before forwarding a fresh supported-target command, inspect
  `$OPENCODEX_HOME/codex-shim.json`. If the owned wrapper still references the
  legacy Bun/TS entry, synchronously invoke the packaged Go child with
  `codex-shim refresh`, guarded by `OCX_NATIVE_SHIM_REFRESH=1`.
- Add `codex.RefreshCodexShimRuntime` in `go/internal/codex/shim.go`. It reads the
  existing owned state, requires wrapper marker + backup regular file, and atomically
  rewrites only the wrapper so it invokes the current Go executable. It never renames
  the backup or discovers Codex on PATH.
- Add `refresh` to `go/internal/cli/lifecycle_extended.go:runCodexShim`.
- If refresh fails, warn and continue through dormant Bun safety; do not corrupt the
  existing shim. A successful refresh makes subsequent launches zero-work.

## MODIFY exact tests

- `tests/update-job.test.ts`: update Bun restart expectations to Node + launcher;
  add npm/Bun × service present/absent and tray running/idle/absent matrix, asserting
  launcher invocation and failure restoration.
- `tests/update-tray-handoff.test.ts`: add post-replacement launcher invocation and
  tray restore failure.
- `tests/update-job.test.ts`: extend its existing service-reinstall
  success/failure and pinned-port assertions.
- `tests/update-stop-first.test.ts`: assert stop, installer, and post-replacement
  service repair use the intended launcher/runtime.
- `tests/winsw.test.ts`: preserve backend-specific service reinstall args.
- `tests/codex-shim.test.ts`: assert post-update shim repair command reaches launcher.
- `go/internal/cli/service_grok_test.go:TestRunServiceActivatesBackendSwitchStatusAndUninstall`,
  `tray_test.go:TestRunTrayManagerRestartAndStatusOutput`, and
  `lifecycle_extended_test.go:TestCodexShimStatusUsesScopedStatePath`: preserve
  real Dispatch and package-local executable evidence.
- Add immutable pre-bridge updater fixtures: copy current updater source/command
  behavior before replacement, replace only package files, then assert dynamically
  loaded lifecycle owners persist Node launcher → Go for service/tray/shim.

## Activation matrix

| Trigger | Observable |
| --- | --- |
| npm or Bun replacement succeeds, no durable state | no repair command |
| service present | old process loads new service owner; persisted command is Node launcher → Go |
| tray installed/running | new tray owner persists Node launcher → Go, then resumes |
| shim cached from pre-bridge | update remains safe on dormant Bun; first fresh launcher calls Go refresh and wrapper then points at Go |
| any repair fails | primary update result retained; old running state restored when promised |

## Package boundary

This phase stages binaries and makes Go the default. It does not remove `bun` from
`package.json`; that dormant bridge dependency is retained until an adoption/major
cutover receipt exists.

## Check

```bash
bun test --isolate tests/update-job.test.ts tests/update-stop-first.test.ts tests/update-tray-handoff.test.ts tests/winsw.test.ts tests/codex-shim.test.ts
cd go
go test ./internal/cli ./internal/service ./internal/tray ./internal/update -count=1
```
