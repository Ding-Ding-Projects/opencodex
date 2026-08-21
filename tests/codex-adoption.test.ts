import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
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

  test("clean homes do not get a row", () => {
    const fx = fixture();
    expect(adoptPreSubstrateHome({ databasePath: fx.db, residue: "clean", intent: { kind: "retained-apply", operation: "skip" } })).toEqual({ kind: "refused", reason: "not-routed" });
  });
});
