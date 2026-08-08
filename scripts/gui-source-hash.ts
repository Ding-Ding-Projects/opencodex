import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
export const guiRoot = join(repositoryRoot, "gui");

/**
 * Every path Vite can read while producing the dashboard.
 *
 * Most inputs live below `gui/`, but the Material shell deliberately shares its
 * reducers and design primitives with the docs site through `shared/m3/`. Leaving
 * that external import tree out of the identity lets a changed tab engine or
 * theme ship beside an older bundle while the package gate still reports a
 * match.
 */
const GUI_INPUTS = [
  "gui/src",
  "gui/public",
  "gui/index.html",
  "gui/package.json",
  "gui/bun.lock",
  "gui/vite.config.ts",
  "gui/tsconfig.json",
  "gui/tsconfig.app.json",
  "gui/tsconfig.node.json",
  "shared/m3",
  "package.json",
];

function collectFiles(path: string, files: string[]): void {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return;
  if (stat.isSymbolicLink()) {
    throw new Error(`GUI build input must not be a symbolic link: ${relative(repositoryRoot, path)}`);
  }
  if (stat.isFile()) {
    files.push(path);
    return;
  }
  if (!stat.isDirectory()) return;
  const entries = readdirSync(path).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  for (const entry of entries) collectFiles(join(path, entry), files);
}

function addField(hash: ReturnType<typeof createHash>, value: Buffer | string): void {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  const size = Buffer.allocUnsafe(8);
  size.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(size);
  hash.update(bytes);
}

/** Content identity for everything the production dashboard build reads. */
export function computeGuiSourceHash(root: string = repositoryRoot): string {
  const files: string[] = [];
  for (const input of GUI_INPUTS) collectFiles(join(root, input), files);
  files.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);

  const hash = createHash("sha256");
  for (const file of files) {
    addField(hash, relative(root, file).replaceAll("\\", "/"));
    addField(hash, readFileSync(file));
  }
  return `sha256:${hash.digest("hex")}`;
}

export function packageVersion(): string {
  const parsed = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as { version?: unknown };
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error("package.json does not contain a valid version");
  }
  return parsed.version;
}
