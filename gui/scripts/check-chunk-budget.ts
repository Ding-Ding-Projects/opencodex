/**
 * Reports the size of every JS chunk `vite build` produced under
 * `dist/assets`, largest first. Exists so a regression back toward one
 * gigantic bundle, the shape `bun run build` used to warn about before the
 * screens under `src/pages` were converted to `React.lazy()` in `App.tsx`,
 * shows up as a number someone can read, instead of only as a Vite warning
 * nobody watches.
 *
 * Report mode is the default and is what `build` (see `package.json`) runs
 * after every build: it prints the table and always exits 0, so it can never
 * gate the release build. This repository's GitHub Actions workflow runs no
 * tests and no lint, and this script does not become the one thing quietly
 * reintroducing a build-time gate.
 *
 * Pass `--strict` for a local, human-invoked check instead:
 *
 *     bun run build && bun scripts/check-chunk-budget.ts --strict
 *
 * `--strict` exits non-zero when the largest chunk is over budget (or when
 * `dist/assets` does not exist yet, i.e. nobody has built). It is never run
 * by `build` itself and never runs in CI.
 *
 * The budget is set from the post-split reality, not a guess. Right after the
 * `App.tsx` conversion the largest produced chunk was the ~860 kB shared
 * runtime chunk Rollup extracts because both the eager entry (`Dashboard`
 * plus the shell chrome) and the lazy pages import it. 1000 kB leaves that
 * number real headroom to drift with ordinary dependency growth while still
 * catching an actual reversion toward a multi-megabyte single bundle: the
 * pre-split build produced one 2,965 kB chunk, nowhere near this budget.
 */
import { readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const assetsDir = resolve(import.meta.dir, "..", "dist", "assets");

/** kB budget for the largest single JS chunk, `--strict` mode only. See the file header for how this number was picked. */
export const STRICT_BUDGET_KB = 1000;

export interface ChunkSize {
  file: string;
  bytes: number;
}

/** Every `.js` chunk under `dist/assets`, largest first. Empty when the directory does not exist (nobody has built yet). */
export function listJsChunks(dir = assetsDir): ChunkSize[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter(name => name.endsWith(".js"))
    .map(file => ({ file, bytes: statSync(resolve(dir, file)).size }))
    .sort((a, b) => b.bytes - a.bytes);
}

function formatKb(bytes: number): string {
  return `${(bytes / 1000).toFixed(2)} kB`;
}

function main(): void {
  const strict = process.argv.includes("--strict");
  const chunks = listJsChunks();

  if (chunks.length === 0) {
    console.log(`[chunk-budget] No JS chunks found under ${assetsDir}. Run \`bun run build\` first.`);
    if (strict) process.exit(1);
    return;
  }

  console.log(`[chunk-budget] ${chunks.length} JS chunk(s) under dist/assets, largest first:`);
  for (const { file, bytes } of chunks) {
    console.log(`  ${formatKb(bytes).padStart(12)}  ${file}`);
  }

  const largest = chunks[0];
  console.log(`[chunk-budget] Largest chunk: ${largest.file} at ${formatKb(largest.bytes)} (budget ${STRICT_BUDGET_KB} kB, --strict only).`);

  if (largest.bytes / 1000 > STRICT_BUDGET_KB) {
    const message = `[chunk-budget] ${largest.file} is ${formatKb(largest.bytes)}, over the ${STRICT_BUDGET_KB} kB budget.`;
    if (strict) {
      console.error(message);
      process.exit(1);
    }
    console.log(`${message} (report mode: not failing the build.)`);
  }
}

main();
