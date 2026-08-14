import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  checkPendingRegistrationCode,
  createPendingRegistration,
  discardPendingRegistration,
  getPendingRegistration,
  resetPendingRegistrationsForTests,
} from "../src/lib/pending-authenticator-registrations";
import { totp } from "../src/lib/totp";
import { secretBytes } from "../src/lib/otpauth-uri";

beforeEach(() => resetPendingRegistrationsForTests());
afterEach(() => resetPendingRegistrationsForTests());

function input(overrides: Partial<Parameters<typeof createPendingRegistration>[0]> = {}) {
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

describe("createPendingRegistration / getPendingRegistration", () => {
  test("round-trips fields and assigns a fresh id each time", () => {
    const a = createPendingRegistration(input());
    const b = createPendingRegistration(input());
    expect(a.id).not.toBe(b.id);
    expect(getPendingRegistration(a.id)?.secret).toBe("JBSWY3DPEHPK3PXP");
  });

  test("an unknown id returns null", () => {
    expect(getPendingRegistration("nope")).toBeNull();
  });
});

describe("discardPendingRegistration", () => {
  test("removes the pending row and getPendingRegistration then returns null", () => {
    const reg = createPendingRegistration(input());
    expect(discardPendingRegistration(reg.id)).toBe(true);
    expect(getPendingRegistration(reg.id)).toBeNull();
  });

  test("discarding an unknown id returns false", () => {
    expect(discardPendingRegistration("nope")).toBe(false);
  });
});

describe("checkPendingRegistrationCode", () => {
  test("accepts the real current code and returns the registration", () => {
    const reg = createPendingRegistration(input());
    const code = totp(secretBytes(reg.secret), { algorithm: reg.algorithm, digits: reg.digits, period: reg.period });
    const result = checkPendingRegistrationCode(reg.id, code);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.registration.id).toBe(reg.id);
  });

  test("rejects a wrong code and decrements attemptsRemaining", () => {
    const reg = createPendingRegistration(input());
    const result = checkPendingRegistrationCode(reg.id, "000000");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("wrong-code");
      expect(result.attemptsRemaining).toBe(7);
    }
  });

  test("returns not-found for an unknown pending id", () => {
    const result = checkPendingRegistrationCode("nope", "000000");
    expect(result).toEqual({ ok: false, reason: "not-found" });
  });

  test("locks out after exhausting attempts, and the pending row is gone", () => {
    const reg = createPendingRegistration(input());
    let last;
    for (let i = 0; i < 8; i++) last = checkPendingRegistrationCode(reg.id, "000000");
    expect(last).toEqual({ ok: false, reason: "wrong-code", attemptsRemaining: 0 });
    // The 9th attempt finds it already gone.
    const afterLockout = checkPendingRegistrationCode(reg.id, "000000");
    expect(afterLockout).toEqual({ ok: false, reason: "not-found" });
  });

  test("a correct code still fails once the pending row has expired", () => {
    const reg = createPendingRegistration(input());
    const pendingRow = getPendingRegistration(reg.id)!;
    pendingRow.expiresAt = Date.now() - 1; // simulate TTL elapsed
    const code = totp(secretBytes(reg.secret), { algorithm: reg.algorithm, digits: reg.digits, period: reg.period });
    const result = checkPendingRegistrationCode(reg.id, code);
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  test("confirming does not itself remove the pending row — the route handler owns that", () => {
    const reg = createPendingRegistration(input());
    const code = totp(secretBytes(reg.secret), { algorithm: reg.algorithm, digits: reg.digits, period: reg.period });
    checkPendingRegistrationCode(reg.id, code);
    expect(getPendingRegistration(reg.id)).not.toBeNull();
  });
});
