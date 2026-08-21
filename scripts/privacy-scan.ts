import {
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

export type Finding = {
  file: string;
  line: number;
  kind: string;
  value: string;
};

export type PrivacyScanOptions = {
  root?: string;
  trackedFiles?: string[];
  /** Test-only overlay for the historical copy; production always uses the checkout. */
  designReferenceRoot?: string;
};

const TEXT_FILE_RE = /\.(?:cjs|css|html|js|json|jsonc|md|mjs|ps1|sh|toml|ts|tsx|txt|yml|yaml)$/;
const EXCLUDED_PREFIXES = [
  // Design prototype. `design/ocx-data.js` is offline mock data shaped like the
  // real /api/* payloads, so it contains placeholder account emails on purpose.
  // Nothing here is imported by src/ or gui/src/, and the package `files`
  // allowlist keeps it out of the published tarball.
  "design/",
  "devlog/",
  "gui/dist/",
  "node_modules/",
  "tests/.tmp-",
];
const EXCLUDED_SUFFIXES = [
  "bun.lock",
  "package-lock.json",
];

const DESIGN_REFERENCE_PREFIX = "design-reference/original-source/";
const DESIGN_REFERENCE_MANIFEST = `${DESIGN_REFERENCE_PREFIX}MANIFEST.json`;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_HISTORICAL_FILE_BYTES = 16 * 1024 * 1024;
const DESIGN_REFERENCE_SOURCE_DIRECTORY = "design/";
const DESIGN_REFERENCE_COPY_DIRECTORY = "design-reference/original-source/";
const MANIFEST_ROOT_KEYS = new Set(["schemaVersion", "sourceCommit", "sourceDirectory", "copyDirectory", "ordering", "fileCount", "files"]);
const MANIFEST_ENTRY_KEYS = new Set(["path", "historicalPath", "blob", "bytes", "sha256"]);

type HistoricalManifestEntry = {
  path: string;
  historicalPath: string;
  blob: string;
  bytes: number;
  sha256: string;
};

function finding(file: string, kind: string, value: string): Finding {
  return { file, line: 1, kind, value };
}

function runGit(root: string, args: string[]): { success: boolean; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  return {
    success: result.success,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function gitBlobForBytes(bytes: Uint8Array): string {
  // Git's blob id is SHA-1 over this exact type-and-length header plus bytes.
  // Computing it here keeps validation deterministic and avoids spawning one
  // process per historical file while retaining the same content address as
  // `git hash-object`.
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  return createHash("sha1").update(header).update(bytes).digest("hex");
}

function pathForFile(root: string, file: string, designReferenceRoot?: string): string {
  if (designReferenceRoot && file.startsWith(DESIGN_REFERENCE_PREFIX)) {
    return join(designReferenceRoot, file.slice(DESIGN_REFERENCE_PREFIX.length));
  }
  return join(root, ...file.split("/"));
}

function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return false;
  if (value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
  const segments = value.split("/");
  return segments.every(segment => segment.length > 0 && segment !== "." && segment !== "..");
}

function isRegularFile(path: string): boolean {
  try {
    const stats = lstatSync(path);
    return stats.isFile() && !stats.isSymbolicLink();
  } catch {
    return false;
  }
}

function hasReparseOrSymlink(path: string): boolean {
  try {
    const stats = lstatSync(path);
    return stats.isSymbolicLink();
  } catch {
    return false;
  }
}

function listFilesOnDisk(root: string): { files: string[]; invalidPaths: string[] } {
  const files: string[] = [];
  const invalidPaths: string[] = [];

  function walk(directory: string, prefix: string): void {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      invalidPaths.push(prefix || ".");
      return;
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(directory, entry.name);
      if (entry.isSymbolicLink() || hasReparseOrSymlink(full)) {
        invalidPaths.push(rel);
        continue;
      }
      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (entry.isFile()) {
        files.push(rel);
      } else {
        invalidPaths.push(rel);
      }
    }
  }

  walk(root, "");
  return { files, invalidPaths };
}

function parseHistoricalManifest(
  root: string,
  designReferenceRoot: string,
): { manifest: { sourceCommit: string; files: HistoricalManifestEntry[] } | undefined; excludedFiles: Set<string>; findings: Finding[] } {
  const findings: Finding[] = [];
  const excludedFiles = new Set<string>();
  if (!isRegularFile(designReferenceRoot) && hasReparseOrSymlink(designReferenceRoot)) {
    findings.push(finding(DESIGN_REFERENCE_PREFIX, "historical-design-path", "copy root is a symlink or reparse point"));
    return { manifest: undefined, excludedFiles, findings };
  }
  const manifestPath = join(designReferenceRoot, "MANIFEST.json");
  if (!isRegularFile(manifestPath)) {
    findings.push(finding(DESIGN_REFERENCE_MANIFEST, "historical-design-manifest", "manifest is missing or not a regular file"));
    return { manifest: undefined, excludedFiles, findings };
  }
  let manifestBytes: Uint8Array;
  try {
    manifestBytes = readFileSync(manifestPath);
  } catch {
    findings.push(finding(DESIGN_REFERENCE_MANIFEST, "historical-design-manifest", "manifest cannot be read"));
    return { manifest: undefined, excludedFiles, findings };
  }
  if (manifestBytes.byteLength > MAX_MANIFEST_BYTES) {
    findings.push(finding(DESIGN_REFERENCE_MANIFEST, "historical-design-manifest", "manifest exceeds the size limit"));
    return { manifest: undefined, excludedFiles, findings };
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch {
    findings.push(finding(DESIGN_REFERENCE_MANIFEST, "historical-design-manifest", "manifest is not valid JSON"));
    return { manifest: undefined, excludedFiles, findings };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    findings.push(finding(DESIGN_REFERENCE_MANIFEST, "historical-design-manifest", "manifest root is not an object"));
    return { manifest: undefined, excludedFiles, findings };
  }
  const raw = value as Record<string, unknown>;
  const sourceCommit = raw.sourceCommit;
  const files = raw.files;
  if (![...Object.keys(raw)].every(key => MANIFEST_ROOT_KEYS.has(key)) ||
      ![...MANIFEST_ROOT_KEYS].every(key => Object.prototype.hasOwnProperty.call(raw, key)) ||
      raw.schemaVersion !== 1 || raw.sourceDirectory !== DESIGN_REFERENCE_SOURCE_DIRECTORY ||
      raw.copyDirectory !== DESIGN_REFERENCE_COPY_DIRECTORY || raw.ordering !== "git-tree-order" ||
      typeof sourceCommit !== "string" || !/^[0-9a-f]{40}$/.test(sourceCommit) || !Array.isArray(files)) {
    findings.push(finding(DESIGN_REFERENCE_MANIFEST, "historical-design-manifest", "manifest metadata is invalid"));
    return { manifest: undefined, excludedFiles, findings };
  }
  if (files.length > 4096 || raw.fileCount !== files.length) {
    findings.push(finding(DESIGN_REFERENCE_MANIFEST, "historical-design-manifest", "manifest file count is invalid"));
    return { manifest: undefined, excludedFiles, findings };
  }
  const parsed: HistoricalManifestEntry[] = [];
  const seen = new Set<string>();
  for (const item of files) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      findings.push(finding(DESIGN_REFERENCE_MANIFEST, "historical-design-manifest", "manifest entry is invalid"));
      continue;
    }
    const entry = item as Record<string, unknown>;
    if (![...Object.keys(entry)].every(key => MANIFEST_ENTRY_KEYS.has(key)) ||
        ![...MANIFEST_ENTRY_KEYS].every(key => Object.prototype.hasOwnProperty.call(entry, key))) {
      findings.push(finding(DESIGN_REFERENCE_MANIFEST, "historical-design-manifest", "manifest entry fields are invalid"));
      continue;
    }
    const path = entry.path;
    const historicalPath = entry.historicalPath;
    const blob = entry.blob;
    const bytes = entry.bytes;
    const entrySha256 = entry.sha256;
    if (!isSafeRelativePath(path) || !isSafeRelativePath(historicalPath) ||
        typeof blob !== "string" || !/^[0-9a-f]{40}$/.test(blob) ||
        typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_HISTORICAL_FILE_BYTES ||
        typeof entrySha256 !== "string" || !/^[0-9a-f]{64}$/.test(entrySha256) ||
        historicalPath !== `${DESIGN_REFERENCE_SOURCE_DIRECTORY}${path}` || seen.has(path)) {
      findings.push(finding(DESIGN_REFERENCE_MANIFEST, "historical-design-manifest", "manifest entry value is invalid"));
      continue;
    }
    seen.add(path);
    parsed.push({ path, historicalPath, blob, bytes, sha256: entrySha256 });
  }
  if (parsed.length !== files.length) return { manifest: undefined, excludedFiles, findings };

  const sourceTree = runGit(root, ["ls-tree", "-r", "--name-only", sourceCommit, "--", "design"]);
  const historicalTree = sourceTree.success
    ? sourceTree.stdout.split(/\r?\n/).filter(Boolean).map(path => path.startsWith("design/") ? path.slice(7) : path)
    : [];
  const expectedTree = parsed.map(entry => entry.path);
  if (!sourceTree.success || historicalTree.join("\n") !== expectedTree.join("\n")) {
    findings.push(finding(DESIGN_REFERENCE_MANIFEST, "historical-design-manifest", "manifest source tree does not match"));
  }
  const firstDesignCommit = runGit(root, ["log", "--reverse", "--diff-filter=A", "--format=%H", "--", "design"]);
  if (!firstDesignCommit.success || firstDesignCommit.stdout.split(/\r?\n/).filter(Boolean)[0] !== sourceCommit) {
    findings.push(finding(DESIGN_REFERENCE_MANIFEST, "historical-design-manifest", "manifest source commit does not match"));
  }

  const copied = listFilesOnDisk(designReferenceRoot);
  const allowedSupportFiles = new Set(["MANIFEST.json", "PROVENANCE.md"]);
  const expectedCopyFiles = new Set([...expectedTree, ...allowedSupportFiles]);
  const actualCopyFiles = new Set(copied.files);
  for (const invalidPath of copied.invalidPaths) {
    findings.push(finding(`${DESIGN_REFERENCE_PREFIX}${invalidPath}`, "historical-design-path", "symlink, reparse point, or unreadable path"));
  }
  for (const path of actualCopyFiles) {
    if (!expectedCopyFiles.has(path)) {
      findings.push(finding(`${DESIGN_REFERENCE_PREFIX}${path}`, "historical-design-path", "unlisted path"));
    }
  }
  for (const path of expectedCopyFiles) {
    if (!actualCopyFiles.has(path)) {
      findings.push(finding(`${DESIGN_REFERENCE_PREFIX}${path}`, "historical-design-path", "missing path"));
    }
  }

  // A wrong source commit/tree or an unsafe copied-directory shape invalidates
  // the whole exception. Content checks below may narrow a valid manifest to
  // exact matching files, but they may never revive a structurally invalid one.
  const metadataValid = findings.length === 0;
  for (const entry of parsed) {
    const copyRelative = `${DESIGN_REFERENCE_PREFIX}${entry.path}`;
    const copyPath = join(designReferenceRoot, ...entry.path.split("/"));
    if (!isRegularFile(copyPath)) {
      findings.push(finding(copyRelative, "historical-design-source", "copy is missing or not a regular file"));
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(copyPath);
    } catch {
      findings.push(finding(copyRelative, "historical-design-source", "copy cannot be read"));
      continue;
    }
    const blob = gitBlobForBytes(bytes);
    if (bytes.byteLength !== entry.bytes || sha256(bytes) !== entry.sha256 || blob !== entry.blob) {
      findings.push(finding(copyRelative, "historical-design-source", "copy bytes do not match the historical manifest"));
      continue;
    }
    if (metadataValid) excludedFiles.add(copyRelative);
  }
  return { manifest: { sourceCommit, files: parsed }, excludedFiles, findings };
}

function validatePackageAllowlist(root: string): Finding[] {
  const packagePath = join(root, "package.json");
  if (!isRegularFile(packagePath)) return [];
  try {
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as { files?: unknown };
    if (!Array.isArray(packageJson.files)) {
      return [finding("package.json", "package-allowlist", "files allowlist is missing or invalid")];
    }
    const includesHistoricalCopy = packageJson.files.some(
      value => typeof value === "string" && (value === "design-reference" || value.startsWith("design-reference/")),
    );
    return includesHistoricalCopy
      ? [finding("package.json", "package-allowlist", "package files allowlist includes design-reference")]
      : [];
  } catch {
    return [finding("package.json", "package-allowlist", "package.json is not valid JSON")];
  }
}

function gitLsFiles(root: string): string[] {
  const result = Bun.spawnSync(["git", "-C", root, "ls-files"], { stdout: "pipe", stderr: "pipe" });
  if (!result.success) {
    const stderr = new TextDecoder().decode(result.stderr);
    throw new Error(`git ls-files failed: ${stderr.trim() || result.exitCode}`);
  }
  return new TextDecoder()
    .decode(result.stdout)
    .split(/\r?\n/)
    .filter(Boolean);
}

function shouldScan(file: string, excludedFiles: Set<string>): boolean {
  if (!TEXT_FILE_RE.test(file)) return false;
  if (EXCLUDED_PREFIXES.some(prefix => file.startsWith(prefix))) return false;
  if (EXCLUDED_SUFFIXES.some(suffix => file.endsWith(suffix))) return false;
  if (excludedFiles.has(file)) return false;
  return true;
}

function lineNumber(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function isAllowedEmail(file: string, email: string): boolean {
  if (file === "scripts/privacy-scan.ts" && email === "a@b.com") return true;
  const domain = email.split("@").at(1)?.toLowerCase() ?? "";
  if (domain === "example.test" || domain === "example.com" || domain === "test.com" || domain.endsWith(".test")) {
    return true;
  }
  // URL-userinfo fixtures (https://user:pw@host/...) read as "pw@host" — not emails.
  if (file.startsWith("tests/") && email === ["pw", "chatgpt.com"].join("@")) return true;
  return file.startsWith("tests/") && email === "a@b.com";
}

function isAllowedHomePath(file: string, username: string): boolean {
  // "Public" is a fixed, built-in Windows profile name that carries zero
  // per-machine operator identity -- the neutral capture-harness home
  // (`scripts/capture-env-privacy.ts`) deliberately lives under
  // `C:\Users\Public\...`, and this project's own source and tests are
  // allowed to say so in full without being flagged as though "Public" were
  // somebody's real account. Unlike the file-scoped allowances below, this
  // one is unconditional: "Public" can never coincide with a real leaked
  // username, the same way `isAllowedEmail`'s `example.com`/`.test` domains
  // are allowed everywhere rather than only under `tests/`.
  if (username === "Public") return true;
  if (file.startsWith("tests/") && (username === "example" || username === "test" || username === "x")) {
    return true;
  }
  if (file.startsWith("docs/") && (username === "me" || username === "user")) return true;
  if (file.startsWith("docs-site/") && username === "example") return true;
  // Same placeholder-path convention as the rest of the docs, just written as
  // a real Windows command example rather than a bare path. Was invisible to
  // the old forward-slash-only pattern; genuinely caught, and genuinely fine,
  // now that Windows-style paths are scanned too.
  if (file === "docs-site/src/content/docs/guides/pdf-tools.md" && username === "you") return true;
  // A generic single-letter placeholder in a code comment illustrating an
  // environment-variable shape, not a path anyone's real profile ever has.
  if (file === "src/lib/trusted-path.mjs" && username === "x") return true;
  // This file's own doc comment on the pattern below, illustrating the two
  // path shapes it now matches -- the same self-reference `isAllowedEmail`
  // already carves out for this file's `a@b.com` example, immediately below.
  if (file === "scripts/privacy-scan.ts" && username === "name") return true;
  // The offline documentation browser bundles the docs-site articles verbatim,
  // so the sample `ocx status` output above -- already allowed at its source on
  // the line before this one -- arrives here under a path the source rule cannot
  // match. Allowing it only for this one generated file, and only for the same
  // `example` placeholder, keeps the exemption attached to the content rather
  // than to the directory it happens to be sitting in. Anything else in this
  // file, including a real username, still fails.
  if (file === "gui/src/docs/generated-articles.ts" && username === "example") return true;
  return false;
}

function isAllowedTokenLooking(file: string, token: string): boolean {
  // Test fixture sentinels: sk-rawsentinel..., sk-test-...
  if (file.startsWith("tests/") && /^sk-(?:rawsentinel|test-)\d+[a-z]*$/.test(token)) return true;
  // The screenshot seed needs providers that look configured, so it writes
  // key-shaped values into a throwaway profile. `CAPTURE-FIXTURE` sits in the
  // middle of the value and the rest is zeros, which is about as far from a
  // real key as a key-shaped string can get -- and that legibility is the
  // point. Renaming it to something that passes the `tests/` pattern above
  // would make it *less* obviously fake to a human reading a diff, which is
  // the wrong direction for a value that ends up in a committed script.
  //
  // Scoped to that one file and that one marker. Anything else here, including
  // a real key, still fails.
  if (file === "scripts/capture-seed.ts" && /^sk-(?:ant-)?CAPTURE-FIXTURE-0+$/.test(token)) return true;
  return false;
}

function isAllowedBearerToken(file: string, token: string): boolean {
  if (!file.startsWith("tests/")) return false;
  // The original three fixture families, which read like real tokens on purpose
  // so the code under test cannot tell the difference.
  if (/^(?:access|stack|usage-debug)-token(?:-value)?-[A-Za-z0-9-]+$/.test(token)) return true;
  // An explicit sentinel, in tests only. The credential-forwarding and redaction
  // suites need values a *reader* can tell are fake at a glance -- the whole point
  // of `SENTINEL-DO-NOT-FORWARD-TOKEN` is that anyone who finds it in a log knows
  // immediately that nothing leaked. Forcing those to masquerade as
  // `access-token-...` to satisfy this scan would trade that clarity for nothing:
  // a scan that only accepts token-shaped fakes teaches people to write
  // token-shaped fakes, and then a real one hides among them.
  //
  // Deliberately narrow: uppercase prefix, uppercase-and-digits body, tests/ only.
  // A real credential does not look like this, and nothing outside tests/ may use it.
  return /^SENTINEL-[A-Z0-9][A-Z0-9-]*$/.test(token);
}

function addFindingsForPattern(
  findings: Finding[],
  file: string,
  text: string,
  kind: string,
  pattern: RegExp,
  allow: (match: RegExpExecArray) => boolean,
): void {
  for (const match of text.matchAll(pattern)) {
    if (allow(match)) continue;
    findings.push({
      file,
      line: lineNumber(text, match.index ?? 0),
      kind,
      value: match[0],
    });
  }
}

/**
 * The account name of whoever is running this scan, or `""` when it cannot be
 * determined or is too generic to search for safely.
 *
 * ## Why this exists alongside the `home-path` pattern below
 *
 * The `home-path` pattern misses the one escaping form a TypeScript source
 * file actually contains. A `.ts` literal holding a Windows path is written
 * `"C:\\Users\\name\\..."`, so the *raw bytes* on disk carry TWO separator
 * characters between components, and `[\\/]Users[\\/]` -- which matches
 * exactly one -- never fires. Measured, not assumed: the single-backslash and
 * forward-slash forms match, the double-backslash form does not.
 *
 * That is not hypothetical. `tests/capture-env-privacy.test.ts` was written
 * with the real operator username double-escaped in four places, the scan
 * passed clean, and it was caught by a human reading the file. Widening to
 * `[\\/]+` would close it, but only at the price of flagging roughly a dozen
 * legitimate fixture usernames already in `tests/` -- `tester`, `alice`,
 * `bob`, `demo`, `real`, `a`, `u`, `x` -- and an allowlist that has to grow
 * every time somebody writes a new fixture path is an allowlist whose failure
 * mode points the wrong way: each addition is a fresh chance to wave a real
 * name through.
 *
 * So this check does not pattern-match paths at all. It searches for the bare
 * account name as a substring, which is escaping-agnostic by construction --
 * `C:\\Users\\name`, `/Users/name/`, `%USERPROFILE%` expanded, a bare mention
 * in a comment, or any shape nobody has thought of yet all contain it
 * identically. No allowlist, nothing to maintain, and it cannot be satisfied
 * by a fabricated name.
 *
 * ## What it deliberately does NOT cover
 *
 * Only the machine running the scan. A *different* person's username committed
 * from another machine is invisible to it, and no text scan can see a username
 * rendered into a PNG at all -- which is how `download-complete-popup.png` and
 * `snackbar.png` shipped one. The actual fix for the pixels is upstream of any
 * scan: `scripts/capture-env-privacy.ts` rehomes the capture process tree onto
 * `C:\Users\Public\...` and refuses to launch if that did not take effect, so
 * the identifying path is never photographed in the first place. This is a
 * backstop for the text half, not a substitute for that.
 */
function currentAccountName(): string {
  const raw = (process.env.USERNAME || process.env.USER || "").trim();
  // Too short to search for without matching unrelated substrings everywhere
  // (a two-letter name would hit inside ordinary words), and the shared
  // built-in profile names carry no operator identity worth protecting.
  if (raw.length < 3) return "";
  if (["public", "default", "administrator", "runner", "root", "user"].includes(raw.toLowerCase())) return "";
  return raw;
}

const ACCOUNT_NAME = currentAccountName();

function addAccountNameFindings(findings: Finding[], file: string, text: string): void {
  if (!ACCOUNT_NAME) return;
  // Case-insensitive: Windows paths are routinely written `C:\USERS\Name\`,
  // and a leak is a leak whichever way it was capitalised.
  const pattern = new RegExp(ACCOUNT_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  for (const match of text.matchAll(pattern)) {
    findings.push({
      file,
      line: lineNumber(text, match.index ?? 0),
      kind: "operator-account-name",
      // Never echo the account name itself -- this output is printed to a
      // terminal, lands in CI logs, and is exactly the value being protected.
      value: "<this machine's account name>",
    });
  }
}

function scanFile(file: string, absolutePath: string): Finding[] {
  const text = readFileSync(absolutePath, "utf-8");
  const findings: Finding[] = [];
  addAccountNameFindings(findings, file, text);
  addFindingsForPattern(
    findings,
    file,
    text,
    "home-path",
    // Forward-slash `/Users/name/` (macOS/Linux) AND backslash
    // `C:\Users\name\` / `\Users\name\` (Windows, with or without a drive
    // letter) -- this project ships a Windows-only desktop app, and a
    // forward-slash-only pattern cannot match the one path shape every
    // committed screenshot could actually contain. `download-complete-popup.png`
    // and `snackbar.png` rendered the operator's real `C:\Users\<name>\...`
    // in pixels no text scan could ever see, but the same string also showed
    // up, unflagged, in this file's own scratch probe before this pattern
    // was widened -- see tests/capture-env-privacy.test.ts for the fix this
    // scan exists to double as a backstop for.
    /(?:[A-Za-z]:)?[\\/]Users[\\/]([A-Za-z0-9_-]+)[\\/]/g,
    match => isAllowedHomePath(file, match[1] ?? ""),
  );
  addFindingsForPattern(
    findings,
    file,
    text,
    "email",
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
    match => isAllowedEmail(file, match[0]),
  );
  addFindingsForPattern(
    findings,
    file,
    text,
    "bearer-token",
    /Bearer\s+([A-Za-z0-9._-]{24,})/g,
    match => isAllowedBearerToken(file, match[1] ?? ""),
  );
  addFindingsForPattern(
    findings,
    file,
    text,
    "token-looking",
    /\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9_]{20,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})\b/g,
    match => isAllowedTokenLooking(file, match[0]),
  );
  return findings;
}

export function scanRepository(options: PrivacyScanOptions = {}): Finding[] {
  const root = options.root ?? process.cwd();
  const trackedFiles = options.trackedFiles ?? gitLsFiles(root);
  const designReferenceRoot = options.designReferenceRoot ?? join(root, "design-reference", "original-source");
  const historical = parseHistoricalManifest(root, designReferenceRoot);
  const findings = [...historical.findings, ...validatePackageAllowlist(root)];
  return findings.concat(
    trackedFiles
      .filter(file => isRegularFile(pathForFile(root, file, options.designReferenceRoot)))
      .filter(file => shouldScan(file, historical.excludedFiles))
      .flatMap(file => scanFile(file, pathForFile(root, file, options.designReferenceRoot))),
  );
}

if (import.meta.main) {
  const findings = scanRepository();
  if (findings.length > 0) {
    console.error("Privacy scan failed:");
    for (const result of findings) {
      console.error(`${result.file}:${result.line} ${result.kind}: ${result.value}`);
    }
    process.exit(1);
  }
  console.log("Privacy scan passed");
}
