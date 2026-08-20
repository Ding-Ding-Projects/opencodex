import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "..", "src", "cli", "index.ts"), "utf8");

function handleSource(name: string, next: string): string {
  const start = source.indexOf(`async function ${name}(`);
  const end = source.indexOf(`async function ${next}(`, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("startup journal ownership ordering", () => {
  test("start uses the shared owner preflight before async journal recovery", () => {
    const helperStart = source.indexOf("async function findProxyOwnerBeforeJournalRecovery(");
    const helperEnd = source.indexOf("async function handleStart(", helperStart);
    const handleStart = handleSource("handleStart", "handleEnsure");
    const owner = handleStart.indexOf("findProxyOwnerBeforeJournalRecovery()");
    const recovery = source.indexOf("await reconcileJournalAsync();");
    const updatePrompt = handleStart.indexOf("await maybeShowUpdatePrompt();");

    expect(helperStart).toBeGreaterThanOrEqual(0);
    expect(helperEnd).toBeGreaterThan(helperStart);
    expect(source.slice(helperStart, helperEnd)).toContain("removePidIfValueIs(pidSnapshot)");
    expect(owner).toBeGreaterThanOrEqual(0);
    expect(recovery).toBeGreaterThanOrEqual(0);
    expect(updatePrompt).toBeGreaterThan(owner);
  });

  test("ensure asks the shared preflight to probe the configured port", () => {
    const handleEnsure = handleSource("handleEnsure", "handleTrayProxyStart");
    expect(handleEnsure).toContain("findProxyOwnerBeforeJournalRecovery({ probeConfiguredPort: true })");
    expect(handleEnsure).toContain("const live = owner.live;");
    expect(handleEnsure).not.toContain("reconcileJournal();");
  });
});
