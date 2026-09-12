import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

/**
 * Local agent/session state must never reach a commit.
 *
 * `.gitignore` alone does not enforce this: `git add -f` overrides it silently,
 * and once a path is tracked the ignore rule stops applying to it entirely. The
 * `.codexclaw/` goalplans and ledgers were committed exactly that way and rode
 * along into `main` and `preview` before anyone noticed.
 *
 * This test closes that gap by asserting against the real index instead of the
 * ignore file, so a forced add fails CI on the commit that introduces it.
 */
const FORBIDDEN_TRACKED_DIRS = [".codexclaw", ".omo", ".claude", "node_modules", ".tmp"];

const FORBIDDEN_TRACKED_FILENAMES = [".DS_Store", "Thumbs.db"];

function trackedFiles(): string[] {
  const result = Bun.spawnSync(["git", "ls-files"], { cwd: repoRoot });
  if (result.exitCode !== 0) {
    throw new Error(`git ls-files failed: ${new TextDecoder().decode(result.stderr)}`);
  }
  return new TextDecoder()
    .decode(result.stdout)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

describe("repository hygiene", () => {
  test("no local agent or session state is tracked", () => {
    const offenders = trackedFiles().filter((path) =>
      path.split("/").some((segment) => FORBIDDEN_TRACKED_DIRS.includes(segment)),
    );

    expect(offenders).toEqual([]);
  });

  test("no OS metadata files are tracked", () => {
    const offenders = trackedFiles().filter((path) =>
      FORBIDDEN_TRACKED_FILENAMES.includes(path.split("/").pop() ?? ""),
    );

    expect(offenders).toEqual([]);
  });

  /**
   * A file URL's `pathname` is not a filesystem path on Windows.
   *
   * Build a URL from `import.meta.url` to reach a module-relative file, take
   * its `pathname`, and a Windows runner hands back `/D:/a/repo/src`. The
   * leading slash in front of the drive letter belongs to the URL grammar, not
   * to the path, and every `fs` call on it fails with ENOENT. That form also
   * leaves percent-escapes undecoded, so a checkout directory with a space in
   * its name breaks on every platform. `fileURLToPath` settles both.
   *
   * None of it shows on Linux, where the two agree, so a module written and run
   * here arrives at the Windows job as an import-time crash that takes its whole
   * test file down with it. That is exactly how it happened once, and this guard
   * is red on any platform the moment the form comes back.
   *
   * The rule is stated in prose on purpose: spelling the offending call out here
   * would make this file its own first offender.
   */
  test("no source turns a file URL into a path with .pathname", async () => {
    const sourceExtensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"];
    const candidates = trackedFiles().filter((path) =>
      sourceExtensions.some((extension) => path.endsWith(extension)),
    );

    // Written with escapes throughout so this file can never match its own rule.
    const pattern = /new URL\((?:[^()]|\([^()]*\))*import\.meta\.url\s*\)\s*\.pathname/;

    const offenders: string[] = [];
    for (const path of candidates) {
      const text = await Bun.file(join(repoRoot, path)).text();
      if (pattern.test(text)) offenders.push(path);
    }

    expect(offenders).toEqual([]);
  });

  test("gitignore still declares the agent-state directories", async () => {
    const ignore = await Bun.file(new URL("../.gitignore", import.meta.url)).text();

    for (const dir of FORBIDDEN_TRACKED_DIRS) {
      expect(ignore).toContain(`${dir}/`);
    }
  });
});
