/**
 * Regression for finding REL-02: `countLines()`'s per-file `git show` measurements used to run
 * one at a time in a plain `for` loop (`scripts/count-lines.ts`, inside `measure()`/`countLines`),
 * while `line-attribution.ts` had already fixed the identical shape of problem for its own
 * per-file `git blame` calls by routing them through `mapWithConcurrency`. With roughly 5,000
 * tracked code files, the serial loop's cost scaled with the machine's process-launch overhead:
 * the finding's own baseline put the loop alone at about 226 seconds, and the whole original
 * tests/count-lines-attribution.test.ts, which ran `countLines()` at MODULE IMPORT TIME where no
 * per-test timeout could bound it, took 42 seconds on a fast Linux box. That import-time work is
 * what the project handoff recorded as stalling the root suite.
 *
 * This proves the fan-out is real concurrency, not just an option nobody reads: `gitShow` is
 * injected with an artificial, fixed 50ms delay standing in for `git show`, over 40 fixture
 * files, so the wall clock is deterministic and machine-independent instead of riding on however
 * fast a real `git show` happens to be on whatever box this runs on.
 *
 * Red before the fix / green after: the pre-fix `countLines()` has no `options` parameter at
 * all (`countLines(revision = "HEAD")`), so passing `{ root, concurrency, gitShow }` to it is
 * silently ignored: it always falls back to its own hard-coded module root and always spawns
 * real `git show` once per file, one at a time. Run against that tree, this test fails fast with
 * `cannot resolve "<fixture commit>" to a commit: fatal: Needed a single revision`, because the
 * fixture's commit does not exist in the real repository. Fixed, `countLines()` measures the 40
 * fake files at concurrency 8, so the wall clock sits near 40/8 * 50ms = 250ms, nowhere near
 * 40 * 50ms = 2000ms.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { countLines } from "../scripts/count-lines";

const FIXTURE_FILE_COUNT = 40;
const ARTIFICIAL_DELAY_MS = 50;
const CONCURRENCY = 8;
/** What the loop this pins would cost if it ran the fake measurements one at a time. */
const SERIAL_TOTAL_MS = FIXTURE_FILE_COUNT * ARTIFICIAL_DELAY_MS;
/**
 * Comfortably above the ideal parallel time (~40/8 * 50ms = 250ms, plus scheduling and process
 * overhead) and comfortably below the serial total, so this only passes when the calls actually
 * overlap rather than merely completing "somewhat faster than fully serial".
 */
const PARALLEL_BOUND_MS = 1_000;

function git(root: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (exit ${String(result.status)}): ${result.stderr || result.stdout}`);
  }
}

let root: string;
let revision: string;

beforeAll(() => {
  // A real (but tiny) git repository, so `git rev-parse` and `git ls-tree`, the two single cheap
  // calls `countLines()` still makes for real, have something real to resolve and list. Only
  // the O(n) per-file `git show` step is faked, via the injected `gitShow` below.
  root = mkdtempSync(join(tmpdir(), "count-lines-hunt-rel-02-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Fixture Author"]);
  git(root, ["config", "user.email", "fixture@example.invalid"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  for (let index = 0; index < FIXTURE_FILE_COUNT; index += 1) {
    writeFileSync(join(root, `file-${String(index).padStart(3, "0")}.ts`), `export const n = ${index};\n`);
  }
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "hunt-rel-02 fixture"]);
  revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("count-lines per-file measurement runs concurrently (REL-02)", () => {
  test(`${String(FIXTURE_FILE_COUNT)} fixture files at a fake ${String(ARTIFICIAL_DELAY_MS)}ms each finish well under the serial total`, async () => {
    let inFlight = 0;
    let peakInFlight = 0;

    const startedAt = performance.now();
    const result = await countLines(revision, {
      root,
      concurrency: CONCURRENCY,
      gitShow: async () => {
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        await new Promise(resolve => setTimeout(resolve, ARTIFICIAL_DELAY_MS));
        inFlight -= 1;
        return Buffer.from("alpha\nbeta\ngamma\n", "utf8");
      },
    });
    const elapsedMs = performance.now() - startedAt;

    // Sanity: every fixture file was actually measured through the fake, not silently skipped.
    expect(result.totals.files).toBe(FIXTURE_FILE_COUNT);
    expect(result.assets).toBe(0);
    expect(result.unreadable).toBe(0);

    // Direct proof of concurrency: more than one fake `git show` was in flight at once, and never
    // more than the requested bound.
    expect(peakInFlight).toBeGreaterThan(1);
    expect(peakInFlight).toBeLessThanOrEqual(CONCURRENCY);

    // Wall-clock proof: comfortably under the serial total.
    expect(
      elapsedMs,
      `${String(FIXTURE_FILE_COUNT)} files at ${String(ARTIFICIAL_DELAY_MS)}ms each took ` +
        `${String(Math.round(elapsedMs))}ms; the serial total would be ${String(SERIAL_TOTAL_MS)}ms`,
    ).toBeLessThan(PARALLEL_BOUND_MS);
  });
});
