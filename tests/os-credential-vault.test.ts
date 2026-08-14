import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CredentialVaultError,
  assertValidTokenRef,
  deleteVaultSecret,
  hasVaultSecret,
  readVaultSecret,
  storeVaultSecret,
} from "../src/lib/os-credential-vault";
import { removeTempDir } from "./helpers/temp-dir";

/**
 * The Windows DPAPI-backed vault behind a scheduled rule's Home Assistant
 * token — the "operating-system credential vault" the scheduling contract
 * requires.
 *
 * These spawn a real (non-elevated) PowerShell process and round-trip actual
 * DPAPI `Protect`/`Unprotect` calls, on the theory (borne out repeatedly in
 * this codebase's own notes on guards nobody has watched fail) that a mocked
 * vault proves nothing about the one thing that matters: whether the stored
 * bytes are actually recoverable, and actually not the plaintext.
 */

let testDir: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-vault-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTempDir(testDir);
});

describe("assertValidTokenRef", () => {
  test("accepts letters, digits, underscore and hyphen up to 80 characters", () => {
    expect(() => assertValidTokenRef("sched-abc123_XYZ-9")).not.toThrow();
  });
  test("rejects anything else", () => {
    for (const bad of ["", "has space", "semi;colon", "a".repeat(81), "..", "тест"]) {
      expect(() => assertValidTokenRef(bad), bad).toThrow(CredentialVaultError);
    }
  });
});

describe("store / read / has / delete round trip (real DPAPI)", () => {
  test("a stored token can be read back exactly", async () => {
    await storeVaultSecret("rule-1", "ha-long-lived-token-value-12345");
    expect(hasVaultSecret("rule-1")).toBe(true);
    expect(await readVaultSecret("rule-1")).toBe("ha-long-lived-token-value-12345");
  }, 20_000);

  test("the on-disk file never contains the plaintext token", async () => {
    const plaintext = "super-secret-home-assistant-token-do-not-leak";
    await storeVaultSecret("rule-2", plaintext);
    const path = join(testDir, "schedule-secrets.json");
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain(plaintext);
    const parsed = JSON.parse(raw);
    expect(parsed["rule-2"].alg).toBe("dpapi-currentuser");
    expect(typeof parsed["rule-2"].ciphertext).toBe("string");
    expect(parsed["rule-2"].ciphertext.length).toBeGreaterThan(0);
  }, 20_000);

  test("readVaultSecret on an unknown ref returns null rather than throwing", async () => {
    expect(await readVaultSecret("never-stored")).toBeNull();
  });

  test("hasVaultSecret is false before storing and true after", async () => {
    expect(hasVaultSecret("rule-3")).toBe(false);
    await storeVaultSecret("rule-3", "some-token-value");
    expect(hasVaultSecret("rule-3")).toBe(true);
  }, 20_000);

  test("storing twice under the same ref replaces the value", async () => {
    await storeVaultSecret("rule-4", "first-value");
    await storeVaultSecret("rule-4", "second-value");
    expect(await readVaultSecret("rule-4")).toBe("second-value");
  }, 20_000);

  test("deleteVaultSecret removes the entry; a second delete is a harmless no-op", async () => {
    await storeVaultSecret("rule-5", "to-be-deleted");
    expect(hasVaultSecret("rule-5")).toBe(true);
    deleteVaultSecret("rule-5");
    expect(hasVaultSecret("rule-5")).toBe(false);
    expect(await readVaultSecret("rule-5")).toBeNull();
    expect(() => deleteVaultSecret("rule-5")).not.toThrow();
  }, 20_000);

  test("two different refs store independently", async () => {
    await storeVaultSecret("rule-a", "value-a");
    await storeVaultSecret("rule-b", "value-b");
    expect(await readVaultSecret("rule-a")).toBe("value-a");
    expect(await readVaultSecret("rule-b")).toBe("value-b");
  }, 20_000);

  test("a value containing characters that need JSON/base64 care round-trips exactly", async () => {
    const tricky = 'token-with-"quotes"-and-\\backslash-and-emoji-🔒-and-unicode-喺度';
    await storeVaultSecret("rule-tricky", tricky);
    expect(await readVaultSecret("rule-tricky")).toBe(tricky);
  }, 20_000);
});

describe("bounds", () => {
  test("storing rejects an oversized token", async () => {
    await expect(storeVaultSecret("rule-big", "x".repeat(9000))).rejects.toBeInstanceOf(CredentialVaultError);
  });
  test("storing rejects an empty token", async () => {
    await expect(storeVaultSecret("rule-empty", "")).rejects.toBeInstanceOf(CredentialVaultError);
  });
  test("every vault function rejects an invalid tokenRef", async () => {
    await expect(storeVaultSecret("bad ref", "value")).rejects.toBeInstanceOf(CredentialVaultError);
    await expect(readVaultSecret("bad ref")).rejects.toBeInstanceOf(CredentialVaultError);
    expect(() => hasVaultSecret("bad ref")).toThrow(CredentialVaultError);
    expect(() => deleteVaultSecret("bad ref")).toThrow(CredentialVaultError);
  });
});

describe("corrupt storage fails closed", () => {
  test("a corrupt secrets file reads back as no secrets, never as a thrown error reaching the caller", () => {
    const { writeFileSync, mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(testDir, { recursive: true });
    writeFileSync(join(testDir, "schedule-secrets.json"), "{ not valid json", "utf8");
    expect(hasVaultSecret("anything")).toBe(false);
  });
});
