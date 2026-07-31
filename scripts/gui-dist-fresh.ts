/**
 * Decides whether the packaged dashboard in `gui/dist` still matches the
 * sources it was built from. `run.bat` asks this before spending a Vite build
 * on output that would be byte-for-byte what is already there.
 *
 * The answer is the exit code: 0 means the build can be skipped, anything else
 * means rebuild. That polarity is deliberate. A missing `gui/dist`, an
 * unreadable tree and a crash in this file all land on "rebuild", so the worst
 * case is a wasted build rather than a stale dashboard served as if it were
 * current — which presents as a source change that had no effect, and costs far
 * more than a minute of Vite.
 *
 * `gui/dist/index.html` is the build stamp rather than the newest file under
 * `gui/dist`, because Vite writes content-hashed asset names: a chunk whose
 * content did not change keeps its old mtime across builds, so a "newest file
 * in dist" scan can be dragged backwards by an asset nobody touched.
 * `index.html` is rewritten by every build.
 *
 * Directories are compared alongside files. Deleting a source file moves no
 * file mtime anywhere — only the mtime of the directory it used to live in — so
 * a files-only scan would call the dashboard fresh after a deletion.
 *
 * It deliberately does not read file contents, consult git, or follow imports.
 * This is a timestamp question and nothing more; `run.bat build` and
 * `run.bat --force` exist for the cases where a timestamp is not what the
 * contributor is actually asking about.
 */
import { readdirSync, statSync, type Stats } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const guiDir = join(repoRoot, "gui");
const buildStampPath = join(guiDir, "dist", "index.html");

/**
 * Everything a dashboard build reads. Entries that do not exist are skipped
 * rather than reported: `gui/public` is optional, and the config file list is
 * allowed to drift ahead of or behind any one checkout.
 */
const INPUTS = [
  "src",
  "public",
  "index.html",
  "package.json",
  "bun.lock",
  "vite.config.ts",
  "tsconfig.json",
  "tsconfig.app.json",
  "tsconfig.node.json",
];

interface NewestInput {
  path: string;
  mtimeMs: number;
}

function statOrUndefined(path: string): Stats | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

function newestUnder(path: string, newest: NewestInput | undefined): NewestInput | undefined {
  const stat = statOrUndefined(path);
  if (!stat) return newest;

  const candidate =
    !newest || stat.mtimeMs > newest.mtimeMs ? { path, mtimeMs: stat.mtimeMs } : newest;
  if (!stat.isDirectory()) return candidate;

  let result: NewestInput | undefined = candidate;
  for (const entry of readdirSync(path)) {
    result = newestUnder(join(path, entry), result);
  }
  return result;
}

/** Repository-relative and forward-slashed, so the message reads the same as the docs. */
function display(path: string): string {
  return `gui/${relative(guiDir, path).replaceAll("\\", "/")}`;
}

const stamp = statOrUndefined(buildStampPath);
if (!stamp) {
  console.log("gui/dist/index.html is missing: the dashboard has never been built here.");
  process.exit(1);
}

let newest: NewestInput | undefined;
for (const input of INPUTS) {
  newest = newestUnder(join(guiDir, input), newest);
}

// No sources at all means this is not the checkout we think it is. Rebuilding
// says so loudly through the build's own error instead of quietly claiming the
// dashboard is current.
if (!newest) {
  console.log("no dashboard sources found under gui/: not claiming the build is current.");
  process.exit(1);
}

if (newest.mtimeMs > stamp.mtimeMs) {
  console.log(`${display(newest.path)} is newer than gui/dist/index.html.`);
  process.exit(1);
}

console.log("gui/dist is newer than every dashboard source.");
process.exit(0);
