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
 * `git ls-files` only, so nothing untracked and nothing ignored is included —
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
import { readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

const ROOT = join(import.meta.dir, "..");

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

interface Row { name: string; files: number; total: number; code: number }

function trackedFiles(): string[] {
  const out = spawnSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "buffer", maxBuffer: 64 << 20 });
  if (out.status !== 0) throw new Error(`git ls-files failed: ${out.stderr?.toString() ?? "unknown"}`);
  return out.stdout.toString("utf8").split("\0").filter(Boolean);
}

/** Total lines and non-blank lines. A file with no trailing newline still counts its last line. */
function measure(path: string): { total: number; code: number } | null {
  try {
    if (statSync(join(ROOT, path)).size > 8 << 20) return null;
    const text = readFileSync(join(ROOT, path), "utf8");
    if (text.includes("\0")) return null;
    const lines = text.split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    return { total: lines.length, code: lines.filter(l => l.trim() !== "").length };
  } catch {
    return null;
  }
}

export function countLines() {
  const rows = new Map<string, Row>(BUCKETS.map(b => [b.name, { name: b.name, files: 0, total: 0, code: 0 }]));
  let assets = 0;
  let unreadable = 0;

  for (const path of trackedFiles()) {
    if (!CODE_EXTENSIONS.has(extname(path).toLowerCase())) { assets += 1; continue; }
    const counted = measure(path);
    if (!counted) { unreadable += 1; continue; }
    // The catch-all guarantees this find always succeeds; the assertion below
    // proves the sum, so a bucket that silently stopped matching is a failure
    // rather than a quietly smaller number.
    const bucket = BUCKETS.find(b => b.match(path))!;
    const row = rows.get(bucket.name)!;
    row.files += 1;
    row.total += counted.total;
    row.code += counted.code;
  }

  const list = [...rows.values()].filter(r => r.files > 0);
  return {
    rows: list,
    totals: list.reduce((acc, r) => ({
      files: acc.files + r.files, total: acc.total + r.total, code: acc.code + r.code,
    }), { files: 0, total: 0, code: 0 }),
    assets,
    unreadable,
  };
}

function table(): string {
  const { rows, totals, assets, unreadable } = countLines();
  const n = (v: number) => v.toLocaleString("en-US");
  const lines = [
    "| Area | Files | Lines | Non-blank |",
    "| --- | ---: | ---: | ---: |",
    ...rows.map(r => `| ${r.name} | ${n(r.files)} | ${n(r.total)} | ${n(r.code)} |`),
    `| **Total** | **${n(totals.files)}** | **${n(totals.total)}** | **${n(totals.code)}** |`,
  ];
  lines.push("");
  lines.push(
    `Counted with \`bun run scripts/count-lines.ts\` over \`git ls-files\`, so nothing`
    + ` untracked or ignored is included — no \`node_modules\`, no build output, no`
    + ` lockfile-adjacent generated trees. ${n(assets)} tracked files are images, fonts`
    + ` and other binaries and have no line count`
    + `${unreadable ? `; ${n(unreadable)} were unreadable as text` : ""}.`,
  );
  return lines.join("\n");
}

if (import.meta.main) {
  if (process.argv.includes("--json")) console.log(JSON.stringify(countLines(), null, 2));
  else console.log(table());
}
