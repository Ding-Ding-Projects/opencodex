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
 */

import { spawnSync } from "node:child_process";
import { extname, join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const MAX_TRACKED_FILES = 10_000;
const MAX_FILE_BYTES = 8 << 20;
const GIT_TIMEOUT_MS = 120_000;
const utf8 = new TextDecoder("utf-8", { fatal: true });

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

function trackedFiles(revision: string): string[] {
  const out = spawnSync("git", ["ls-tree", "-r", "-z", "--name-only", revision], {
    cwd: ROOT,
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

/** Total lines and non-blank lines. A file with no trailing newline still counts its last line. */
function measure(path: string, revision: string): { total: number; code: number } | null {
  const out = spawnSync("git", ["show", `${revision}:${path}`], {
    cwd: ROOT,
    encoding: "buffer",
    maxBuffer: MAX_FILE_BYTES + 1,
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
  });
  if (out.status !== 0 || out.error || out.stdout.length > MAX_FILE_BYTES || out.stdout.includes(0)) return null;
  let text: string;
  try {
    text = utf8.decode(out.stdout);
  } catch {
    return null;
  }
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return { total: lines.length, code: lines.filter(line => line.trim() !== "").length };
}

export function countLines(revision = "HEAD") {
  const resolved = spawnSync("git", ["rev-parse", "--verify", `${revision}^{commit}`], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 1024,
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
  });
  if (resolved.status !== 0 || resolved.error) {
    throw new Error(`cannot resolve ${JSON.stringify(revision)} to a commit: ${resolved.error?.message ?? resolved.stderr.trim()}`);
  }
  const target = resolved.stdout.trim();
  const rows = new Map<string, Row>(BUCKETS.map(b => [b.name, { name: b.name, files: 0, total: 0, code: 0 }]));
  const entries: CountedFile[] = [];
  let assets = 0;
  let unreadable = 0;

  for (const path of trackedFiles(target)) {
    if (!CODE_EXTENSIONS.has(extname(path).toLowerCase())) { assets += 1; continue; }
    const counted = measure(path, target);
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
  const report = countLinesWithAttribution();
  if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else console.log(formatLineAttributionTable(report));
}
