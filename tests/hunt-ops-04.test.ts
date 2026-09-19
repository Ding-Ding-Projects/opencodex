/**
 * Regression coverage for the crash-guard gap in `ocx ensure`.
 *
 * tests/hunt-ops-03.test.ts proved the same property for `ocx start`, which was
 * then fixed. `ocx ensure` runs the identical journal-recovery call
 * (findProxyOwnerBeforeJournalRecovery, which may call reconcileJournalAsync,
 * which restores config.toml through atomicWriteFileAsync, whose Windows harden
 * step genuinely throws on a real ACL denial) and was left bare.
 *
 * Ensure is short lived, which makes it look like it does not need the guards.
 * It needs them more than start does. installCrashGuards() has exactly one call
 * site in the whole codebase, inside handleStart, so nothing installs the
 * handlers for an ensure run. And the Codex shim invokes `ocx ensure` on every
 * codex invocation with both streams discarded (src/codex/shim.ts, in the sh,
 * cmd and PowerShell variants alike), so a genuine failure there produces no
 * stderr a human ever sees, no crash.log entry, and a swallowed exit code. The
 * fault leaves no evidence anywhere.
 *
 * This is a static source check, in the style of hunt-ops-03 and
 * tests/cli-start-journal-order.test.ts, proving the ordering directly against
 * the shipped source text. hunt-ops-03 already proves the underlying throw is
 * real rather than theoretical by forcing a genuine ACL denial through
 * reconcileJournalAsync, so that part is not repeated here.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
      // the call, so keep looking at the next "try {" candidate.
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

/**
 * Slice one function body out of the source by brace matching, from the
 * function's own opening brace to its own matching close.
 *
 * Deliberately NOT "slice from this function's name to the next function's
 * name": indexOf returns -1 for a marker that was renamed or reordered, and a
 * slice taken against that -1 silently yields something that is not the
 * function at all, so an assertion against it passes while proving nothing.
 * Brace matching is order independent and survives any rename or reorder of
 * the functions around it.
 */
function functionBody(source: string, signaturePrefix: string): string {
  const startIdx = source.indexOf(signaturePrefix);
  expect(startIdx).toBeGreaterThanOrEqual(0);

  // Find the parameter list first, then the body brace after it, so a
  // destructured or object-typed parameter (as handleStart has) cannot be
  // mistaken for the start of the body.
  const parenIdx = source.indexOf("(", startIdx);
  expect(parenIdx).toBeGreaterThan(startIdx);
  let parenDepth = 0;
  let paramsEnd = -1;
  for (let i = parenIdx; i < source.length; i++) {
    if (source[i] === "(") parenDepth++;
    else if (source[i] === ")") {
      parenDepth--;
      if (parenDepth === 0) { paramsEnd = i; break; }
    }
  }
  expect(paramsEnd).toBeGreaterThan(parenIdx);

  const bodyBraceIdx = source.indexOf("{", paramsEnd);
  expect(bodyBraceIdx).toBeGreaterThan(paramsEnd);
  const endIdx = matchingBraceEnd(source, bodyBraceIdx);
  expect(endIdx).toBeGreaterThan(bodyBraceIdx);

  const body = source.slice(startIdx, endIdx);
  // Overshooting the real close brace would swallow whatever follows, so prove
  // the slice stops before the next function declaration begins.
  expect(body.trimEnd().endsWith("}")).toBe(true);
  expect(body.indexOf("async function ", 1)).toBe(-1);
  return body;
}

describe("ensure journal recovery is covered by the crash guards (source order)", () => {
  test("installCrashGuards() runs before handleEnsure's journal-recovery call, or that call is wrapped and routed to the crash logger", () => {
    const body = functionBody(cliSource, "async function handleEnsure(");

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

  test("a bare 'does the body contain a try block' check cannot decide this, so the enclosing check is the one that counts", () => {
    // handleEnsure carries its own unrelated try blocks for the two Grok fence
    // refreshes, and both of them sit after the journal-recovery call. A naive
    // containment check therefore reports success no matter what wraps the
    // recovery call, which is why the assertion above brace matches the
    // enclosing try instead. This holds before and after the fix: the Grok
    // try blocks stay where they are either way.
    const body = functionBody(cliSource, "async function handleEnsure(");
    const journalCallIdx = body.indexOf("findProxyOwnerBeforeJournalRecovery(");
    expect(journalCallIdx).toBeGreaterThanOrEqual(0);
    expect(body).toContain("try {");

    const nonEnclosing: number[] = [];
    let searchFrom = 0;
    for (;;) {
      const tryIdx = body.indexOf("try {", searchFrom);
      if (tryIdx === -1) break;
      searchFrom = tryIdx + 1;
      const closeIdx = matchingBraceEnd(body, tryIdx + "try ".length);
      if (tryIdx > journalCallIdx || closeIdx === -1 || closeIdx <= journalCallIdx) nonEnclosing.push(tryIdx);
    }
    expect(nonEnclosing.length).toBeGreaterThan(0);
  });

  test("ensure and start report their recovery failures under distinct crash-log kinds", () => {
    // Both commands make the same call for different reasons, and both can fail
    // for the same underlying reason. If they logged under one kind, a crash.log
    // entry could no longer be attributed to the command that produced it, which
    // matters most for ensure because the shim leaves no other trace of it.
    const kindOf = (body: string): string | null => {
      const match = /logStartupFailure\(\s*"([^"]+)"/.exec(body);
      return match ? match[1] : null;
    };
    const ensureKind = kindOf(functionBody(cliSource, "async function handleEnsure("));
    const startKind = kindOf(functionBody(cliSource, "async function handleStart("));

    expect(startKind).toBeTruthy();
    expect(ensureKind).toBeTruthy();
    expect(ensureKind).not.toBe(startKind);
  });
});
