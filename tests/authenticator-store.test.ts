/**
 * The authenticator's on-disk store: entries persist correctly, secrets
 * round-trip byte-for-byte, deletes and bulk operations touch exactly what
 * they say, and — the property this file exists to prove — the store never
 * writes to `config.json` or `auth.json`, so it can never be swept into a
 * version-history commit (see the file header on `authenticator-store.ts`).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addAuthenticatorEntry,
  addAuthenticatorGroup,
  bulkSetGroup,
  getAuthenticatorEntry,
  getAuthenticatorStorePath,
  loadAuthenticatorEntries,
  loadAuthenticatorGroups,
  removeAuthenticatorEntries,
  removeAuthenticatorEntry,
  removeAuthenticatorGroup,
  toEntryMeta,
  updateAuthenticatorEntry,
  updateAuthenticatorGroup,
} from "../src/lib/authenticator-store";
import { removeTempDir } from "./helpers/temp-dir";

let dir = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  dir = mkdtempSync(join(tmpdir(), "ocx-authstore-"));
  process.env.OPENCODEX_HOME = dir;
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (dir) removeTempDir(dir);
});

function fields(overrides: Partial<Parameters<typeof addAuthenticatorEntry>[0]> = {}) {
  return {
    issuer: "Example",
    account: "alice@example.com",
    secret: "JBSWY3DPEHPK3PXP",
    algorithm: "SHA1" as const,
    digits: 6,
    period: 30,
    ...overrides,
  };
}

describe("authenticator store — file identity", () => {
  test("lives at authenticator.json, never config.json or auth.json", () => {
    addAuthenticatorEntry(fields());
    expect(getAuthenticatorStorePath()).toBe(join(dir, "authenticator.json"));
    expect(existsSync(join(dir, "authenticator.json"))).toBe(true);
    expect(existsSync(join(dir, "auth.json"))).toBe(false);
    expect(existsSync(join(dir, "config.json"))).toBe(false);
  });

  test("the file is hardened to owner-only on write (unix)", () => {
    if (process.platform === "win32") return; // ACL hardening covered separately in windows-secret-acl.test.ts
    addAuthenticatorEntry(fields());
    const mode = statSync(getAuthenticatorStorePath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("addAuthenticatorEntry / loadAuthenticatorEntries", () => {
  test("round-trips every field, including the secret, byte-for-byte", () => {
    const created = addAuthenticatorEntry(fields());
    const [loaded] = loadAuthenticatorEntries();
    expect(loaded).toEqual(created);
    expect(loaded.secret).toBe("JBSWY3DPEHPK3PXP");
  });

  test("assigns increasing order to successive entries", () => {
    const a = addAuthenticatorEntry(fields({ account: "a" }));
    const b = addAuthenticatorEntry(fields({ account: "b" }));
    expect(b.order).toBeGreaterThan(a.order);
  });

  test("toEntryMeta strips the secret and nothing else", () => {
    const entry = addAuthenticatorEntry(fields());
    const meta = toEntryMeta(entry);
    expect((meta as Record<string, unknown>).secret).toBeUndefined();
    expect(meta.id).toBe(entry.id);
    expect(meta.issuer).toBe(entry.issuer);
    expect(meta.account).toBe(entry.account);
  });

  test("getAuthenticatorEntry finds by id and returns null for an unknown id", () => {
    const entry = addAuthenticatorEntry(fields());
    expect(getAuthenticatorEntry(entry.id)?.id).toBe(entry.id);
    expect(getAuthenticatorEntry("does-not-exist")).toBeNull();
  });
});

describe("updateAuthenticatorEntry", () => {
  test("patches issuer/account/group/order and bumps updatedAt", async () => {
    const entry = addAuthenticatorEntry(fields());
    await new Promise(r => setTimeout(r, 2));
    const updated = updateAuthenticatorEntry(entry.id, { issuer: "Renamed", account: "bob@example.com" });
    expect(updated?.issuer).toBe("Renamed");
    expect(updated?.account).toBe("bob@example.com");
    expect(updated?.secret).toBe(entry.secret); // never touched by a rename
    expect(updated?.updatedAt).not.toBe(entry.updatedAt);
  });

  test("returns null for an unknown id and writes nothing", () => {
    addAuthenticatorEntry(fields());
    const before = readFileSync(getAuthenticatorStorePath(), "utf-8");
    expect(updateAuthenticatorEntry("nope", { issuer: "x" })).toBeNull();
    expect(readFileSync(getAuthenticatorStorePath(), "utf-8")).toBe(before);
  });
});

describe("delete", () => {
  test("removeAuthenticatorEntry removes exactly one entry and reports 1", () => {
    const a = addAuthenticatorEntry(fields({ account: "a" }));
    const b = addAuthenticatorEntry(fields({ account: "b" }));
    expect(removeAuthenticatorEntry(a.id)).toBe(1);
    const remaining = loadAuthenticatorEntries();
    expect(remaining.map(e => e.id)).toEqual([b.id]);
  });

  test("removeAuthenticatorEntry on an unknown id reports 0 and changes nothing", () => {
    addAuthenticatorEntry(fields());
    expect(removeAuthenticatorEntry("nope")).toBe(0);
    expect(loadAuthenticatorEntries().length).toBe(1);
  });

  test("removeAuthenticatorEntries is a real bulk delete: one write, exact removed set", () => {
    const a = addAuthenticatorEntry(fields({ account: "a" }));
    const b = addAuthenticatorEntry(fields({ account: "b" }));
    const c = addAuthenticatorEntry(fields({ account: "c" }));
    const removed = removeAuthenticatorEntries([a.id, c.id, "nope"]);
    expect(removed.sort()).toEqual([a.id, c.id].sort());
    expect(loadAuthenticatorEntries().map(e => e.id)).toEqual([b.id]);
  });

  test("removeAuthenticatorEntries with no matches touches nothing", () => {
    addAuthenticatorEntry(fields());
    expect(removeAuthenticatorEntries(["nope"])).toEqual([]);
    expect(loadAuthenticatorEntries().length).toBe(1);
  });
});

describe("groups", () => {
  test("create, rename, reorder, and bulk-assign entries", () => {
    const group = addAuthenticatorGroup("Work");
    expect(loadAuthenticatorGroups().map(g => g.id)).toEqual([group.id]);

    const a = addAuthenticatorEntry(fields({ account: "a" }));
    const b = addAuthenticatorEntry(fields({ account: "b" }));
    const touched = bulkSetGroup([a.id, b.id], group.id);
    expect(touched.sort()).toEqual([a.id, b.id].sort());
    expect(loadAuthenticatorEntries().every(e => e.groupId === group.id)).toBe(true);

    const renamed = updateAuthenticatorGroup(group.id, { name: "Personal" });
    expect(renamed?.name).toBe("Personal");
  });

  test("deleting a group ungroups its members without deleting the entries", () => {
    const group = addAuthenticatorGroup("Temp");
    const entry = addAuthenticatorEntry(fields({ groupId: group.id }));
    expect(removeAuthenticatorGroup(group.id)).toBe(true);
    expect(loadAuthenticatorGroups()).toEqual([]);
    const survivor = getAuthenticatorEntry(entry.id);
    expect(survivor).not.toBeNull();
    expect(survivor?.groupId).toBeNull();
  });

  test("removeAuthenticatorGroup on an unknown id returns false", () => {
    expect(removeAuthenticatorGroup("nope")).toBe(false);
  });
});

describe("corrupt file recovery", () => {
  test("a hand-corrupted file is backed up and treated as empty, not a crash", () => {
    addAuthenticatorEntry(fields());
    const path = getAuthenticatorStorePath();
    require("node:fs").writeFileSync(path, "{ not valid json", "utf-8");
    expect(loadAuthenticatorEntries()).toEqual([]);
    const backups = require("node:fs").readdirSync(dir).filter((f: string) => f.startsWith("authenticator.json.invalid-"));
    expect(backups.length).toBeGreaterThan(0);
  });
});
