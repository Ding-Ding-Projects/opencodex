/**
 * Deleting the logs, and getting them back.
 *
 * Every test here names the defect it exists to prevent. They are all failures
 * that look like success from the outside — a delete that quietly lost its undo,
 * a "restore" that destroyed the state it replaced, a history write that took a
 * user's clear down with it — which is precisely why they need a test rather
 * than a careful read of the code.
 *
 * These drive real `git` in a temp directory. That is deliberate: the whole
 * feature is "the bytes are in a commit before they are unlinked", and a mocked
 * git would assert that we called the right function rather than that the bytes
 * survived.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAppLogLine, appLogPath, listAppLogFiles } from "../src/lib/app-log-file";
import {
  clearPersistedLogs,
  describeLogClear,
  measurePersistedLogs,
  restorePersistedLogs,
} from "../src/lib/log-store";
import { listStateHistoryEntries, recordStateSnapshot } from "../src/lib/state-history";
import { usageLogPath } from "../src/usage/log";
import { removeTempDir } from "./helpers/temp-dir";

let dir = "";
let previousHome: string | undefined;

/** One usage.jsonl row. `requestId` is the stable identity every reader keys on. */
function usageRow(requestId: string): string {
  return `${JSON.stringify({
    requestId,
    timestamp: 1,
    provider: "openai",
    model: "gpt-5.5",
    status: 200,
    durationMs: 12,
    usageStatus: "reported",
    usage: { inputTokens: 3, outputTokens: 4 },
    totalTokens: 7,
  })}\n`;
}

function seedLogs(rows: string[], lines: string[]): void {
  if (rows.length) writeFileSync(usageLogPath(dir), rows.map(usageRow).join(""), "utf-8");
  for (const line of lines) appendAppLogLine(line, dir);
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  dir = mkdtempSync(join(tmpdir(), "ocx-logstore-"));
  // log-store and state-history both resolve the config dir from the environment
  // when not handed one; keeping them agreed rules out a test that passes because
  // it deleted a different directory than it snapshotted.
  process.env.OPENCODEX_HOME = dir;
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (dir) removeTempDir(dir);
});

describe("clearing the logs", () => {
  /**
   * The defect: a delete with no revision behind it. Post-hoc commits record the
   * absence, not the content, so recovery depends on some earlier snapshot
   * happening to hold the rows — which is never true of the first clear a machine
   * performs, the exact case the user is in when they discover it.
   */
  test("a delete commits the logs before unlinking them", async () => {
    seedLogs(["req-a", "req-b"], ["boot: listening on 4141"]);
    const before = readFileSync(usageLogPath(dir), "utf-8");

    const result = await clearPersistedLogs({ configDir: dir });

    expect(result.ok).toBe(true);
    expect(result.snapshot).toBe(true);
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(usageLogPath(dir))).toBe(false);
    expect(listAppLogFiles(dir)).toEqual([]);

    // The revision is not merely present — it holds the bytes that were deleted.
    const history = listStateHistoryEntries(50, dir);
    const commit = history.find(entry => entry.hash === result.commit);
    expect(commit).toBeDefined();
    expect(commit!.scope).toBe("logs");

    const restored = await restorePersistedLogs(result.commit!, { configDir: dir });
    expect(restored.ok).toBe(true);
    expect(readFileSync(usageLogPath(dir), "utf-8")).toBe(before);
  });

  /**
   * The defect: "Updated". A history whose rows all say the same thing is a list
   * nobody can navigate, and the counts are the only way a user picks the clear
   * that took the rows they want back rather than a later one.
   */
  test("the revision label names what was cleared, with counts", async () => {
    seedLogs(["req-a", "req-b", "req-c"], ["one", "two"]);

    const result = await clearPersistedLogs({ configDir: dir });

    expect(result.label).toBe("cleared 3 request log rows and 2 app log lines");
    expect(listStateHistoryEntries(50, dir)[0].subject).toBe(result.label);
  });

  /** Singular counts read as counts, not as a template someone forgot to finish. */
  test("a single row and a single line are described in the singular", () => {
    expect(describeLogClear({ requestRows: 1, appLines: 1, bytes: 0 }))
      .toBe("cleared 1 request log row and 1 app log line");
  });

  /**
   * The defect: recording an event that did not happen. An unchanged state must
   * write nothing, or the panel fills with rows for clears that cleared nothing
   * and the real ones become impossible to find.
   */
  test("clearing an already-empty log records no revision", async () => {
    const result = await clearPersistedLogs({ configDir: dir });

    expect(result.ok).toBe(true);
    expect(result.snapshot).toBe(false);
    expect(result.commit).toBeNull();
    expect(listStateHistoryEntries(50, dir)).toEqual([]);
  });

  /**
   * The defect: bookkeeping outranking the user. If a locked index or a missing
   * git could fail the delete, the app would refuse to do what it was asked
   * because of a repository the user never opted into — and would keep refusing
   * until they found and fixed it.
   */
  test("a failed history write does not fail the delete", async () => {
    seedLogs(["req-a"], ["boot"]);

    const result = await clearPersistedLogs({
      configDir: dir,
      snapshot: () => Promise.reject(new Error("git index.lock exists")),
    });

    expect(result.ok).toBe(true);
    // Reported honestly rather than hidden: this clear genuinely cannot be undone.
    expect(result.snapshot).toBe(false);
    expect(result.commit).toBeNull();
    expect(existsSync(usageLogPath(dir))).toBe(false);
    expect(listAppLogFiles(dir)).toEqual([]);
  });

  /** A snapshot that returns "nothing committed" is the same story without the throw. */
  test("a history write that commits nothing still lets the delete through", async () => {
    seedLogs(["req-a"], []);

    const result = await clearPersistedLogs({ configDir: dir, snapshot: () => Promise.resolve(null) });

    expect(result.ok).toBe(true);
    expect(result.snapshot).toBe(false);
    expect(existsSync(usageLogPath(dir))).toBe(false);
  });

  /**
   * The defect: a stale dashboard. The in-memory rings are what /api/logs serves,
   * so a clear that does not re-seed them leaves the deleted rows on screen and
   * the user concludes the button is broken.
   */
  test("the caller's reload hook runs after the files are gone", async () => {
    seedLogs(["req-a"], ["boot"]);
    let usageAtReload: boolean | null = null;

    await clearPersistedLogs({
      configDir: dir,
      reload: () => { usageAtReload = existsSync(usageLogPath(dir)); },
    });

    expect(usageAtReload).toBe(false);
  });
});

describe("restoring the logs", () => {
  /**
   * The defect that makes a history panel unsafe to use: a restore that rewinds.
   * If putting a revision back discarded the branch it replaced, a user could not
   * look at an old state without risking the one they started from — so nobody
   * would ever press the button, and the whole feature would be decoration.
   */
  test("restoring appends a revision rather than rewriting history", async () => {
    seedLogs(["req-a"], ["first boot"]);
    const cleared = await clearPersistedLogs({ configDir: dir });
    expect(cleared.commit).not.toBeNull();

    // New logs written after the clear. These are what a rewinding restore would
    // silently destroy, so the test can tell the two behaviours apart.
    seedLogs(["req-b"], ["second boot"]);
    const beforeRestore = listStateHistoryEntries(200, dir);

    const restored = await restorePersistedLogs(cleared.commit!, { configDir: dir });
    expect(restored.ok).toBe(true);

    const afterRestore = listStateHistoryEntries(200, dir);
    // Two new commits: the state as it stood, then the restore itself.
    expect(afterRestore.length).toBeGreaterThan(beforeRestore.length);
    // Nothing was dropped or rewritten — every earlier hash is still reachable.
    for (const entry of beforeRestore) {
      expect(afterRestore.some(later => later.hash === entry.hash)).toBe(true);
    }
    expect(restored.snapshotBefore).toBe(true);
  });

  /**
   * The consequence of append-only, stated as a round trip: an undo can be
   * undone, and that undo undone in turn. If this ever fails, experimenting in
   * the panel costs the user their current state.
   */
  test("an undo can itself be undone", async () => {
    seedLogs(["req-original"], []);
    const cleared = await clearPersistedLogs({ configDir: dir });

    // A different world: the logs now hold something else entirely.
    seedLogs(["req-replacement"], []);
    const beforeUndo = listStateHistoryEntries(200, dir);

    // Undo the clear — the original rows come back.
    await restorePersistedLogs(cleared.commit!, { configDir: dir });
    expect(readFileSync(usageLogPath(dir), "utf-8")).toContain("req-original");

    // The commit made just before that restore holds the replacement world, so
    // undoing the undo is simply another restore.
    const undoCommit = listStateHistoryEntries(200, dir)
      .find(entry => !beforeUndo.some(earlier => earlier.hash === entry.hash)
        && entry.subject.startsWith("before restore:"));
    expect(undoCommit).toBeDefined();

    await restorePersistedLogs(undoCommit!.hash, { configDir: dir });
    expect(readFileSync(usageLogPath(dir), "utf-8")).toContain("req-replacement");
  });

  /**
   * The defect this mirrors is the AAD-bound-to-a-row-id one: when an identity is
   * derived from a record's POSITION rather than its content, a restored record
   * gets a fresh position, the binding stops matching, and the data becomes
   * permanently unreadable while failing in a way indistinguishable from
   * corruption.
   *
   * Here the identity is `requestId`, which is carried inside each row. This
   * proves it survives a delete-then-restore round trip byte-for-byte even when
   * the rows land at different offsets than they occupied before — so anything
   * bound to it (today a lookup, tomorrow an authenticated-encryption AAD) still
   * verifies against the restored bytes.
   */
  test("the stable row identity survives a delete-then-restore round trip", async () => {
    seedLogs(["req-alpha", "req-beta"], []);
    const originalBytes = readFileSync(usageLogPath(dir), "utf-8");
    const cleared = await clearPersistedLogs({ configDir: dir });

    // Rewrite the file with a DIFFERENT number of leading rows, so a restore that
    // renumbered or re-keyed by position would produce different bytes than the
    // snapshot held.
    seedLogs(["req-x", "req-y", "req-z"], []);

    const restored = await restorePersistedLogs(cleared.commit!, { configDir: dir });
    expect(restored.ok).toBe(true);

    const roundTripped = readFileSync(usageLogPath(dir), "utf-8");
    expect(roundTripped).toBe(originalBytes);
    // Spelled out rather than left to the byte comparison: the ids are the same
    // ids, in the same order, and none was rewritten to match a new offset.
    const ids = roundTripped.trim().split("\n").map(line => JSON.parse(line).requestId as string);
    expect(ids).toEqual(["req-alpha", "req-beta"]);
  });

  /**
   * The defect, and it was a live one: git's Windows default
   * (`core.autocrlf=true`) rewrote LF to CRLF on checkout, so every restored
   * file came back with different bytes than were committed. For a JSONL log
   * that is merely wrong. For anything encrypted it is unrecoverable — the
   * ciphertext no longer decrypts, and it fails in a way indistinguishable from
   * corruption, in the one code path whose entire job is making data recoverable.
   *
   * The fix is a `.gitattributes` carrying `* -text`, which outranks whatever the
   * user has in their global git config.
   */
  test("restored bytes are identical, line endings and all", async () => {
    // Mixed endings and a trailing byte with no newline: precisely what a
    // content filter would silently normalise on the way out.
    const exact = "alpha\r\nbeta\ngamma\r\ndelta";
    writeFileSync(usageLogPath(dir), exact, "utf-8");

    const cleared = await clearPersistedLogs({ configDir: dir });
    expect(cleared.commit).not.toBeNull();
    writeFileSync(usageLogPath(dir), "something else entirely\n", "utf-8");

    await restorePersistedLogs(cleared.commit!, { configDir: dir });

    expect(readFileSync(usageLogPath(dir), "utf-8")).toBe(exact);
  });

  /**
   * The defect: a "restore" that deletes. Log files written after the chosen
   * revision are absent from it, and removing them to make the directory match
   * would destroy data in the name of recovering it. They are kept, and reported
   * so the user is not left assuming the directory matches the snapshot.
   */
  test("log files added since the revision are kept and reported", async () => {
    seedLogs(["req-a"], ["boot"]);
    const cleared = await clearPersistedLogs({ configDir: dir });

    // A generation that did not exist when the snapshot was taken.
    writeFileSync(join(dir, "logs", "opencodex.log.2"), "2026-01-01T00:00:00.000Z later\n", "utf-8");

    const restored = await restorePersistedLogs(cleared.commit!, { configDir: dir });

    expect(restored.ok).toBe(true);
    expect(restored.kept).toContain("logs/opencodex.log.2");
    expect(existsSync(join(dir, "logs", "opencodex.log.2"))).toBe(true);
  });

  /** A hash that is not a hash never reaches git, and never reaches a checkout. */
  test("a non-hash commit reference is refused without touching disk", async () => {
    seedLogs(["req-a"], []);
    await clearPersistedLogs({ configDir: dir });
    seedLogs(["req-b"], []);

    const result = await restorePersistedLogs("HEAD~1", { configDir: dir });

    expect(result.ok).toBe(false);
    expect(result.touchedDisk).toBe(false);
    expect(readFileSync(usageLogPath(dir), "utf-8")).toContain("req-b");
  });
});

describe("the shared timeline", () => {
  /**
   * The defect: aiming a restore by parsing a commit subject. The dashboard
   * picks between two endpoints with very different consequences — one restarts
   * the proxy, one does not — and the earlier version of this module explicitly
   * rejected scraping display strings for exactly that reason. The scope is
   * derived from the commit's changed files, so this proves the `--name-only`
   * parse tells the two kinds apart on real git output.
   */
  test("log and state snapshots share one history and report their own scope", async () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ port: 10100 }), "utf-8");
    await recordStateSnapshot("added an account", dir);
    seedLogs(["req-a"], ["boot"]);
    const cleared = await clearPersistedLogs({ configDir: dir });

    const history = listStateHistoryEntries(50, dir);
    // Both live on the same timeline, newest first.
    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(history.find(entry => entry.hash === cleared.commit)?.scope).toBe("logs");
    expect(history.find(entry => entry.subject === "added an account")?.scope).toBe("state");

    // And they are genuinely independent: clearing the logs left config.json alone.
    expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf-8"))).toEqual({ port: 10100 });
  });
});

describe("measuring what a clear would destroy", () => {
  /**
   * The defect: a confirmation that asks the user to agree to an unspecified
   * amount of loss. The dialog quotes these numbers, so they have to be the real
   * ones rather than whatever the in-memory ring happens to hold.
   */
  test("the footprint counts both files", () => {
    seedLogs(["req-a", "req-b"], ["one", "two", "three"]);

    const footprint = measurePersistedLogs(dir);

    expect(footprint.requestRows).toBe(2);
    expect(footprint.appLines).toBe(3);
    expect(footprint.bytes).toBeGreaterThan(0);
    expect(existsSync(appLogPath(dir))).toBe(true);
  });
});
