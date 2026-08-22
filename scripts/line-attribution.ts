import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { countLines } from "./count-lines";

export interface AttributionIdentity {
  name: string;
  email: string;
}

export interface AttributionOptions {
  root: string;
  paths: readonly string[];
  revision?: string;
  agentIdentities: readonly AttributionIdentity[];
  maxFiles?: number;
  maxFileBytes?: number;
  maxLines?: number;
  maxCommits?: number;
  timeoutMs?: number;
}

export interface FileAttribution {
  path: string;
  total: number;
  agent: number;
  person: number;
}

export interface LineAttribution {
  revision: string;
  files: FileAttribution[];
  totals: { total: number; agent: number; person: number };
}

export interface AttributionRow {
  category: string;
  language: string;
  total: number;
  nonBlank: number;
  agent: number;
  people: number;
}

export interface LineAttributionReportRow {
  name: string;
  files: number;
  total: number;
  nonBlank: number;
  agent: number;
  people: number;
}

export interface LineAttributionReport {
  revision: string;
  rows: LineAttributionReportRow[];
  totals: Omit<LineAttributionReportRow, "name">;
  excluded: { assets: number; unreadable: number };
}

export class GitCommandError extends Error {
  constructor(
    public readonly command: string,
    public readonly args: readonly string[],
    public readonly exitCode: number | null,
    public readonly stderr: string,
  ) {
    const safeArgs = args.map(redactArgument);
    const operation = [command, ...safeArgs].join(" ");
    const safeStderr = redactArgument(stderr);
    super(`${operation} failed with exit ${exitCode ?? "unknown"}: ${safeStderr.trim() || "no stderr"}`);
    this.name = "GitCommandError";
  }
}

function redactArgument(value: string): string {
  return value.replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[credentials]@");
}

export const KNOWN_AGENT_IDENTITIES: readonly AttributionIdentity[] = Object.freeze([
  { name: "Claude Fable 5", email: "noreply@anthropic.com" },
  { name: "Claude", email: "noreply@anthropic.com" },
  { name: "Claude Opus 4.6 (1M context)", email: "noreply@anthropic.com" },
  { name: "Claude Opus 4.6", email: "noreply@anthropic.com" },
  { name: "Claude Opus 4.7 (1M context)", email: "noreply@anthropic.com" },
  { name: "Claude Opus 4.8 (1M context)", email: "noreply@anthropic.com" },
  { name: "Claude Opus 4.8", email: "noreply@anthropic.com" },
  { name: "Claude Opus 5 (1M context)", email: "noreply@anthropic.com" },
  { name: "Claude Opus 5", email: "noreply@anthropic.com" },
  { name: "CodeRabbit", email: "noreply@coderabbit.ai" },
  { name: "coderabbitai[bot]", email: "136622811+coderabbitai[bot]@users.noreply.github.com" },
  { name: "CommandCodeBot", email: "noreply@commandcode.ai" },
  { name: "Copilot App", email: "223556219+Copilot@users.noreply.github.com" },
  { name: "Cursor", email: "cursoragent@cursor.com" },
  { name: "github-actions[bot]", email: "41898282+github-actions[bot]@users.noreply.github.com" },
  { name: "OpenAI Codex", email: "codex@openai.com" },
  { name: "OpenCodex Maintainer", email: "actions@users.noreply.github.com" },
  { name: "Opencodex Bot", email: "bot@opencodex" },
  { name: "Agent59353", email: "agent59353@taskmarket.dev" },
  { name: "codex", email: "codex@local" },
]);

/** Deliberate non-agent matches: exact pairing prevents name-only look-alikes. */
export const EXCLUDED_AGENT_LOOKALIKES: readonly AttributionIdentity[] = Object.freeze([
  { name: "Claude", email: "state-history@localhost" },
  { name: "agentHits", email: "zvercombat26rus@icloud.com" },
  { name: "opencodex state history", email: "matday116@outlook.com" },
]);

const DEFAULT_MAX_FILES = 10_000;
const DEFAULT_MAX_FILE_BYTES = 8 << 20;
const DEFAULT_MAX_LINES = 5_000_000;
const DEFAULT_MAX_COMMITS = 100_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 64 << 20;
const METADATA_BATCH_SIZE = 128;

function normalizeName(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/g, " ");
}

function normalizeEmail(value: string): string {
  return value.normalize("NFC").trim().replace(/^<|>$/g, "").toLowerCase();
}

function identityKey(identity: AttributionIdentity): string {
  return `${normalizeName(identity.name)}\0${normalizeEmail(identity.email)}`;
}

export function isAgentAttribution(
  author: AttributionIdentity,
  coauthors: readonly AttributionIdentity[],
  agentIdentities: readonly AttributionIdentity[] = KNOWN_AGENT_IDENTITIES,
): boolean {
  const agentKeys = new Set(agentIdentities.map(identityKey));
  return agentKeys.has(identityKey(author)) || coauthors.some(identity => agentKeys.has(identityKey(identity)));
}

function positiveLimit(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new Error(`${label} must be a positive safe integer; received ${String(result)}`);
  }
  return result;
}

function git(root: string, args: readonly string[], timeoutMs: number, context: string): string {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: timeoutMs,
    windowsHide: true,
  });
  if (result.error) {
    const reason = result.error.message.includes("maxBuffer")
      ? `output exceeded ${MAX_OUTPUT_BYTES} bytes`
      : result.error.message;
    throw new Error(`${context}: unable to run git (${reason})`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || `exit ${String(result.status)}`).trim();
    const failure = new GitCommandError("git", args, result.status, detail);
    failure.message = `${context}: ${failure.message}`;
    throw failure;
  }
  return result.stdout;
}

function commitIdsFromBlame(output: string, path: string): string[] {
  const ids: string[] = [];
  let pendingCommit: string | undefined;
  let contentLines = 0;
  for (const line of output.split("\n")) {
    const match = /^([0-9a-f]{40,64}) \d+ \d+(?: \d+)?$/.exec(line);
    if (match) pendingCommit = match[1];
    if (line.startsWith("\t")) {
      contentLines += 1;
      if (!pendingCommit) {
        throw new Error(`git blame returned content without a commit header for ${JSON.stringify(path)}`);
      }
      ids.push(pendingCommit);
      pendingCommit = undefined;
    }
  }
  if (pendingCommit) throw new Error(`git blame returned a commit header without content for ${JSON.stringify(path)}`);
  if (contentLines === 0 && output.trim() !== "") {
    throw new Error(`git blame returned malformed porcelain without content lines for ${JSON.stringify(path)}`);
  }
  return ids;
}

function parseCoAuthors(trailers: string): AttributionIdentity[] {
  const identities: AttributionIdentity[] = [];
  for (const value of trailers.split("\x1f")) {
    const match = /^\s*(.+?)\s*<([^<>]+)>\s*$/.exec(value);
    if (match) identities.push({ name: match[1], email: match[2] });
  }
  return identities;
}

function classifyCommits(
  root: string,
  commits: readonly string[],
  agentKeys: ReadonlySet<string>,
  timeoutMs: number,
): Map<string, boolean> {
  const result = new Map<string, boolean>();
  for (let offset = 0; offset < commits.length; offset += METADATA_BATCH_SIZE) {
    const batch = commits.slice(offset, offset + METADATA_BATCH_SIZE);
    const output = git(
      root,
      [
        "show",
        "-s",
        "--no-show-signature",
        "--format=%H%x00%an%x00%ae%x00%(trailers:key=Co-Authored-By,valueonly,separator=%x1f)%x00",
        ...batch,
      ],
      timeoutMs,
      `reading attribution metadata for commits ${offset + 1}-${offset + batch.length}`,
    );
    const fields = output.split("\0");
    if (fields.at(-1)?.trim() === "") fields.pop();
    if (fields.length % 4 !== 0) {
      throw new Error(`git show returned malformed attribution metadata for batch starting at ${offset + 1}`);
    }
    for (let index = 0; index < fields.length; index += 4) {
      const sha = fields[index].trim();
      const author = { name: fields[index + 1], email: fields[index + 2] };
      const trailerMatch = parseCoAuthors(fields[index + 3]).some(identity => agentKeys.has(identityKey(identity)));
      result.set(sha, agentKeys.has(identityKey(author)) || trailerMatch);
    }
  }
  const missing = commits.filter(commit => !result.has(commit));
  if (missing.length > 0) {
    throw new Error(`git metadata omitted ${missing.length} blamed commit(s); first missing commit: ${missing[0]}`);
  }
  return result;
}

/**
 * Attribute surviving lines in tracked files at one revision.
 *
 * Identity matching is exact after explicit normalization: names are NFC,
 * trimmed, and whitespace-collapsed; emails are additionally lower-cased and
 * stripped of one surrounding angle-bracket pair. A line is agent-authored
 * when its commit author OR any exact Co-Authored-By trailer matches.
 */
export function attributeTrackedLines(options: AttributionOptions): LineAttribution {
  const root = resolve(options.root);
  const requestedRevision = options.revision ?? "HEAD";
  const maxFiles = positiveLimit(options.maxFiles, DEFAULT_MAX_FILES, "maxFiles");
  const maxFileBytes = positiveLimit(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES, "maxFileBytes");
  const maxLines = positiveLimit(options.maxLines, DEFAULT_MAX_LINES, "maxLines");
  const maxCommits = positiveLimit(options.maxCommits, DEFAULT_MAX_COMMITS, "maxCommits");
  const timeoutMs = positiveLimit(options.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs");
  const paths = [...new Set(options.paths)];

  if (paths.length === 0) throw new Error("paths must contain at least one tracked file");
  if (paths.length > maxFiles) throw new Error(`refusing to attribute ${paths.length} files; maxFiles is ${maxFiles}`);
  if (options.agentIdentities.length === 0) throw new Error("agentIdentities must contain at least one exact name/email pair");

  const agentKeys = new Set(options.agentIdentities.map(identityKey));
  if (agentKeys.size !== options.agentIdentities.length) {
    throw new Error("agentIdentities contains duplicate pairs after normalization");
  }

  const shallow = git(root, ["rev-parse", "--is-shallow-repository"], timeoutMs, "checking repository history depth").trim();
  if (shallow === "true") {
    throw new Error("line attribution requires complete local history; the repository is shallow");
  }
  const revision = git(
    root,
    ["rev-parse", "--verify", `${requestedRevision}^{commit}`],
    timeoutMs,
    `resolving revision ${JSON.stringify(requestedRevision)}`,
  ).trim();
  const blameByPath = new Map<string, string[]>();
  const allCommits = new Set<string>();
  let lineCount = 0;

  for (const path of paths) {
    if (path.includes("\0")) throw new Error(`path contains a NUL byte: ${JSON.stringify(path)}`);
    const sizeText = git(
      root,
      ["cat-file", "-s", `${revision}:${path}`],
      timeoutMs,
      `measuring ${JSON.stringify(path)} at ${JSON.stringify(revision)}`,
    ).trim();
    const bytes = Number(sizeText);
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new Error(`git returned an invalid byte size for ${JSON.stringify(path)}: ${JSON.stringify(sizeText)}`);
    }
    if (bytes > maxFileBytes) {
      throw new Error(`${JSON.stringify(path)} is ${bytes} bytes; maxFileBytes is ${maxFileBytes}`);
    }
    const blame = git(
      root,
      ["blame", "--line-porcelain", revision, "--", path],
      timeoutMs,
      `attributing ${JSON.stringify(path)} at ${JSON.stringify(revision)}`,
    );
    const commits = commitIdsFromBlame(blame, path);
    lineCount += commits.length;
    if (lineCount > maxLines) throw new Error(`refusing to attribute more than ${maxLines} surviving lines`);
    commits.forEach(commit => allCommits.add(commit));
    if (allCommits.size > maxCommits) throw new Error(`refusing to inspect more than ${maxCommits} unique commits`);
    blameByPath.set(path, commits);
  }

  const classified = classifyCommits(root, [...allCommits].sort(), agentKeys, timeoutMs);
  const files = paths.map(path => {
    const commits = blameByPath.get(path)!;
    const agent = commits.filter(commit => classified.get(commit) === true).length;
    return { path, total: commits.length, agent, person: commits.length - agent };
  });
  const totals = files.reduce(
    (sum, file) => ({ total: sum.total + file.total, agent: sum.agent + file.agent, person: sum.person + file.person }),
    { total: 0, agent: 0, person: 0 },
  );
  if (totals.agent + totals.person !== totals.total) {
    throw new Error("internal attribution mismatch: agent and person lines do not sum to total lines");
  }
  return { revision, files, totals };
}

export function sortAttributionRows<T extends AttributionRow>(rows: readonly T[]): T[] {
  return [...rows].sort((left, right) => {
    const category = left.category < right.category ? -1 : left.category > right.category ? 1 : 0;
    if (category !== 0) return category;
    return left.language < right.language ? -1 : left.language > right.language ? 1 : 0;
  });
}

export function batchPathsByUtf8Bytes(paths: readonly string[], maxBytes: number): string[][] {
  positiveLimit(maxBytes, maxBytes, "maxBytes");
  const encoder = new TextEncoder();
  const batches: string[][] = [];
  let current: string[] = [];
  let currentBytes = 0;
  for (const path of paths) {
    const bytes = encoder.encode(`${path}\0`).byteLength;
    if (bytes > maxBytes) {
      throw new Error(`path ${JSON.stringify(path)} needs ${bytes} UTF-8 bytes; maxBytes is ${maxBytes}`);
    }
    if (current.length > 0 && currentBytes + bytes > maxBytes) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(path);
    currentBytes += bytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  positiveLimit(concurrency, concurrency, "concurrency");
  const results = new Array<R>(items.length);
  let next = 0;
  async function run(): Promise<void> {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => run()));
  return results;
}

interface CountedEntry {
  path: string;
  name: string;
  total: number;
  code: number;
}

export function countLinesWithAttribution(revision = "HEAD"): LineAttributionReport {
  const counted = countLines(revision) as ReturnType<typeof countLines> & { entries?: CountedEntry[] };
  if (!counted.entries) {
    throw new Error("countLines() must expose tracked entries before attribution can run");
  }
  const attributed = attributeTrackedLines({
    root: join(import.meta.dir, ".."),
    paths: counted.entries.map(entry => entry.path),
    revision: counted.revision,
    agentIdentities: KNOWN_AGENT_IDENTITIES,
  });
  const byPath = new Map(attributed.files.map(file => [file.path, file]));
  const rows = counted.rows.map(row => {
    const entries = counted.entries!.filter(entry => entry.name === row.name);
    const agent = entries.reduce((sum, entry) => sum + (byPath.get(entry.path)?.agent ?? 0), 0);
    const people = entries.reduce((sum, entry) => sum + (byPath.get(entry.path)?.person ?? 0), 0);
    if (entries.some(entry => !byPath.has(entry.path))) {
      throw new Error(`attribution omitted one or more tracked files in bucket ${JSON.stringify(row.name)}`);
    }
    for (const entry of entries) {
      const file = byPath.get(entry.path)!;
      if (file.total !== entry.total) {
        throw new Error(
          `blame/count mismatch for ${JSON.stringify(entry.path)}: blame=${file.total}, counted=${entry.total}`,
        );
      }
    }
    if (agent + people !== row.total) {
      throw new Error(`attribution does not equal physical lines in bucket ${JSON.stringify(row.name)}`);
    }
    return {
      name: row.name,
      files: row.files,
      total: row.total,
      nonBlank: row.code,
      agent,
      people,
    };
  });
  const totals = rows.reduce(
    (sum, row) => ({
      files: sum.files + row.files,
      total: sum.total + row.total,
      nonBlank: sum.nonBlank + row.nonBlank,
      agent: sum.agent + row.agent,
      people: sum.people + row.people,
    }),
    { files: 0, total: 0, nonBlank: 0, agent: 0, people: 0 },
  );
  if (totals.agent + totals.people !== totals.total) {
    throw new Error("attribution arithmetic mismatch: agent and people lines do not equal physical lines");
  }
  return {
    revision: attributed.revision,
    rows,
    totals,
    excluded: { assets: counted.assets, unreadable: counted.unreadable },
  };
}

export function formatLineAttributionTable(report: LineAttributionReport): string {
  const n = (value: number) => value.toLocaleString("en-US");
  return [
    "| Area | Files | Lines | Non-blank | Agent | People |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...report.rows.map(row =>
      `| ${row.name} | ${n(row.files)} | ${n(row.total)} | ${n(row.nonBlank)} | ${n(row.agent)} | ${n(row.people)} |`,
    ),
    `| **Project total (counted text)** | **${n(report.totals.files)}** | **${n(report.totals.total)}** | **${n(report.totals.nonBlank)}** | **${n(report.totals.agent)}** | **${n(report.totals.people)}** |`,
    `| Excluded — binary assets | ${n(report.excluded.assets)} | — | — | — | — |`,
    `| Excluded — unreadable text | ${n(report.excluded.unreadable)} | — | — | — | — |`,
    `| **Grand total (tracked files)** | **${n(report.totals.files + report.excluded.assets + report.excluded.unreadable)}** | **${n(report.totals.total)}** | **${n(report.totals.nonBlank)}** | **${n(report.totals.agent)}** | **${n(report.totals.people)}** |`,
    "",
    `Surviving physical lines attributed with \`git blame\` at exact commit \`${report.revision}\`; author and \`Co-Authored-By\` identities use exact normalized name/email pairs.`,
    `Excluded from line attribution: ${n(report.excluded.assets)} tracked assets and ${n(report.excluded.unreadable)} unreadable text files.`,
  ].join("\n");
}
