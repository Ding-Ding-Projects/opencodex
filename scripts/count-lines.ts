/**
 * How many lines of code this project has, counted rather than estimated.
 *
 * Every release states this figure and CI is what produces it, so this script is
 * the single definition of the number: one command, run over the tagged commit
 * by the same workflow that builds the artifacts, with no opportunity for a
 * hand-typed total to drift from the tree.
 *
 *   bun run scripts/count-lines.ts            # the markdown table
 *   bun run scripts/count-lines.ts --json     # the same figures as JSON
 *
 * ## Why it is a committed script and not a shell one-liner
 *
 * A bucketing written on the spot silently drops every file matching no prefix,
 * and a total that quietly loses whole directories misrepresents the project. A
 * committed counter can carry a **catch-all row**, be reviewed, and be fixed once
 * for everyone — so the invariant below is enforced rather than hoped for:
 * *every tracked, counted file lands in exactly one bucket, and the buckets sum
 * to the total.*
 *
 * ## What is counted
 *
 * The tracked blobs at the resolved revision only, so nothing untracked and nothing ignored is included —
 * `node_modules`, `dist`, `gui/dist` and build output are excluded because git
 * does not track them, not because a pattern here happens to catch them. Binary
 * and asset files are excluded by extension and reported as a count of files
 * rather than of lines, because "lines" is not a fact about a PNG.
 *
 * Generated files are separated rather than hidden: `gui/src/icons.tsx` is
 * emitted by `scripts/gen-icons.ts` and the dim sum catalogue is a data table.
 * A reader should be able to see how much of this a person actually wrote.
 *
 * ## Why the per-file measurement is concurrent
 *
 * `countLines()` used to spawn `git show <rev>:<path>` once per tracked code file in a plain
 * serial `for` loop. Each spawn is independent of every other, so at ~4,900 tracked code files
 * and tens of milliseconds of process-launch overhead apiece, that loop alone could cost minutes
 * — and it ran at module import time in a test file, outside any per-test timeout, which is what
 * eventually stalled the whole root suite past its wall-clock ceiling. `line-attribution.ts` had
 * already solved the identical shape of problem for its own per-file `git blame` calls by routing
 * them through {@link mapWithConcurrency}; this does the same for `git show`, through the exact
 * same helper (see `./concurrency`).
 */

import { execFile, spawnSync } from "node:child_process";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import { mapWithConcurrency } from "./concurrency";

const execFileAsync = promisify(execFile);

const ROOT = join(import.meta.dir, "..");
const MAX_TRACKED_FILES = 10_000;
const MAX_FILE_BYTES = 8 << 20;
const GIT_TIMEOUT_MS = 120_000;
const utf8 = new TextDecoder("utf-8", { fatal: true });
/**
 * Default fan-out for the per-file `git show` calls in {@link countLines}. Matches
 * `line-attribution.ts`'s `ATTRIBUTION_CONCURRENCY`: generous enough to shorten the real wall
 * clock without opening thousands of git processes at once on a modest CI runner.
 */
const DEFAULT_MEASURE_CONCURRENCY = 8;

/** Extensions that have lines worth counting. Everything else is an asset. */
const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs", ".js", ".jsx",
  ".css", ".scss", ".html", ".astro", ".svelte", ".vue",
  ".json", ".yml", ".yaml", ".toml", ".md", ".mdx",
  ".sh", ".ps1", ".bat", ".py", ".rs", ".go",
]);

/**
 * The buckets, in order. The FIRST match wins, so the order is the editorial
 * decision: generated files are claimed before the trees they live in, and
 * tests before the source beside them.
 *
 * The final entry matches everything. That is the catch-all the rules ask for —
 * without it a file in a directory nobody thought of would vanish from the
 * total and the table would still look complete.
 */
const BUCKETS: { name: string; match: (path: string) => boolean }[] = [
  {
    name: "Generated (icons, catalogues)",
    match: p => p === "gui/src/icons.tsx"
      || p.startsWith("dim-sum/")
      || /(^|\/)dimsum-catalog\./.test(p),
  },
  { name: "Tests", match: p => /(^|\/)tests?\//.test(p) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) },
  { name: "Desktop shell (Electron)", match: p => p.startsWith("electron/") },
  { name: "Dashboard — styles", match: p => p.startsWith("gui/") && p.endsWith(".css") },
  { name: "Dashboard — source", match: p => p.startsWith("gui/") },
  { name: "Documentation site", match: p => p.startsWith("docs-site/") },
  { name: "Shared M3 layer", match: p => p.startsWith("shared/") },
  { name: "Proxy & CLI (src/, bin/)", match: p => p.startsWith("src/") || p.startsWith("bin/") },
  { name: "Build & tooling scripts", match: p => p.startsWith("scripts/") || p.startsWith(".github/") },
  { name: "Docs & prose (Markdown)", match: p => p.endsWith(".md") || p.endsWith(".mdx") },
  { name: "Config & manifests", match: () => true },
];

export interface Row { name: string; files: number; total: number; code: number }

export interface CountedFile {
  path: string;
  name: string;
  total: number;
  code: number;
}

/** Reads one tracked file's raw bytes at a revision, or `null` if it could not be read. */
export type GitShow = (path: string, revision: string, root: string) => Promise<Buffer | null>;

export interface CountLinesOptions {
  /** Repository root `trackedFiles`/`measure` run `git` in. Defaults to this project's own root. */
  root?: string;
  /** How many `git show` measurements run at once. Defaults to {@link DEFAULT_MEASURE_CONCURRENCY}. */
  concurrency?: number;
  /**
   * Overrides the per-file `git show` read. Exists so a test can prove the per-file fan-out is
   * real concurrency — inject a worker with an artificial delay and time the wall clock — without
   * spawning dozens of real git processes. Defaults to {@link defaultGitShow}.
   */
  gitShow?: GitShow;
}

function trackedFiles(revision: string, root: string): string[] {
  const out = spawnSync("git", ["ls-tree", "-r", "-z", "--name-only", revision], {
    cwd: root,
    encoding: "buffer",
    maxBuffer: 64 << 20,
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
  });
  if (out.status !== 0 || out.error) {
    throw new Error(`git ls-tree failed for ${JSON.stringify(revision)}: ${out.error?.message ?? out.stderr?.toString() ?? "unknown"}`);
  }
  const paths = out.stdout.toString("utf8").split("\0").filter(Boolean);
  if (paths.length > MAX_TRACKED_FILES) {
    throw new Error(`refusing to count ${paths.length} tracked files; limit is ${MAX_TRACKED_FILES}`);
  }
  return paths;
}

/**
 * The real per-file read: `git show <rev>:<path>`, run asynchronously (not `spawnSync`) so many
 * of these can be in flight at once through {@link mapWithConcurrency} instead of one after
 * another. Returns `null` on any failure — a non-zero exit, a spawn error, a timeout, or output
 * over `maxBuffer` — exactly as the previous synchronous version treated every one of those the
 * same way: the file becomes "unreadable" rather than the whole count failing.
 */
const defaultGitShow: GitShow = async (path, revision, root) => {
  try {
    const { stdout } = await execFileAsync("git", ["show", `${revision}:${path}`], {
      cwd: root,
      encoding: "buffer",
      maxBuffer: MAX_FILE_BYTES + 1,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    }) as { stdout: Buffer };
    return stdout;
  } catch {
    return null;
  }
};

/** Total lines and non-blank lines. A file with no trailing newline still counts its last line. */
async function measure(path: string, revision: string, root: string, gitShow: GitShow): Promise<{ total: number; code: number } | null> {
  const stdout = await gitShow(path, revision, root);
  if (!stdout || stdout.length > MAX_FILE_BYTES || stdout.includes(0)) return null;
  let text: string;
  try {
    text = utf8.decode(stdout);
  } catch {
    return null;
  }
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return { total: lines.length, code: lines.filter(line => line.trim() !== "").length };
}

export async function countLines(revision = "HEAD", options: CountLinesOptions = {}) {
  const root = options.root ?? ROOT;
  const concurrency = options.concurrency ?? DEFAULT_MEASURE_CONCURRENCY;
  const gitShow = options.gitShow ?? defaultGitShow;
  // Resolving the revision and listing tracked files are each a single git process, not a
  // per-file loop, so they stay the plain synchronous calls they always were — only the O(n)
  // measurement below needed to change.
  const resolved = spawnSync("git", ["rev-parse", "--verify", `${revision}^{commit}`], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1024,
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
  });
  if (resolved.status !== 0 || resolved.error) {
    throw new Error(`cannot resolve ${JSON.stringify(revision)} to a commit: ${resolved.error?.message ?? resolved.stderr.trim()}`);
  }
  const target = resolved.stdout.trim();

  // Split into code files (measured) and assets (counted only), preserving `trackedFiles()`'s
  // order, so the per-path bucket assignment and `entries` order below are unchanged from the
  // previous serial loop regardless of which measurement finishes first.
  const paths = trackedFiles(target, root);
  const codePaths = paths.filter(path => CODE_EXTENSIONS.has(extname(path).toLowerCase()));
  const assets = paths.length - codePaths.length;

  const measured = await mapWithConcurrency(codePaths, concurrency, path => measure(path, target, root, gitShow));

  const rows = new Map<string, Row>(BUCKETS.map(b => [b.name, { name: b.name, files: 0, total: 0, code: 0 }]));
  const entries: CountedFile[] = [];
  let unreadable = 0;

  for (let index = 0; index < codePaths.length; index += 1) {
    const path = codePaths[index];
    const counted = measured[index];
    if (!counted) { unreadable += 1; continue; }
    // The catch-all guarantees this find always succeeds; the assertion below
    // proves the sum, so a bucket that silently stopped matching is a failure
    // rather than a quietly smaller number.
    const bucket = BUCKETS.find(b => b.match(path))!;
    const row = rows.get(bucket.name)!;
    row.files += 1;
    row.total += counted.total;
    row.code += counted.code;
    entries.push({ path, name: bucket.name, total: counted.total, code: counted.code });
  }

  const list = [...rows.values()].filter(r => r.files > 0);
  return {
    rows: list,
    totals: list.reduce((acc, r) => ({
      files: acc.files + r.files, total: acc.total + r.total, code: acc.code + r.code,
    }), { files: 0, total: 0, code: 0 }),
    entries,
    assets,
    unreadable,
    revision: target,
  };
}

if (import.meta.main) {
  const { countLinesWithAttribution, formatLineAttributionTable } = await import("./line-attribution");
  const report = await countLinesWithAttribution();
  if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else console.log(formatLineAttributionTable(report));
}
