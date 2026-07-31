/**
 * Bundled Bun runtime resolution.
 *
 * opencodex ships the Bun runtime via the `bun` npm dependency (esbuild-style:
 * a tiny main package + platform-specific `@oven/bun-*` optionalDependencies,
 * finalized by the package's own postinstall `node install.js`). The npm `bin`
 * launcher (bin/ocx.mjs) and the durable service/shim integrations both need a
 * stable path to that binary. This module is the single source of truth.
 *
 * In a from-source dev checkout the `bun` dependency may be absent; callers fall
 * back to `process.execPath` (which is itself Bun when run via `bun src/cli/index.ts`).
 */
import { createRequire } from "node:module";
import { existsSync, statSync } from "node:fs";
import { dirname, join, win32 } from "node:path";
import { resolveOnTrustedPath } from "./trusted-path.mjs";

const require = createRequire(import.meta.url);

// The `bun` package leaves a tiny ASCII placeholder at bin/bun.exe until its
// postinstall downloads the real ~60MB binary; reject the stub by size so we
// never bake a non-executable path into durable artifacts.
const REAL_BUN_MIN_BYTES = 1_000_000;
const BUN_OVERRIDE_ENV = "OPENCODEX_BUN_PATH";

export type DurableBunRuntime = {
  path: string;
  source: "override" | "bundled" | "process";
  overrideEnv: typeof BUN_OVERRIDE_ENV;
};

/**
 * True only for a real, downloaded Bun binary — not the ~450-byte ASCII
 * placeholder stub left by `--ignore-scripts` / pnpm. A size gate cleanly
 * separates the two on every platform (real binary is tens of MB).
 */
export function isRealBunBinary(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).size >= REAL_BUN_MIN_BYTES;
  } catch {
    return false;
  }
}

/**
 * Absolute path to the bundled Bun binary, or null if the `bun` dependency is
 * not installed/resolvable (or only the un-downloaded placeholder is present).
 * The npm `bun` package ships the binary as `bin/bun.exe` on every platform;
 * we also probe `bin/bun` for forward compatibility.
 */
export function bundledBunPath(): string | null {
  try {
    const bunDir = dirname(require.resolve("bun/package.json"));
    for (const name of ["bun.exe", "bun"]) {
      const p = join(bunDir, "bin", name);
      if (isRealBunBinary(p)) return p;
    }
    return null;
  } catch {
    return null;
  }
}

export function overrideBunPath(): string | null {
  const value = process.env[BUN_OVERRIDE_ENV]?.trim();
  if (!value) return null;
  return isRealBunBinary(value) ? value : null;
}

export function durableBunRuntime(): DurableBunRuntime {
  const override = overrideBunPath();
  if (override) return { path: override, source: "override", overrideEnv: BUN_OVERRIDE_ENV };
  const bundled = bundledBunPath();
  if (bundled) return { path: bundled, source: "bundled", overrideEnv: BUN_OVERRIDE_ENV };
  return { path: process.execPath, source: "process", overrideEnv: BUN_OVERRIDE_ENV };
}

/**
 * Bun path to bake into durable artifacts (launchd/systemd/Task Scheduler and
 * the Codex auto-start shim). Prefer the bundled binary — it lives under the
 * npm global prefix and survives across `ocx update` — and fall back to the
 * current runtime, which is Bun when launched normally.
 */
export function durableBunPath(): string {
  return durableBunRuntime().path;
}

/**
 * Whether THIS process is running on Bun.
 *
 * The only certain way to know that `process.execPath` is a Bun binary. Bun defines
 * a `Bun` global; nothing else does. Size and filename heuristics cannot answer this
 * from the outside — `isRealBunBinary` is a ~1MB gate meant only to tell a real
 * binary from the `bun` package's ~450-byte placeholder stub, and `node.exe` (~100MB)
 * clears it just as easily as `bun.exe` does.
 */
export function runningUnderBun(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
}

export interface ResolveBunDeps {
  cwd?: string;
  exists?: (path: string) => boolean;
  bundled?: () => string | null;
  execPath?: string;
  underBun?: () => boolean;
  isRealBun?: (path: string) => boolean;
}

/**
 * An absolute Bun to spawn `bun add -g …` with on Windows, or null when none can be
 * trusted.
 *
 * Windows needs this because `bun` is usually absent from the PATH a GUI-, service- or
 * tray-spawned process inherits, and because a bare name is resolvable out of the
 * launch directory there (the hijack {@link resolveOnTrustedPath} guards against).
 *
 * What it must never do is substitute a *different* interpreter: the caller pairs the
 * result with Bun's own arguments (`add -g <pkg>`), which only Bun understands.
 * `process.execPath` is therefore accepted only when this process is provably running
 * on Bun, never on a size or name guess. Returning null fails the update closed, which
 * callers can report before anything is stopped or replaced.
 *
 * POSIX keeps the bare name: a Bun global install puts `bun` on PATH by construction,
 * and there is no cwd-first lookup to defeat.
 */
export function resolveBunCommand(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
  deps: ResolveBunDeps = {},
): string | null {
  if (platform !== "win32") return "bun";
  const isReal = deps.isRealBun ?? isRealBunBinary;

  const override = env[BUN_OVERRIDE_ENV]?.trim();
  if (override && win32.isAbsolute(override) && isReal(override)) return win32.resolve(override);

  const bundled = (deps.bundled ?? bundledBunPath)();
  if (bundled) return bundled;

  const execPath = deps.execPath ?? process.execPath;
  if ((deps.underBun ?? runningUnderBun)() && win32.isAbsolute(execPath)) return execPath;

  const onPath = resolveOnTrustedPath("bun", env, { cwd: deps.cwd, exists: deps.exists });
  return onPath && isReal(onPath) ? onPath : null;
}
