/**
 * Nothing in `src/` may import from a directory the npm package does not ship.
 *
 * This exists because the obvious refactor broke the CLI completely and nothing
 * local noticed. The export serialisers were moved to `shared/` — the right home
 * on the face of it, since the GUI and the documentation site both wanted them —
 * and `tsc --noEmit` was happy, `tsc -b` was happy, every test passed, and the
 * published package could not start at all:
 *
 *     error: Cannot find module '../../../shared/export-formats'
 *       from '…/node_modules/@bitkyc08/opencodex/src/server/management/export-routes.ts'
 *
 * `package.json` ships `bin`, `src`, `gui/dist` and a few assets. `shared/` is
 * not among them, and no typechecker knows that — the import resolves perfectly
 * in the repository and does not exist in the artifact. The only thing that
 * caught it was a CI step that runs `ocx help` from a real npm install, which is
 * a slow and late place to learn it.
 *
 * So the rule is checked here instead, in milliseconds, against `package.json`
 * itself rather than a copy of its list: if `files` changes, this follows.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Top-level directories the published package actually contains. */
function shippedRoots(): string[] {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")) as { files?: string[] };
  return (pkg.files ?? []).map(entry => entry.split("/")[0]);
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx|mts|cts)$/.test(entry)) out.push(full);
  }
  return out;
}

/** Every relative import in a file, as written. */
function relativeImports(text: string): string[] {
  const found: string[] = [];
  // `import … from "…"`, `export … from "…"`, and `await import("…")`.
  for (const match of text.matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g)) {
    found.push(match[1]);
  }
  return found;
}

describe("the shipping boundary", () => {
  const shipped = shippedRoots();
  const files = sourceFiles(join(ROOT, "src"));

  test("package.json still lists src, so this test is testing something", () => {
    // Guard the guard: if `files` stopped shipping `src`, every assertion below
    // would pass vacuously while the package was even more broken.
    expect(shipped).toContain("src");
    expect(files.length).toBeGreaterThan(100);
  });

  test("no file under src/ escapes into a directory the package omits", () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const spec of relativeImports(readFileSync(file, "utf-8"))) {
        const target = resolve(dirname(file), spec);
        const fromRoot = relative(ROOT, target).replace(/\\/g, "/");
        // Still inside src/ — fine, and the overwhelmingly common case.
        if (fromRoot.startsWith("src/")) continue;
        // Reaching out of the repository entirely would be stranger still, but
        // it is not what this rule is about.
        if (fromRoot.startsWith("..")) continue;
        const top = fromRoot.split("/")[0];
        if (!shipped.includes(top)) {
          offenders.push(`${relative(ROOT, file).replace(/\\/g, "/")} -> ${spec} (${top}/ is not in package.json files)`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
