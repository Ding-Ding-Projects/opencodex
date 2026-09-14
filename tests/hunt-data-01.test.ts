/**
 * DATA-01 (data-loss hunt, wave 1): `os-credential-vault.ts`'s `writeSecretsFile()`
 * calls `writeFileSync(secretsFilePath(), JSON.stringify(file, null, 2), "utf8")`
 * straight onto `schedule-secrets.json` -- no temp file, no
 * `atomicWriteFile`/`renameAtomicFile`, no fsync. `writeFileSync`'s default "w"
 * flag truncates the destination at open() time, before a single new byte
 * lands, so a crash, a transient Windows EPERM/EBUSY (antivirus, indexer,
 * OneDrive holding the file open) or a full disk between open() and close()
 * leaves the file short of a complete, parseable JSON document.
 *
 * `readSecretsFile()` already treats that exact state ("corrupt JSON") as "no
 * secrets configured" -- see the existing "corrupt storage fails closed" test
 * in tests/os-credential-vault.test.ts, which proves the READ side fails
 * closed safely. What that test does not cover is the WRITE side: an ordinary
 * interrupted write to add or update ONE token can reach that exact state by
 * itself and silently erase every token stored before it, not merely fail to
 * add the new one.
 *
 * Its sibling secret store, `authenticator-store.ts`, persists
 * `authenticator.json` through exactly the helper this file skips --
 * `atomicWriteFile()` from `src/config.ts` (private temp file, fsync, a
 * Windows-aware retrying rename via `renameAtomicFile()`, then a directory
 * fsync) -- specifically so a crash mid-write corrupts only a throwaway temp
 * file and never the last-good secrets file. `os-credential-vault.ts` is the
 * one secret store in this codebase that does not follow its own established
 * pattern.
 *
 * A first attempt at this test drove the real write path end to end by
 * mocking `node:fs` (`mock.module`) to interrupt one targeted `writeFileSync`
 * call after a partial write, matching the pattern this codebase already uses
 * for `node:dns/promises` in tests/destination-policy-resolved.test.ts. That
 * run hung indefinitely with no output at all (not even bun's startup banner),
 * most likely because the same file's own `import * as realFs from "node:fs"`
 * namespace binding was itself redirected by the mock, so the fallback branch
 * calling "the real writeFileSync" recursed into the mock instead. Reproducing
 * that safely would need a full subprocess harness, which is out of proportion
 * for a wave-1 finder; this test instead proves the same defect the way this
 * repository's own finder brief names as sufficient -- a scan that fails while
 * the unsafe call exists and passes once the file is fixed to use the shared
 * helper, exactly like its sibling store already does.
 *
 * Expected RED now: `os-credential-vault.ts` contains no call to
 * `atomicWriteFile(`/`renameAtomicFile(`. Expected GREEN once its write path
 * is switched to the shared helper (or an equivalent temp-then-rename with a
 * unique temp name and a bounded retry of transient Windows codes).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE_PATH = join(import.meta.dir, "..", "src", "lib", "os-credential-vault.ts");

describe("DATA-01: schedule-secrets.json is written straight to its destination, not through the codebase's atomic-write helper", () => {
  test("writeSecretsFile() must route through atomicWriteFile()/renameAtomicFile(), like authenticator-store.ts's persist() already does for authenticator.json", () => {
    const source = readFileSync(SOURCE_PATH, "utf8");

    // Sanity: this is genuinely the module under test, and it genuinely still
    // writes the secrets file directly -- if either goes false the file moved
    // or was already fixed, and this scan needs to be re-pointed, not "fixed"
    // by loosening the assertion below.
    expect(source).toContain("function writeSecretsFile(");
    expect(source).toContain("secretsFilePath()");

    const usesSharedAtomicHelper = /\batomicWriteFile\s*\(|\brenameAtomicFile\s*\(/.test(source);

    expect(
      usesSharedAtomicHelper,
      "os-credential-vault.ts's writeSecretsFile() calls writeFileSync(secretsFilePath(), ...) " +
      "directly on the final destination, with no temp file and no rename. A crash, a transient " +
      "Windows EPERM/EBUSY (antivirus/indexer/OneDrive holding schedule-secrets.json open) or a " +
      "full disk mid-write leaves the file truncated or partial; readSecretsFile() already treats " +
      "that as 'no secrets configured' (see the existing 'corrupt storage fails closed' test in " +
      "tests/os-credential-vault.test.ts), so an interrupted write to add or change ONE scheduled-" +
      "task Home Assistant token silently discards every token stored before it.",
    ).toBe(true);
  });
});
