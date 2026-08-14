/**
 * The School Mode store: schema validation, atomic writes, credential
 * hashing/verification, fail-closed reads, and the directory watcher.
 *
 * Every test points `OPENCODEX_SCHOOL_MODE_DIR` at a throwaway temp
 * directory, per the paths module's own doc comment — this must never touch
 * the real shared location on the machine running the suite.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schoolModeDir, schoolModeRecordPath } from "../src/school-mode/paths";
import {
  DEFAULT_SCHOOL_MODE_RECORD,
  hashCredential,
  parseSchoolModeRecord,
  readSchoolModeRecord,
  resetSchoolModeStoreForTests,
  SCHOOL_MODE_MAX_SECRET_LENGTH,
  SCHOOL_MODE_MIN_SECRET_LENGTH,
  validateSchoolModeName,
  validateSchoolModeSecret,
  verifyCredential,
  watchSchoolModeRecord,
  writeSchoolModeRecordAtomic,
  type SchoolModeRecord,
} from "../src/school-mode/store";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ocx-school-mode-"));
  process.env.OPENCODEX_SCHOOL_MODE_DIR = dir;
  resetSchoolModeStoreForTests();
});

afterEach(() => {
  delete process.env.OPENCODEX_SCHOOL_MODE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("paths", () => {
  test("the env override wins over the platform default", () => {
    expect(schoolModeDir()).toBe(dir);
    expect(schoolModeRecordPath()).toBe(join(dir, "state.json"));
  });
});

describe("reading with no record on disk", () => {
  test("is the ordinary off state, not a failure", () => {
    const result = readSchoolModeRecord();
    expect(result.readable).toBe(true);
    expect(result.record).toEqual(DEFAULT_SCHOOL_MODE_RECORD);
    expect(result.error).toBeUndefined();
  });
});

describe("write then read round-trips exactly", () => {
  test("enabled state, custom name and credential all survive", () => {
    const credential = hashCredential("open-sesame");
    const record: SchoolModeRecord = {
      version: 1,
      enabled: true,
      customName: "Focus mode",
      credential,
      updatedAt: 12345,
    };
    writeSchoolModeRecordAtomic(record);
    const result = readSchoolModeRecord();
    expect(result.readable).toBe(true);
    expect(result.record).toEqual(record);
  });

  test("the credential's plaintext never appears in the written file", () => {
    writeSchoolModeRecordAtomic({
      version: 1, enabled: true, customName: null, credential: hashCredential("super-secret-pin"), updatedAt: 1,
    });
    const raw = readFileSync(schoolModeRecordPath(), "utf8");
    expect(raw).not.toContain("super-secret-pin");
  });

  test("the write is atomic: no stray temp file is left behind", () => {
    writeSchoolModeRecordAtomic({ ...DEFAULT_SCHOOL_MODE_RECORD, enabled: true, updatedAt: 1 });
    const entries = readdirSync(dir);
    expect(entries).toEqual(["state.json"]);
  });
});

describe("fail-closed reading — never silently reports 'off' on a read failure", () => {
  test("malformed JSON is reported unreadable and keeps the last known-good state", () => {
    writeSchoolModeRecordAtomic({ ...DEFAULT_SCHOOL_MODE_RECORD, enabled: true, updatedAt: 1 });
    writeFileSync(schoolModeRecordPath(), "{ not valid json");
    const result = readSchoolModeRecord();
    expect(result.readable).toBe(false);
    expect(result.error).toBeTruthy();
    // Still reports the mode as ON — the last state this process actually trusted —
    // rather than collapsing to "off" because the file is now unreadable.
    expect(result.record.enabled).toBe(true);
  });

  test("an unsupported schema version is refused, not partially trusted", () => {
    writeFileSync(schoolModeRecordPath(), JSON.stringify({ version: 999, enabled: true }));
    const result = readSchoolModeRecord();
    expect(result.readable).toBe(false);
    expect(result.record).toEqual(DEFAULT_SCHOOL_MODE_RECORD);
  });

  test("parseSchoolModeRecord rejects every structurally wrong shape without throwing", () => {
    const bad: unknown[] = [
      null, "a string", 42, [],
      { version: 1 }, // missing enabled
      { version: 1, enabled: "yes", customName: null, credential: null, updatedAt: 1 },
      { version: 1, enabled: true, customName: 123, credential: null, updatedAt: 1 },
      { version: 1, enabled: true, customName: null, credential: { algorithm: "md5" }, updatedAt: 1 },
      { version: 1, enabled: true, customName: null, credential: null, updatedAt: "later" },
    ];
    for (const candidate of bad) {
      expect(() => parseSchoolModeRecord(candidate)).not.toThrow();
      expect(parseSchoolModeRecord(candidate)).toBeNull();
    }
  });
});

describe("credential hashing and verification", () => {
  test("verifies the exact secret it was hashed from", () => {
    const credential = hashCredential("correct horse battery staple");
    expect(verifyCredential("correct horse battery staple", credential)).toBe(true);
  });

  test("refuses a wrong secret", () => {
    const credential = hashCredential("correct horse battery staple");
    expect(verifyCredential("wrong guess", credential)).toBe(false);
  });

  test("never stores the plaintext in the credential record", () => {
    const credential = hashCredential("my-pin-1234");
    expect(JSON.stringify(credential)).not.toContain("my-pin-1234");
  });

  test("two hashes of the same secret use different salts (and so differ)", () => {
    const a = hashCredential("same-secret");
    const b = hashCredential("same-secret");
    expect(a.saltB64).not.toBe(b.saltB64);
    expect(a.hashB64).not.toBe(b.hashB64);
    // Both still verify correctly against their own record.
    expect(verifyCredential("same-secret", a)).toBe(true);
    expect(verifyCredential("same-secret", b)).toBe(true);
  });

  test("a malformed credential record fails closed rather than throwing", () => {
    expect(verifyCredential("anything", { algorithm: "scrypt", saltB64: "not-base64!!", hashB64: "also-not" })).toBe(false);
  });
});

describe("secret and name validation bounds", () => {
  test("a secret shorter than the minimum is refused", () => {
    expect(validateSchoolModeSecret("a".repeat(SCHOOL_MODE_MIN_SECRET_LENGTH - 1))).toEqual({ ok: false, reason: "too-short" });
  });
  test("a secret at the minimum length is accepted", () => {
    expect(validateSchoolModeSecret("a".repeat(SCHOOL_MODE_MIN_SECRET_LENGTH)).ok).toBe(true);
  });
  test("a secret longer than the maximum is refused", () => {
    expect(validateSchoolModeSecret("a".repeat(SCHOOL_MODE_MAX_SECRET_LENGTH + 1))).toEqual({ ok: false, reason: "too-long" });
  });
  test("a non-string secret is refused, not coerced", () => {
    expect(validateSchoolModeSecret(1234).ok).toBe(false);
    expect(validateSchoolModeSecret(undefined).ok).toBe(false);
  });

  test("null is always a valid name (clears back to the shipped default)", () => {
    expect(validateSchoolModeName(null)).toBe(true);
  });
  test("an empty or whitespace-only name is refused", () => {
    expect(validateSchoolModeName("")).toBe(false);
    expect(validateSchoolModeName("   ")).toBe(false);
  });
  test("a name over the length bound is refused", () => {
    expect(validateSchoolModeName("a".repeat(81))).toBe(false);
  });
});

describe("watching the shared directory", () => {
  test("reports watchable and creates the directory if it did not exist", () => {
    expect(existsSync(dir)).toBe(true); // mkdtempSync already created it
    const handle = watchSchoolModeRecord(() => {});
    expect(handle.watchable).toBe(true);
    handle.stop();
  });

  test("fires the callback with the fresh record after an external write", async () => {
    const seen: boolean[] = [];
    const handle = watchSchoolModeRecord(result => { seen.push(result.record.enabled); });
    try {
      writeSchoolModeRecordAtomic({ ...DEFAULT_SCHOOL_MODE_RECORD, enabled: true, updatedAt: 1 });
      // Debounced — give the watcher's timer a moment to fire.
      await new Promise(resolve => setTimeout(resolve, 250));
      expect(seen).toContain(true);
    } finally {
      handle.stop();
    }
  });

  test("creates the directory on demand when it does not exist yet", () => {
    const freshDir = join(dir, "not-created-yet");
    process.env.OPENCODEX_SCHOOL_MODE_DIR = freshDir;
    expect(existsSync(freshDir)).toBe(false);
    const handle = watchSchoolModeRecord(() => {});
    expect(handle.watchable).toBe(true);
    expect(existsSync(freshDir)).toBe(true);
    handle.stop();
  });
});
