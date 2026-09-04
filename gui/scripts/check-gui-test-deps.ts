/**
 * GUI tests need the repository-root dependencies, not just gui/'s own tree.
 *
 * The suite imports the proxy's sources directly — `src/config.ts` needs
 * `zod/v4`, and `tests/helpers/providers.tsx` imports `src/settings-drafts`
 * and friends — so a GUI-only install used to surface mid-suite as
 * "Unhandled error between tests … Cannot find module 'zod/v4'", which reads
 * like cross-test pollution. Wired as the `[test] preload` in gui's
 * bunfig.toml, this check turns that state into one actionable failure that
 * names the remedy instead.
 *
 * The predicate matters: `bun test`'s loader resolves bare imports only
 * through `node_modules` directories up the directory tree, while
 * `createRequire().resolve()` additionally falls back to Bun's global install
 * cache (`~/.bun/install/cache`). Checking plain resolvability would therefore
 * false-pass on a machine with a warm cache — exactly the state this guard
 * exists to catch — so a resolution only counts when it landed in a
 * `node_modules` tree.
 */
import { createRequire } from "node:module";
import { resolve } from "node:path";

/** Directory whose resolution walk must find every root-only module: the proxy's src/. */
const proxySrcDir = resolve(import.meta.dir, "..", "..", "src");

/** Modules only the repository-root install provides; gui/package.json does not declare them. */
const requiredRootModules = ["zod/v4"] as const;

export function missingRootModules(baseDir = proxySrcDir): string[] {
  return requiredRootModules.filter(specifier => {
    try {
      const resolved = createRequire(resolve(baseDir, "config.ts")).resolve(specifier);
      return !resolved.replaceAll("\\", "/").includes("/node_modules/");
    } catch {
      return true;
    }
  });
}

function fail(missing: string[]): never {
  console.error(
    `[gui tests] Missing proxy dependencies: ${missing.join(", ")}. `
      + "Run `bun install` at the repository root (gui/ keeps its own install). "
      + "This is a missing install, not a regression.",
  );
  process.exit(1);
}

const missing = missingRootModules();
if (missing.length > 0) fail(missing);
