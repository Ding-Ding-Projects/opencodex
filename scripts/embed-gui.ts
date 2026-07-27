/**
 * Single authority for the Go-embedded GUI bundle.
 *
 * `go/internal/server/static/**` and `static-manifest.json` are compiled into the packaged
 * Go binary (go/internal/server/static.go `//go:embed`). They are a committed copy of
 * `gui/dist`, which is gitignored — so nothing in CI noticed when upstream GUI changes made
 * the embedded copy stale and the packaged binary started serving an older dashboard.
 *
 * Modes:
 *   (default)       build the GUI, replace the embedded tree, rewrite the manifest
 *   --check         build into a temporary directory and diff against the committed tree
 *   --verify-dist   compare the EXISTING gui/dist against the committed tree, no rebuild
 *
 * `--check` is the CI guard. `--verify-dist` is the release guard: release builds run
 * `build:publish` first, so the bytes that matter are already on disk and rebuilding them
 * would prove the wrong thing.
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const distDir = join(root, "gui", "dist");
const embedDir = join(root, "go", "internal", "server", "static");
const manifestPath = join(root, "go", "internal", "server", "static-manifest.json");

function fail(message: string): never {
  console.error(`embed-gui: ${message}`);
  process.exit(1);
}

/** Relative POSIX paths of every file below `dir`, sorted for stable comparison. */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(relative(dir, full).split(sep).join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Every difference between two trees: missing, extra, and content-mismatched files. */
function diffTrees(expected: string, actual: string): string[] {
  const expectedFiles = listFiles(expected);
  const actualFiles = listFiles(actual);
  const problems: string[] = [];
  for (const name of expectedFiles) {
    if (!actualFiles.includes(name)) problems.push(`missing from embedded tree: ${name}`);
    else if (sha256(join(expected, name)) !== sha256(join(actual, name))) problems.push(`content differs: ${name}`);
  }
  for (const name of actualFiles) {
    if (!expectedFiles.includes(name)) problems.push(`stale file in embedded tree: ${name}`);
  }
  return problems;
}

function buildGui(): void {
  const result = spawnSync("bun", ["run", "build:gui"], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) fail(`bun run build:gui exited ${result.status ?? "without status"}`);
}

function writeManifest(dir: string): void {
  const files = listFiles(dir).map(path => ({ path, sha256: sha256(join(dir, path)) }));
  writeFileSync(manifestPath, `${JSON.stringify({ algorithm: "sha256", files }, null, 2)}\n`);
}

function regenerate(): void {
  buildGui();
  if (!existsSync(join(distDir, "index.html"))) fail("gui/dist/index.html is absent after build");
  // Remove the tree wholesale: hashed filenames change per build, so merging would leave
  // orphaned assets embedded in the binary forever.
  rmSync(embedDir, { recursive: true, force: true });
  mkdirSync(embedDir, { recursive: true });
  cpSync(distDir, embedDir, { recursive: true });
  writeManifest(embedDir);
  console.log(`embed-gui: regenerated ${listFiles(embedDir).length} files into go/internal/server/static`);
}

function check(): void {
  buildGui();
  if (!existsSync(join(distDir, "index.html"))) fail("gui/dist/index.html is absent after build");
  const staging = mkdtempSync(join(tmpdir(), "ocx-embed-check-"));
  try {
    cpSync(distDir, staging, { recursive: true });
    const problems = diffTrees(staging, embedDir);
    if (problems.length > 0) {
      console.error("embed-gui: the embedded GUI bundle is stale.");
      for (const problem of problems) console.error(`  ${problem}`);
      console.error("Run: bun scripts/embed-gui.ts   and commit go/internal/server/static/** plus static-manifest.json");
      process.exit(1);
    }
    verifyManifest();
    console.log("embed-gui: embedded GUI bundle matches a fresh build");
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function verifyDist(): void {
  if (!existsSync(join(distDir, "index.html"))) fail("gui/dist/index.html is absent — run bun run build:gui first");
  const problems = diffTrees(distDir, embedDir);
  if (problems.length > 0) {
    console.error("embed-gui: gui/dist does not match the embedded GUI bundle.");
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  verifyManifest();
  console.log(`embed-gui: gui/dist matches the embedded bundle (${listFiles(embedDir).length} files)`);
}

/** The manifest is embedded too, so a correct tree with a stale manifest is still a defect. */
function verifyManifest(): void {
  if (!existsSync(manifestPath)) fail("static-manifest.json is missing");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { algorithm?: string; files?: { path: string; sha256: string }[] };
  if (manifest.algorithm !== "sha256" || !Array.isArray(manifest.files)) fail("static-manifest.json is malformed");
  const actual = listFiles(embedDir);
  const listed = manifest.files.map(file => file.path).sort();
  if (JSON.stringify(actual) !== JSON.stringify(listed)) {
    fail("static-manifest.json does not list exactly the embedded files — run: bun scripts/embed-gui.ts");
  }
  for (const file of manifest.files) {
    if (sha256(join(embedDir, file.path)) !== file.sha256) {
      fail(`static-manifest.json digest mismatch for ${file.path} — run: bun scripts/embed-gui.ts`);
    }
  }
}

const mode = process.argv[2];
if (mode === undefined) regenerate();
else if (mode === "--check") check();
else if (mode === "--verify-dist") verifyDist();
else fail(`unknown mode '${mode}' (expected --check or --verify-dist)`);
