/**
 * DATA-02 (data-loss hunt, wave 1): `backupInvalidConfig()` in `src/config.ts`
 * names each backup only from a millisecond-resolution timestamp --
 * `${configPath}.invalid-${new Date().toISOString()...}` -- with no counter,
 * no random suffix and no existence check before `copyFileSync`. Node's
 * `copyFileSync` overwrites an existing destination by default, so two
 * corrupt-config events whose backups land in the same millisecond silently
 * destroy one another: the second call's `copyFileSync` clobbers the first
 * call's backup file with the second call's bytes.
 *
 * This function is the shared "we found a corrupt secrets/config file, keep
 * a copy before treating it as empty" path reused by
 * `authenticator-store.ts`, `src/oauth/store.ts` and
 * `src/codex/account-store.ts` -- every one of them loses evidence the same
 * way under the same condition, because they all call this one helper.
 *
 * A first attempt at this test drove `backupInvalidConfig` in a tight
 * 500-round loop hoping two rounds would land in the same wall-clock
 * millisecond; on this machine each round measured ~10ms (spawning no
 * process, but `copyFileSync` + `chmodSync` + ISO-string formatting still
 * cost more than the 1ms bucket), so no natural collision showed up in
 * 500 rounds / 5.3s. That rules out "trivially reproducible under any load"
 * on this hardware, but not the defect itself: the function's own filename
 * is a pure function of the wall clock, so any two calls that truly do land
 * in the same millisecond -- two request handlers hitting the same corrupt
 * file back-to-back on a faster machine, or a batch reconcile pass -- collide
 * by construction. This test freezes "now" to prove that construction is
 * broken, instead of racing the real clock.
 *
 * Expected RED now: the second call's backup path equals the first call's,
 * and the file at that path ends up holding the second corruption's bytes,
 * not the first's. Expected GREEN once the backup name also carries
 * something unique per call (pid + an incrementing sequence, exactly like
 * the temp-file naming `atomicWriteFile`/`writeSatelliteBackup` already use
 * elsewhere in this codebase) or the write refuses to clobber an existing
 * backup path.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupInvalidConfig } from "../src/config";
import { removeTempDir } from "./helpers/temp-dir";

let testDir: string;
const RealDate = Date;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "ocx-backup-collide-"));
});

afterEach(() => {
  globalThis.Date = RealDate;
  removeTempDir(testDir);
});

describe("DATA-02: backupInvalidConfig's timestamp-only name collides when two corruptions land in the same millisecond", () => {
  test("a second corrupt-config backup made in the same millisecond overwrites the first one's evidence", () => {
    const path = join(testDir, "config.json");

    // Freeze "now" to one fixed instant so backupInvalidConfig's ISO-millisecond
    // timestamp is identical across calls -- exactly the condition two corrupt-
    // config events landing within the same millisecond produce on real
    // hardware, without needing to win a wall-clock race in this test run.
    const frozenMs = new RealDate("2026-01-01T00:00:00.000Z").getTime();
    class FrozenDate extends RealDate {
      constructor(...args: ConstructorParameters<typeof RealDate>) {
        if (args.length === 0) super(frozenMs);
        else super(...(args as []));
      }
      static override now(): number { return frozenMs; }
    }
    // @ts-expect-error -- test-only global clock override, restored in afterEach
    globalThis.Date = FrozenDate;

    writeFileSync(path, "not valid json #1 (first corruption)", "utf8");
    const firstBackup = backupInvalidConfig(path);
    expect(firstBackup).not.toBeNull();
    const firstBackupContent = readFileSync(firstBackup!, "utf8");
    expect(firstBackupContent).toBe("not valid json #1 (first corruption)");

    writeFileSync(path, "not valid json #2 (second, unrelated corruption)", "utf8");
    const secondBackup = backupInvalidConfig(path);

    // Desired behavior: a second corruption event must get its own backup path,
    // distinct from the first, so both pieces of forensic evidence survive.
    // Currently RED: backupInvalidConfig names backups from nothing but a
    // millisecond timestamp, so the same frozen instant produces the exact
    // same path both times.
    expect(secondBackup).not.toBeNull();
    expect(secondBackup).not.toBe(firstBackup);

    // And whatever path the first backup lives at must still hold the first
    // corruption's bytes. Currently RED: copyFileSync has no exclusivity flag
    // here, so the second call silently overwrote the first call's evidence.
    const survivingContent = readFileSync(firstBackup!, "utf8");
    expect(survivingContent).toBe(firstBackupContent);
  });
});
