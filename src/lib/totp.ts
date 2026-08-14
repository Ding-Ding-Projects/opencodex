/**
 * RFC 4226 HOTP and RFC 6238 TOTP — the built-in authenticator's whole trust
 * boundary sits here, so this file is deliberately small, deliberately
 * standards-literal, and verified against the RFCs' own published test
 * vectors in `tests/totp.test.ts` rather than eyeballed. An authenticator that
 * is subtly wrong produces codes rejected everywhere with no error to read —
 * "looks right" is not evidence for this file the way it is for most code.
 *
 * TOTP is HOTP with the counter derived from wall-clock time
 * (`floor((time - T0) / period)`), per RFC 6238 §1.2. Every TOTP call in this
 * module therefore just computes that counter and calls `hotp`.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type TotpAlgorithm = "SHA1" | "SHA256" | "SHA512";
export const TOTP_ALGORITHMS: readonly TotpAlgorithm[] = ["SHA1", "SHA256", "SHA512"];

/** The default every unlabelled TOTP issuer in the world uses (Google Authenticator's baseline). */
export const DEFAULT_ALGORITHM: TotpAlgorithm = "SHA1";
export const DEFAULT_DIGITS = 6;
export const DEFAULT_PERIOD = 30;

export const MIN_DIGITS = 6;
export const MAX_DIGITS = 8;

function hmacAlgoName(algorithm: TotpAlgorithm): "sha1" | "sha256" | "sha512" {
  switch (algorithm) {
    case "SHA1": return "sha1";
    case "SHA256": return "sha256";
    case "SHA512": return "sha512";
  }
}

/**
 * Secret length recommended per algorithm: RFC 4226 §4 R6 calls for at least
 * 128 bits and "strongly recommends" 160; matching the key length to the HMAC
 * block/output size (the RFC 6238 Appendix B test-vector seeds are 20/32/64
 * bytes for SHA-1/256/512 respectively) is the conventional practice every
 * mainstream authenticator follows.
 */
export function recommendedSecretBytes(algorithm: TotpAlgorithm): number {
  switch (algorithm) {
    case "SHA1": return 20;
    case "SHA256": return 32;
    case "SHA512": return 64;
  }
}

/** A fresh cryptographically random secret, sized for `algorithm`. */
export function generateSecret(algorithm: TotpAlgorithm = DEFAULT_ALGORITHM): Uint8Array {
  return new Uint8Array(randomBytes(recommendedSecretBytes(algorithm)));
}

export interface HotpOptions {
  algorithm?: TotpAlgorithm;
  digits?: number;
}

function assertDigits(digits: number): void {
  if (!Number.isInteger(digits) || digits < MIN_DIGITS || digits > MAX_DIGITS) {
    throw new RangeError(`digits must be an integer ${MIN_DIGITS}-${MAX_DIGITS}, got ${digits}`);
  }
}

/**
 * RFC 4226 HOTP: dynamic truncation of `HMAC(secret, counter)` into a decimal
 * code of `digits` length. `counter` may exceed 2^53 in principle (an 8-byte
 * counter), so it is accepted as `number | bigint` and always converted to
 * bigint before being written big-endian.
 */
export function hotp(secret: Uint8Array, counter: number | bigint, options: HotpOptions = {}): string {
  const algorithm = options.algorithm ?? DEFAULT_ALGORITHM;
  const digits = options.digits ?? DEFAULT_DIGITS;
  assertDigits(digits);
  const counterValue = typeof counter === "bigint" ? counter : BigInt(Math.trunc(counter));
  if (counterValue < 0n) throw new RangeError(`counter must be non-negative, got ${counterValue}`);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(counterValue);
  const digest = createHmac(hmacAlgoName(algorithm), Buffer.from(secret)).update(counterBuf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binCode =
    ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  const code = binCode % 10 ** digits;
  return code.toString().padStart(digits, "0");
}

export interface TotpOptions extends HotpOptions {
  /** Step size in seconds. RFC 6238 §5.2 default is 30; any positive value is accepted. */
  period?: number;
  /** Unix epoch seconds. Defaults to `Date.now() / 1000`. */
  time?: number;
}

/** The RFC 6238 time-step counter for `time` (epoch seconds) at `period` (seconds), T0 = 0. */
export function totpStep(time: number, period: number): number {
  if (!Number.isFinite(period) || period <= 0) {
    throw new RangeError(`period must be a positive number of seconds, got ${period}`);
  }
  return Math.floor(time / period);
}

export function totp(secret: Uint8Array, options: TotpOptions = {}): string {
  const period = options.period ?? DEFAULT_PERIOD;
  const time = options.time ?? Date.now() / 1000;
  return hotp(secret, totpStep(time, period), options);
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // timingSafeEqual throws on length mismatch, and any length difference has
  // already leaked nothing an attacker could not already see (the digit
  // count is public), so a plain false here costs no real timing signal.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export interface VerifyTotpOptions extends TotpOptions {
  /**
   * Tolerance in time-steps either side of "now" (default 1 = accept the
   * previous, current, and next code). Absorbs the ordinary case of a user
   * typing a code just as it rolls over, without opening the window so wide
   * that a captured code stays valid for minutes.
   */
  window?: number;
}

/** Verify a typed code against `secret`, accepting any step within `±window` of now. */
export function verifyTotp(secret: Uint8Array, code: string, options: VerifyTotpOptions = {}): boolean {
  const period = options.period ?? DEFAULT_PERIOD;
  const time = options.time ?? Date.now() / 1000;
  const window = options.window ?? 1;
  const centerStep = totpStep(time, period);
  for (let offset = -window; offset <= window; offset++) {
    const step = centerStep + offset;
    if (step < 0) continue;
    const candidate = hotp(secret, step, options);
    if (timingSafeEqualStrings(candidate, code)) return true;
  }
  return false;
}

/** Seconds remaining in the current time-step, for the live countdown. */
export function secondsRemaining(period: number, time: number = Date.now() / 1000): number {
  const step = totpStep(time, period);
  const stepStart = step * period;
  return Math.max(0, Math.ceil(stepStart + period - time));
}
