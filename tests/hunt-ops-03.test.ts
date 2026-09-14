/**
 * Regression coverage for a startup crash-guard gap.
 *
 * `ocx start` recovers a stale Codex journal (findProxyOwnerBeforeJournalRecovery,
 * which may call reconcileJournalAsync) before installCrashGuards() runs and
 * before any try/catch wraps that call. The top-level command switch has no
 * wrapper of its own, so a genuine failure during recovery (for example a real
 * Windows ACL denial while restoring config.toml) used to reach the launcher as
 * a raw, unredacted stack instead of a clean, logged failure exit.
 *
 * Part (a) is a static source check, in the style of
 * tests/cli-start-journal-order.test.ts, proving the ordering directly against
 * the shipped source text.
 *
 * Part (b) proves the underlying throw is real rather than theoretical: it
 * forces a genuine (non-timeout) ACL denial through the same injected test
 * seam tests/windows-secret-acl.test.ts already uses, and shows
 * reconcileJournalAsync() rejects instead of swallowing the failure. This part
 * documents existing, correct behaviour of the lower layer; the gap this file
 * is about is purely what (if anything) wraps that call in the CLI.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { CODEX_CONFIG_PATH, CODEX_PROFILE_PATH } from "../src/codex/paths";
import { JOURNAL_PATH, reconcileJournalAsync } from "../src/codex/journal";
import { resetHardenedStateForTests, setAsyncIcaclsRunnerForTests } from "../src/lib/windows-secret-acl";

const cliPath = resolve(import.meta.dir, "../src/cli/index.ts");
const cliSource = readFileSync(cliPath, "utf8");

/**
 * Find the brace-matched end of the block opened by the "{" at openBraceIdx
 * (openBraceIdx must point at that character). Returns the index just past
 * the matching "}", or -1 if the braces never balance before the end of text.
 */
function matchingBraceEnd(text: string, openBraceIdx: number): number {
  let depth = 0;
  for (let i = openBraceIdx; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * Locate the try { ... } catch (...) { ... } that encloses callIdx in body,
 * if one exists. Returns the full [start, end) text range of that
 * try/catch construct (so the catch body can be inspected too), or null when
 * no try block that actually encloses callIdx exists.
 */
function enclosingTryCatchRange(body: string, callIdx: number): { start: number; end: number } | null {
  let searchFrom = 0;
  for (;;) {
    const tryIdx = body.indexOf("try {", searchFrom);
    if (tryIdx === -1 || tryIdx > callIdx) return null;
    const tryBraceOpen = tryIdx + "try ".length;
    const tryCloseIdx = matchingBraceEnd(body, tryBraceOpen);
    if (tryCloseIdx === -1 || tryCloseIdx <= callIdx) {
      // Either malformed, or this try block already closed before reaching
      // the call — keep looking at the next "try {" candidate.
      searchFrom = tryIdx + 1;
      continue;
    }
    let end = tryCloseIdx;
    const catchMatch = /^\s*catch\s*\([^)]*\)\s*\{/.exec(body.slice(end));
    if (catchMatch) {
      const catchBraceOpen = end + catchMatch[0].length - 1;
      const catchCloseIdx = matchingBraceEnd(body, catchBraceOpen);
      if (catchCloseIdx !== -1) end = catchCloseIdx;
    }
    return { start: tryIdx, end };
  }
}

describe("startup journal recovery is covered by the crash guards (source order)", () => {
  test("installCrashGuards() runs before handleStart's journal-recovery call, or that call is wrapped and routed to the crash logger", () => {
    const startIdx = cliSource.indexOf("async function handleStart(");
    const endIdx = cliSource.indexOf("async function handleEnsure(", startIdx);
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(endIdx).toBeGreaterThan(startIdx);
    const body = cliSource.slice(startIdx, endIdx);

    const journalCallIdx = body.indexOf("findProxyOwnerBeforeJournalRecovery(");
    expect(journalCallIdx).toBeGreaterThanOrEqual(0);

    const guardsIdx = body.indexOf("installCrashGuards();");
    const guardsInstalledFirst = guardsIdx >= 0 && guardsIdx < journalCallIdx;

    const wrap = enclosingTryCatchRange(body, journalCallIdx);
    const wrappedText = wrap ? body.slice(wrap.start, wrap.end) : "";
    const wrappedAndLogged = wrap !== null
      && /}\s*catch\s*\([^)]*\)\s*\{/.test(wrappedText)
      && /crash/i.test(wrappedText);

    expect(guardsInstalledFirst || wrappedAndLogged).toBe(true);
  });
});

describe("reconcileJournalAsync surfaces a genuine ACL failure instead of swallowing it", () => {
  afterEach(() => {
    setAsyncIcaclsRunnerForTests(null);
    resetHardenedStateForTests();
    rmSync(JOURNAL_PATH, { force: true });
    rmSync(CODEX_CONFIG_PATH, { force: true });
    rmSync(CODEX_PROFILE_PATH, { force: true });
  });

  test("a genuine non-timeout icacls denial during journal restore rejects (documents current behaviour)", async () => {
    if (process.platform !== "win32") return; // the ACL harden path this exercises is Windows-only

    const original = '# original config\nmodel_provider = "openai"\n';
    const injected = '# injected config\nmodel_provider = "opencodex"\n';
    writeFileSync(CODEX_CONFIG_PATH, injected, "utf8");
    if (existsSync(CODEX_PROFILE_PATH)) rmSync(CODEX_PROFILE_PATH, { force: true });
    writeFileSync(JOURNAL_PATH, JSON.stringify({
      version: 1,
      originalConfig: Buffer.from(original).toString("base64"),
      originalProfile: null,
      pid: 999_999, // not a live process, so the journal is eligible for recovery
      timestamp: new Date().toISOString(),
    }), "utf8");

    // A genuine access-denied icacls result (exitCode 5, timedOut: false) is
    // exactly the non-timeout failure atomicWriteFileAsync's default harden
    // step re-throws as EICACLS: src/lib/windows-secret-acl.ts throws whenever
    // a required harden fails for any reason other than a timeout.
    setAsyncIcaclsRunnerForTests(async () => ({ success: false, exitCode: 5, timedOut: false, stdout: "" }));

    await expect(reconcileJournalAsync()).rejects.toThrow(/EICACLS/);
  });
});
