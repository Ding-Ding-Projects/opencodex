/**
 * RFC 4226 (HOTP) Appendix D and RFC 6238 (TOTP) Appendix B publish exact
 * test vectors precisely so an implementation can be checked byte-for-byte
 * instead of trusted on the strength of "it compiles and looks plausible" —
 * see the file header on `src/lib/totp.ts` for why that distinction matters
 * here specifically.
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PERIOD,
  generateSecret,
  hotp,
  recommendedSecretBytes,
  secondsRemaining,
  totp,
  totpStep,
  verifyTotp,
  type TotpAlgorithm,
} from "../src/lib/totp";

/** RFC 4226 Appendix D: 20-byte ASCII secret "12345678901234567890", SHA-1, 6 digits. */
const RFC4226_SECRET = new TextEncoder().encode("12345678901234567890");
const RFC4226_VECTORS: [number, string][] = [
  [0, "755224"],
  [1, "287082"],
  [2, "359152"],
  [3, "969429"],
  [4, "338314"],
  [5, "254676"],
  [6, "287922"],
  [7, "162583"],
  [8, "399871"],
  [9, "520489"],
];

describe("hotp — RFC 4226 Appendix D", () => {
  for (const [counter, expected] of RFC4226_VECTORS) {
    test(`counter=${counter}`, () => {
      expect(hotp(RFC4226_SECRET, counter, { algorithm: "SHA1", digits: 6 })).toBe(expected);
    });
  }
});

/**
 * RFC 6238 Appendix B: seeds are the ASCII digits "1234567890" repeated to
 * 20/32/64 bytes for SHA-1/256/512, X=30s, T0=0, 8-digit truncation.
 */
const RFC6238_SEED_SHA1 = new TextEncoder().encode("12345678901234567890");
const RFC6238_SEED_SHA256 = new TextEncoder().encode("12345678901234567890123456789012");
const RFC6238_SEED_SHA512 = new TextEncoder().encode("1234567890123456789012345678901234567890123456789012345678901234");

const RFC6238_VECTORS: [number, TotpAlgorithm, Uint8Array, string][] = [
  [59, "SHA1", RFC6238_SEED_SHA1, "94287082"],
  [59, "SHA256", RFC6238_SEED_SHA256, "46119246"],
  [59, "SHA512", RFC6238_SEED_SHA512, "90693936"],

  [1111111109, "SHA1", RFC6238_SEED_SHA1, "07081804"],
  [1111111109, "SHA256", RFC6238_SEED_SHA256, "68084774"],
  [1111111109, "SHA512", RFC6238_SEED_SHA512, "25091201"],

  [1111111111, "SHA1", RFC6238_SEED_SHA1, "14050471"],
  [1111111111, "SHA256", RFC6238_SEED_SHA256, "67062674"],
  [1111111111, "SHA512", RFC6238_SEED_SHA512, "99943326"],

  [1234567890, "SHA1", RFC6238_SEED_SHA1, "89005924"],
  [1234567890, "SHA256", RFC6238_SEED_SHA256, "91819424"],
  [1234567890, "SHA512", RFC6238_SEED_SHA512, "93441116"],

  [2000000000, "SHA1", RFC6238_SEED_SHA1, "69279037"],
  [2000000000, "SHA256", RFC6238_SEED_SHA256, "90698825"],
  [2000000000, "SHA512", RFC6238_SEED_SHA512, "38618901"],

  [20000000000, "SHA1", RFC6238_SEED_SHA1, "65353130"],
  [20000000000, "SHA256", RFC6238_SEED_SHA256, "77737706"],
  [20000000000, "SHA512", RFC6238_SEED_SHA512, "47863826"],
];

describe("totp — RFC 6238 Appendix B", () => {
  for (const [time, algorithm, seed, expected] of RFC6238_VECTORS) {
    test(`t=${time} ${algorithm}`, () => {
      expect(totp(seed, { algorithm, digits: 8, period: 30, time })).toBe(expected);
    });
  }
});

describe("totpStep", () => {
  test("floors to the step boundary, T0=0", () => {
    expect(totpStep(59, 30)).toBe(1);
    expect(totpStep(60, 30)).toBe(2);
    expect(totpStep(0, 30)).toBe(0);
    expect(totpStep(29, 30)).toBe(0);
  });

  test("rejects a non-positive period", () => {
    expect(() => totpStep(100, 0)).toThrow(RangeError);
    expect(() => totpStep(100, -30)).toThrow(RangeError);
  });
});

describe("secondsRemaining", () => {
  test("counts down within a step and resets at the boundary", () => {
    expect(secondsRemaining(30, 0)).toBe(30);
    expect(secondsRemaining(30, 1)).toBe(29);
    expect(secondsRemaining(30, 29)).toBe(1);
    expect(secondsRemaining(30, 30)).toBe(30);
  });
});

describe("hotp digit bounds", () => {
  test("accepts 6, 7, 8 digits", () => {
    for (const digits of [6, 7, 8]) {
      expect(hotp(RFC4226_SECRET, 0, { digits }).length).toBe(digits);
    }
  });

  test("rejects out-of-range or non-integer digits", () => {
    expect(() => hotp(RFC4226_SECRET, 0, { digits: 5 })).toThrow(RangeError);
    expect(() => hotp(RFC4226_SECRET, 0, { digits: 9 })).toThrow(RangeError);
    expect(() => hotp(RFC4226_SECRET, 0, { digits: 6.5 })).toThrow(RangeError);
  });

  test("rejects a negative counter", () => {
    expect(() => hotp(RFC4226_SECRET, -1)).toThrow(RangeError);
  });

  test("accepts a bigint counter beyond Number.MAX_SAFE_INTEGER", () => {
    // Same 8-byte big-endian encoding either way; this just proves the bigint
    // path is exercised and produces a stable 6-digit code, not a crash.
    const code = hotp(RFC4226_SECRET, 9_007_199_254_740_993n);
    expect(code).toMatch(/^\d{6}$/);
  });
});

describe("verifyTotp", () => {
  test("accepts the exact current code", () => {
    const secret = RFC6238_SEED_SHA1;
    const code = totp(secret, { algorithm: "SHA1", digits: 8, period: 30, time: 59 });
    expect(verifyTotp(secret, code, { algorithm: "SHA1", digits: 8, period: 30, time: 59 })).toBe(true);
  });

  test("accepts the previous and next step within the default window", () => {
    const secret = RFC6238_SEED_SHA1;
    const prev = totp(secret, { algorithm: "SHA1", digits: 8, period: 30, time: 29 }); // step 0
    const next = totp(secret, { algorithm: "SHA1", digits: 8, period: 30, time: 89 }); // step 2
    // Evaluated "now" at step 1 (time=59): both step 0 and step 2 are within window=1.
    expect(verifyTotp(secret, prev, { algorithm: "SHA1", digits: 8, period: 30, time: 59 })).toBe(true);
    expect(verifyTotp(secret, next, { algorithm: "SHA1", digits: 8, period: 30, time: 59 })).toBe(true);
  });

  test("rejects a code two steps away with the default window", () => {
    const secret = RFC6238_SEED_SHA1;
    const farFuture = totp(secret, { algorithm: "SHA1", digits: 8, period: 30, time: 149 }); // step 4
    expect(verifyTotp(secret, farFuture, { algorithm: "SHA1", digits: 8, period: 30, time: 59 })).toBe(false);
  });

  test("rejects a wrong code entirely", () => {
    expect(verifyTotp(RFC6238_SEED_SHA1, "00000000", { algorithm: "SHA1", digits: 8, period: 30, time: 59 })).toBe(false);
  });

  test("rejects a code of the wrong length rather than throwing", () => {
    expect(verifyTotp(RFC6238_SEED_SHA1, "123", { algorithm: "SHA1", digits: 8, period: 30, time: 59 })).toBe(false);
  });

  test("window=0 accepts only the exact step", () => {
    const secret = RFC6238_SEED_SHA1;
    const prev = totp(secret, { algorithm: "SHA1", digits: 8, period: 30, time: 29 });
    expect(verifyTotp(secret, prev, { algorithm: "SHA1", digits: 8, period: 30, time: 59, window: 0 })).toBe(false);
  });
});

describe("defaults", () => {
  test("DEFAULT_PERIOD is 30 seconds — what the rest of the world issues", () => {
    expect(DEFAULT_PERIOD).toBe(30);
  });

  test("totp() defaults to SHA1/6 digits/30s when unspecified", () => {
    const code = totp(RFC4226_SECRET, { time: 0 });
    expect(code).toBe(hotp(RFC4226_SECRET, 0, { algorithm: "SHA1", digits: 6 }));
  });
});

describe("generateSecret", () => {
  test("sizes the secret to the algorithm's recommended length", () => {
    expect(recommendedSecretBytes("SHA1")).toBe(20);
    expect(recommendedSecretBytes("SHA256")).toBe(32);
    expect(recommendedSecretBytes("SHA512")).toBe(64);
    expect(generateSecret("SHA1").length).toBe(20);
    expect(generateSecret("SHA256").length).toBe(32);
    expect(generateSecret("SHA512").length).toBe(64);
  });

  test("two calls produce different secrets", () => {
    const a = generateSecret("SHA1");
    const b = generateSecret("SHA1");
    expect([...a]).not.toEqual([...b]);
  });
});
