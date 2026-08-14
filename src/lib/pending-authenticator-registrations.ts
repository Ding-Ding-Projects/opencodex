/**
 * In-memory, TTL-bounded holding pen for a TOTP secret that has not yet been
 * confirmed.
 *
 * Both registration routes — "generate a fresh secret" and "import a scanned
 * or pasted one" — create a pending registration here first. Neither writes
 * to `authenticator-store.ts` until `confirmPendingRegistration` sees one live
 * code come back correct, per the contract: "Confirm the pairing before the
 * factor arms… without that step a mistyped or mis-scanned secret locks
 * somebody out of a thing they just set up, and the first they learn of it is
 * when they need it." A secret that is never confirmed — the user closes the
 * dialog, mis-scans and gives up, or just walks away — leaves *no trace on
 * disk at all*, which a persisted-then-deleted pending row could not promise.
 *
 * Deliberately process-local rather than shared across restarts: a pending
 * registration surviving a proxy restart would mean a secret already shown
 * on screen sitting around in a file somewhere, for a state that is supposed
 * to be "not yet real". Losing an in-progress pairing on a restart is the
 * safe failure mode here, not a bug.
 */

import { randomUUID } from "node:crypto";
import { verifyTotp, type TotpAlgorithm } from "./totp";
import { secretBytes } from "./otpauth-uri";

export interface PendingRegistration {
  id: string;
  issuer: string;
  account: string;
  secret: string; // base32
  algorithm: TotpAlgorithm;
  digits: number;
  period: number;
  groupId: string | null;
  createdAt: number;
  expiresAt: number;
  attemptsRemaining: number;
}

const TTL_MS = 10 * 60 * 1000; // 10 minutes — long enough to actually scan a QR and type a code back, short enough that an abandoned tab does not accumulate secrets in memory forever.
const MAX_ATTEMPTS = 8; // A generous but real bound: RFC 6238 codes are numeric-only and short, so an unbounded confirm endpoint is a local brute-force surface.

const pending = new Map<string, PendingRegistration>();

function purgeExpired(): void {
  const now = Date.now();
  for (const [id, reg] of pending) if (reg.expiresAt <= now) pending.delete(id);
}

export interface CreatePendingRegistrationInput {
  issuer: string;
  account: string;
  secret: string;
  algorithm: TotpAlgorithm;
  digits: number;
  period: number;
  groupId?: string | null;
}

export function createPendingRegistration(input: CreatePendingRegistrationInput): PendingRegistration {
  purgeExpired();
  const now = Date.now();
  const reg: PendingRegistration = {
    id: randomUUID(),
    issuer: input.issuer.trim(),
    account: input.account.trim(),
    secret: input.secret.toUpperCase(),
    algorithm: input.algorithm,
    digits: input.digits,
    period: input.period,
    groupId: input.groupId ?? null,
    createdAt: now,
    expiresAt: now + TTL_MS,
    attemptsRemaining: MAX_ATTEMPTS,
  };
  pending.set(reg.id, reg);
  return reg;
}

/**
 * Expiry is checked lazily, per key, rather than via the sweep — a global
 * sweep run first would delete an entry the instant it crosses its TTL, which
 * collapses "expired" and "never existed" into the same not-found result the
 * moment a test (or a real slow caller) observes it a beat late.
 */
export function getPendingRegistration(id: string): PendingRegistration | null {
  const reg = pending.get(id);
  if (!reg) return null;
  if (reg.expiresAt <= Date.now()) {
    pending.delete(id);
    return null;
  }
  return reg;
}

export function discardPendingRegistration(id: string): boolean {
  return pending.delete(id);
}

export type ConfirmResult =
  | { ok: true; registration: PendingRegistration }
  | { ok: false; reason: "not-found" | "expired" | "locked" | "wrong-code"; attemptsRemaining?: number };

/**
 * Verify a typed code against the pending secret. On success the caller
 * (the route handler) is responsible for persisting the entry and then
 * discarding the pending row — this function only judges the code and
 * enforces the attempt/expiry bounds, so a caller can never accidentally
 * "confirm" without also consuming the attempt.
 */
export function checkPendingRegistrationCode(id: string, code: string): ConfirmResult {
  const reg = pending.get(id);
  if (!reg) return { ok: false, reason: "not-found" };
  if (reg.expiresAt <= Date.now()) {
    pending.delete(id);
    return { ok: false, reason: "expired" };
  }
  if (reg.attemptsRemaining <= 0) {
    pending.delete(id);
    return { ok: false, reason: "locked" };
  }
  const valid = verifyTotp(secretBytes(reg.secret), code.trim(), {
    algorithm: reg.algorithm,
    digits: reg.digits,
    period: reg.period,
  });
  if (!valid) {
    reg.attemptsRemaining -= 1;
    if (reg.attemptsRemaining <= 0) pending.delete(id);
    return { ok: false, reason: "wrong-code", attemptsRemaining: Math.max(0, reg.attemptsRemaining) };
  }
  return { ok: true, registration: reg };
}

/** Test isolation only. */
export function resetPendingRegistrationsForTests(): void {
  pending.clear();
}
