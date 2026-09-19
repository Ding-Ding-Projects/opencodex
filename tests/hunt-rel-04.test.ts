/**
 * REL-04: the REL-03 repair pinned the PRODUCTION tar spawn but left the test fixture that BUILDS
 * the archives resolving `tar` through PATH, so the regression can come back through the back door.
 *
 * scripts/prepare-release-assets.ts now exports `resolveTarCommand()`, which returns the absolute
 * `%SystemRoot%\System32\tar.exe` on win32 so PATH order cannot decide which tar implementation
 * answers. `runTar()` uses it. tests/prepare-release-assets.test.ts, however, builds every fixture
 * archive by spawning a bare `"tar"`, and a bare command name is resolved against whatever PATH the
 * hosting process happens to have. On a Windows host whose PATH lists Git for Windows' `usr\bin`
 * ahead of System32 (Git Bash is the ordinary case), that bare name resolves to GNU tar, which
 * misreads an ordinary absolute path like `C:\Users\...\x.tgz` as `host:file` remote-archive syntax
 * and fails before it reads a single byte of the file.
 *
 * tests/hunt-rel-03.test.ts records the empirical result of that split: the same unmodified fixture
 * passes 13/13 from a System32-first PATH and fails 10/13 from a Git-Bash-first PATH. That test
 * cannot defend this, though: it is gated on win32 plus the presence of Git for Windows, so it skips
 * entirely everywhere else and gives no signal on the Linux hosts where most of this repository's
 * tests actually run.
 *
 * This guard closes that gap by reading the fixture's source instead of executing it, which is the
 * only way to get a verdict on a platform where `resolveTarCommand()` is a no-op. It is deliberately
 * a source check, not a behavioral one: off Windows both the pinned and unpinned spawns resolve to
 * the same binary and behave identically, so no amount of running the fixture here can tell the two
 * apart.
 */

import { describe, expect, test } from "bun:test";

const root = new URL("../", import.meta.url);
const fixturePath = "tests/prepare-release-assets.test.ts";

/**
 * The two fixture tests that shadow `tar` on PATH on purpose. They write an executable named `tar`
 * into a scratch directory and prepend it to the child's PATH so the helper's own child-deadline and
 * stdout-bound logic can be exercised against a stalling or flooding stand-in. PATH interception is
 * the entire point of those tests, so a bare tar name inside them is correct and must stay allowed.
 *
 * The exclusion is keyed on these exact titles rather than on a count of matches, because a count
 * cannot tell a deliberate bare `tar` from one that a later edit reintroduced into the archive
 * building path. The titles are asserted to still resolve below, so renaming or deleting one of
 * these tests fails here loudly instead of quietly widening the hole this guard is watching.
 */
const DELIBERATE_PATH_SHADOWING_TESTS = [
  "kills a stalled tar child at the configured test deadline",
  "kills a tar child whose metadata output exceeds the bound",
];

/**
 * Spawn-shaped uses of the bare literal `"tar"`: the first argument of a process launcher, either
 * directly or as the head of an argv array. This intentionally does not match every occurrence of
 * the string, because the fixture legitimately mentions `tar` in local variable names, in comments,
 * in archive member paths, and in expected stderr text. Only the shapes that actually hand a name to
 * the operating system for PATH resolution are a defect.
 */
const BARE_TAR_SPAWN = /\b(?:command|spawn|spawnSync|exec|execSync|execFile|execFileSync)\(\s*\[?\s*(["'])tar\1/g;

/** Start of a top-level or nested `test("...")` / `test.skipIf(...)("...")` declaration. */
const TEST_HEADER = /^[ \t]*test(?:\.\w+)?(?:\([^\n]*?\))?\(\s*(["'])((?:[^"'\\]|\\.)*)\1/gm;

type Block = { title: string; body: string };

/**
 * Split the fixture into the module-level prologue plus one region per test declaration. Slicing on
 * test headers is enough to make the exclusion precise here: a bare tar name is attributed to the
 * test whose body it sits in, and helper functions defined above the first test land in the
 * prologue, which is never excluded. That is exactly where `createArchive()` lives, so the archive
 * building path stays under the guard even though it is called from many tests.
 */
function splitIntoBlocks(source: string): Block[] {
  const headers = [...source.matchAll(TEST_HEADER)];
  const blocks: Block[] = [{
    title: "(module scope)",
    body: source.slice(0, headers[0]?.index ?? source.length),
  }];
  for (const [index, header] of headers.entries()) {
    blocks.push({
      title: header[2],
      body: source.slice(header.index!, headers[index + 1]?.index ?? source.length),
    });
  }
  return blocks;
}

async function readFixture(): Promise<string> {
  return await Bun.file(new URL(fixturePath, root)).text();
}

describe("REL-04: the release-asset fixture resolves tar the same way production does", () => {
  test("every fixture tar spawn outside the deliberate PATH-shadowing tests is pinned", async () => {
    const blocks = splitIntoBlocks(await readFixture());

    // Guard the guard. If either title drifts, the exclusion below would silently stop covering a
    // real test and start covering nothing, which is the failure mode that makes source scrapers
    // rot into green no-ops.
    for (const title of DELIBERATE_PATH_SHADOWING_TESTS) {
      expect(
        blocks.filter((block) => block.title === title),
        `${fixturePath} no longer has exactly one test titled "${title}". This guard excludes that `
        + `test by title because it shadows tar on PATH on purpose. Update the exclusion list here `
        + `deliberately rather than leaving it pointing at a test that no longer exists.`,
      ).toHaveLength(1);
    }

    const offenders = blocks
      .filter((block) => !DELIBERATE_PATH_SHADOWING_TESTS.includes(block.title))
      .flatMap((block) => [...block.body.matchAll(BARE_TAR_SPAWN)].map((match) => `${block.title}: ${match[0]}`));

    expect(
      offenders,
      `${fixturePath} must spawn tar through resolveTarCommand() from `
      + `scripts/prepare-release-assets.ts, never through a bare "tar" resolved against PATH. A bare `
      + `name lets Git for Windows' GNU tar answer ahead of System32's bsdtar, and GNU tar rejects `
      + `the Windows-absolute archive path the fixture builds. Found:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  test("the fixture imports the production tar resolver rather than reimplementing it", async () => {
    const source = await readFixture();

    // Naming the production export keeps the two paths genuinely in lockstep. A local copy of the
    // System32 lookup would pass the spawn check above while still being free to drift away from
    // whatever runTar() actually does.
    expect(source).toContain("resolveTarCommand");
    expect(source).toMatch(/import\s*\{[^}]*\bresolveTarCommand\b[^}]*\}\s*from\s*["']\.\.\/scripts\/prepare-release-assets["']/);
  });
});
