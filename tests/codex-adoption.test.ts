import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { adoptPreSubstrateHome, readAdoptionEvidence } from "../src/codex/adoption";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(): { root: string; db: string } {
  const root = mkdtempSync(join(process.env.TEMP ?? process.env.TMP ?? ".", "ocx-adoption-"));
  roots.push(root);
  const db = join(root, "integrations", "codex-coordination.sqlite");
  mkdirSync(join(root, "integrations"), { recursive: true });
  return { root, db };
}

describe("pre-substrate Codex home adoption", () => {
  test("routed residue publishes a versioned mode-0600 adoption-pending database", () => {
    const fx = fixture();
    const result = adoptPreSubstrateHome({ databasePath: fx.db, residue: "routed", intent: { kind: "retained-apply", operation: "apply-opencodex" } });
    expect(result.kind).toBe("adopted");
    expect(readAdoptionEvidence(fx.db)?.historyStatus).toBe("adoption-pending");
    expect(existsSync(`${fx.db}.adoption`)).toBe(false);
    if (process.platform !== "win32") expect(statSync(fx.db).mode & 0o777).toBe(0o600);
  });

  test.each(["indeterminate", "legacy"] as const)("refuses %s residue without creating authority", residue => {
    const fx = fixture();
    const result = adoptPreSubstrateHome({ databasePath: fx.db, residue, intent: { kind: "retained-apply", operation: "apply-opencodex" } });
    expect(result).toEqual({ kind: "refused", reason: residue === "legacy" ? "legacy-record" : "indeterminate-residue" });
    expect(existsSync(fx.db)).toBe(false);
  });

  test.each(["skip", "apply-opencodex", "migrate-openai"] as const)("accepts retained apply operation %s", operation => {
    const fx = fixture();
    expect(adoptPreSubstrateHome({ databasePath: fx.db, residue: "routed", intent: { kind: "retained-apply", operation } }).kind).toBe("adopted");
  });

  test("accepts retained restore as positive authority", () => {
    const fx = fixture();
    expect(adoptPreSubstrateHome({ databasePath: fx.db, residue: "routed", intent: { kind: "retained-restore", operation: "restore-openai" } }).kind).toBe("adopted");
  });

  test("does not adopt a pre-existing unversioned or rowless file", () => {
    const fx = fixture();
    writeFileSync(fx.db, "not a sqlite database");
    expect(adoptPreSubstrateHome({ databasePath: fx.db, residue: "routed", intent: { kind: "retained-apply", operation: "apply-opencodex" } })).toEqual({ kind: "refused", reason: "rowless-database" });
  });

  test("a second process sees the complete winner and cannot replace it", () => {
    const fx = fixture();
    const first = adoptPreSubstrateHome({ databasePath: fx.db, residue: "routed", intent: { kind: "retained-apply", operation: "apply-opencodex" } });
    const second = adoptPreSubstrateHome({ databasePath: fx.db, residue: "routed", intent: { kind: "retained-restore", operation: "restore-openai" } });
    expect(first.kind).toBe("adopted");
    expect(second).toEqual({ kind: "already-adopted", databasePath: fx.db });
    expect(readAdoptionEvidence(fx.db)?.historyOperation).toBe("apply-opencodex");
  });

  test("two child processes publish one winner without clobbering", async () => {
    const fx = fixture();
    const child = join(import.meta.dir, "helpers", "adoption-child.ts");
    const resultA = join(fx.root, "a.json");
    const resultB = join(fx.root, "b.json");
    const env = (resultPath: string) => ({ ...process.env, OCX_ADOPTION_DATABASE: fx.db, OCX_ADOPTION_RESULT: resultPath, OCX_ADOPTION_TEST_CHILD_RACE: "1" });
    const a = Bun.spawn([process.execPath, child], { env: env(resultA), stdout: "ignore", stderr: "ignore" });
    const b = Bun.spawn([process.execPath, child], { env: env(resultB), stdout: "ignore", stderr: "ignore" });
    await Promise.all([a.exited, b.exited]);
    const childResults = [JSON.parse(readFileSync(resultA, "utf8")), JSON.parse(readFileSync(resultB, "utf8"))];
    const outcomes = childResults.map(result => result.kind).sort();
    if (childResults.filter(result => result.kind === "refused" && result.reason === "publication-race").length !== 1) throw new Error(`unexpected child race result: ${JSON.stringify(childResults)}`);
    expect(outcomes).toEqual(["adopted", "refused"]);
    expect(readAdoptionEvidence(fx.db)?.historyStatus).toBe("adoption-pending");
  }, { timeout: 30_000 });

  test("a child crash after complete temp creation leaves no final authority", async () => {
    const fx = fixture();
    const child = join(import.meta.dir, "helpers", "adoption-child.ts");
    const resultPath = join(fx.root, "crash.json");
    const proc = Bun.spawn([process.execPath, child], {
      env: { ...process.env, OCX_ADOPTION_DATABASE: fx.db, OCX_ADOPTION_RESULT: resultPath, OCX_ADOPTION_TEST_CRASH_CHECKPOINT: "after-temp" },
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await proc.exited).toBe(97);
    expect(existsSync(fx.db)).toBe(false);
    const retry = adoptPreSubstrateHome({ databasePath: fx.db, residue: "routed", intent: { kind: "retained-apply", operation: "apply-opencodex" } });
    expect(retry.kind).toBe("adopted");
  }, { timeout: 30_000 });

  test("clean homes do not get a row", () => {
    const fx = fixture();
    expect(adoptPreSubstrateHome({ databasePath: fx.db, residue: "clean", intent: { kind: "retained-apply", operation: "skip" } })).toEqual({ kind: "refused", reason: "not-routed" });
  });
});
