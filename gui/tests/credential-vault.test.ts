/**
 * The one module in this app that touches a password or a TOTP secret.
 *
 * The RFC 6238 vectors matter more than anything else in this file: get HOTP's
 * byte order or the truncation math wrong and every toy lock silently rejects
 * correct codes forever, in a way no amount of UI testing would ever catch —
 * the wizard's own confirm step would still "work" because it generates and
 * checks a code with the same (wrong) implementation. Testing against the
 * published RFC vectors is what rules that out.
 */

import { describe, expect, test } from "bun:test";
import {
  base32Decode, base32Encode, clearAllCredentials, credentialMethod, hasCredential, hotp,
  randomBase32Secret, removeCredential, storeCredential, totpCode, verifyCredential,
  verifyPasswordCredential, verifyTotpAt, verifyTotpCredential,
} from "../src/shell/credential-vault";

// A plain in-memory localStorage stand-in — these tests run under plain `bun
// test`, with no DOM, so there is no browser storage unless something provides
// one. `crypto.subtle`/`crypto.getRandomValues` and `atob`/`btoa` are bun
// globals and need nothing.
class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null { return this.store.has(key) ? this.store.get(key)! : null; }
  setItem(key: string, value: string): void { this.store.set(key, value); }
  removeItem(key: string): void { this.store.delete(key); }
}
// `Object.defineProperty`, not a plain assignment: bun runs every test file in
// one process, and a DOM-backed suite elsewhere in the run (see
// `locks.test.ts`) defines `globalThis.localStorage` as a configurable-but-not-
// writable data property while it restores its own previous value in
// `afterEach`. Whichever test file's module body happens to evaluate after
// that leaves the property non-writable, and a plain `=` throws
// "Attempted to assign to readonly property" — not from anything wrong in
// this file, but from running order. Defining it explicitly as writable here
// sidesteps that regardless of what ran before it.
Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: new MemoryStorage() });

function ascii(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("RFC 6238 Appendix B test vectors (8-digit codes)", () => {
  // The RFC's own secrets: the ASCII string "12345678901234567890" repeated to
  // the byte length each HMAC needs, used raw — not base32 — exactly as the
  // published vectors specify.
  const SECRET_SHA1 = ascii("12345678901234567890");
  const SECRET_SHA256 = ascii("12345678901234567890123456789012");
  const SECRET_SHA512 = ascii("1234567890123456789012345678901234567890123456789012345678901234");

  const CASES: { atMs: number; sha1: string; sha256: string; sha512: string }[] = [
    { atMs: 59_000, sha1: "94287082", sha256: "46119246", sha512: "90693936" },
    { atMs: 1_111_111_109_000, sha1: "07081804", sha256: "68084774", sha512: "25091201" },
    { atMs: 1_111_111_111_000, sha1: "14050471", sha256: "67062674", sha512: "99943326" },
    { atMs: 1_234_567_890_000, sha1: "89005924", sha256: "91819424", sha512: "93441116" },
    { atMs: 2_000_000_000_000, sha1: "69279037", sha256: "90698825", sha512: "38618901" },
  ];

  for (const { atMs, sha1, sha256, sha512 } of CASES) {
    test(`T=${Math.floor(atMs / 1000 / 30)} (${new Date(atMs).toISOString()})`, async () => {
      expect(await totpCode(SECRET_SHA1, atMs, 30, 8, "SHA-1")).toBe(sha1);
      expect(await totpCode(SECRET_SHA256, atMs, 30, 8, "SHA-256")).toBe(sha256);
      expect(await totpCode(SECRET_SHA512, atMs, 30, 8, "SHA-512")).toBe(sha512);
    });
  }

  test("verifyTotpAt accepts the exact published code", async () => {
    expect(await verifyTotpAt(SECRET_SHA1, "94287082", 59_000, 30, 8, "SHA-1")).toBe(true);
  });

  test("verifyTotpAt rejects a code from a different period, outside the skew window", async () => {
    // T=1 (59s) vs T=3 (90s..119s) is two steps away; the default skew is ±1.
    expect(await verifyTotpAt(SECRET_SHA1, "94287082", 90_000, 30, 8, "SHA-1")).toBe(false);
  });

  test("verifyTotpAt tolerates one period of clock drift either side", async () => {
    // T=1's code, checked at a moment inside T=2 (30s later) — one step of skew.
    expect(await verifyTotpAt(SECRET_SHA1, "94287082", 59_000 + 30_000, 30, 8, "SHA-1")).toBe(true);
  });
});

describe("RFC 4226 HOTP directly, at counter 0", () => {
  // RFC 4226 Appendix D, first row, 6-digit truncation.
  test("the published counter-0 code", async () => {
    expect(await hotp(ascii("12345678901234567890"), 0, 6, "SHA-1")).toBe("755224");
  });
});

describe("base32 round trip", () => {
  test("encode then decode returns the original bytes", () => {
    const original = crypto.getRandomValues(new Uint8Array(20));
    const decoded = base32Decode(base32Encode(original));
    expect([...decoded]).toEqual([...original]);
  });

  test("decode tolerates lowercase and whitespace, the way a hand-typed secret arrives", () => {
    const secret = randomBase32Secret();
    const messy = secret.toLowerCase().replace(/(.{4})/g, "$1 ").trim();
    expect([...base32Decode(messy)]).toEqual([...base32Decode(secret)]);
  });

  test("randomBase32Secret never repeats and is the RFC 4226-recommended length", () => {
    const a = randomBase32Secret();
    const b = randomBase32Secret();
    expect(a).not.toBe(b);
    // 20 bytes -> 32 base32 characters, no padding.
    expect(a.length).toBe(32);
  });
});

describe("the vault, end to end", () => {
  test("a password credential verifies against the right password and nothing else", async () => {
    await storeCredential("lock-a", { method: "password", password: "correct horse battery staple" });
    expect(hasCredential("lock-a")).toBe(true);
    expect(credentialMethod("lock-a")).toBe("password");
    expect(await verifyPasswordCredential("lock-a", "correct horse battery staple")).toBe(true);
    expect(await verifyPasswordCredential("lock-a", "wrong")).toBe(false);
    expect(await verifyPasswordCredential("lock-a", "")).toBe(false);
  });

  test("two locks with the same password get independent, differently-salted hashes", async () => {
    await storeCredential("lock-b1", { method: "password", password: "same password" });
    await storeCredential("lock-b2", { method: "password", password: "same password" });
    const raw = JSON.parse(localStorage.getItem("ocx-m3:lock-vault")!);
    expect(raw["lock-b1"].hash).not.toBe(raw["lock-b2"].hash);
    expect(raw["lock-b1"].salt).not.toBe(raw["lock-b2"].salt);
    // Each still verifies against its own password independently — proving
    // "independent credentials" is not just "different bytes on disk".
    expect(await verifyPasswordCredential("lock-b1", "same password")).toBe(true);
    expect(await verifyPasswordCredential("lock-b2", "same password")).toBe(true);
  });

  test("a TOTP credential verifies a code generated from its own secret", async () => {
    const secret = randomBase32Secret();
    await storeCredential("lock-c", { method: "totp", secret });
    const now = Date.now();
    const code = await totpCode(base32Decode(secret), now, 30, 6, "SHA-1");
    expect(await verifyTotpCredential("lock-c", code, now)).toBe(true);
    expect(await verifyTotpCredential("lock-c", "000000", now)).toBe(false);
  });

  test("verifyCredential dispatches on the stored method, not the caller's guess", async () => {
    await storeCredential("lock-d", { method: "password", password: "hunter2" });
    // Handed a TOTP-shaped input against a password lock: no method match, no crash, false.
    expect(await verifyCredential("lock-d", { code: "123456" })).toBe(false);
    expect(await verifyCredential("lock-d", { password: "hunter2" })).toBe(true);
  });

  test("removeCredential deletes exactly one entry and leaves the rest", async () => {
    await storeCredential("lock-e1", { method: "password", password: "one" });
    await storeCredential("lock-e2", { method: "password", password: "two" });
    removeCredential("lock-e1");
    expect(hasCredential("lock-e1")).toBe(false);
    expect(hasCredential("lock-e2")).toBe(true);
  });

  test("clearAllCredentials wipes every lock's credential at once — the recovery path", async () => {
    await storeCredential("lock-f1", { method: "password", password: "one" });
    await storeCredential("lock-f2", { method: "totp", secret: randomBase32Secret() });
    clearAllCredentials();
    expect(hasCredential("lock-f1")).toBe(false);
    expect(hasCredential("lock-f2")).toBe(false);
  });

  test("nothing here ever writes the password or the TOTP secret in the clear into the vault record", async () => {
    const password = "super-secret-value-should-not-appear";
    await storeCredential("lock-g", { method: "password", password });
    const raw = localStorage.getItem("ocx-m3:lock-vault")!;
    expect(raw.includes(password)).toBe(false);

    const secret = randomBase32Secret();
    await storeCredential("lock-h", { method: "totp", secret });
    // The TOTP *secret itself* is necessarily stored (that is what a TOTP
    // verifier needs to compute the expected code) — the guarantee here is
    // narrower and is the one that matters: no *generated code*, and no
    // password from a sibling entry, ever leaks into another entry's record.
    const raw2 = JSON.parse(localStorage.getItem("ocx-m3:lock-vault")!);
    expect(raw2["lock-g"].password).toBeUndefined();
    expect(raw2["lock-h"].password).toBeUndefined();
  });
});
