/**
 * Pairing a phone by QR, without anybody typing a password.
 *
 * The remote control was unreachable in practice: the proxy binds loopback, and
 * exposing it needs a data-plane credential, which meant inventing a password on
 * a laptop and then typing it on a phone. Most people simply did not, so the
 * feature existed and went unused.
 *
 * A pairing token fixes the typing without giving up the credential. The QR
 * carries a short-lived secret; the phone spends it once and receives a real
 * data-plane key of its own. What the phone ends up holding is exactly what it
 * would have held if the user had typed a password, so nothing downstream has to
 * learn about pairing at all.
 *
 * ## Why the claim endpoint is unauthenticated, and why that is safe
 *
 * It has to be — a phone that has never paired has no credential to present.
 * What protects it is not authentication but the token itself:
 *
 * - **256 bits of randomness.** Guessing is not a strategy.
 * - **Single use.** Claiming consumes it, so a photographed QR is spent the
 *   moment the intended phone uses it. This is the property that makes a QR on a
 *   screen acceptable at all: a shoulder-surfer gets a token that has already
 *   been redeemed.
 * - **Short lived.** {@link PAIRING_TTL_MS} from mint. A QR left on a monitor
 *   overnight is not a standing invitation.
 * - **One at a time.** Minting replaces any outstanding token, so a user who
 *   opens the pairing panel three times leaves one live secret, not three.
 * - **Never an admin token.** A paired phone gets a data-plane key. It can use
 *   the proxy; it cannot reconfigure it.
 *
 * ## Why it is never written to disk
 *
 * Held in memory only, so a restart invalidates every outstanding token. A
 * pairing secret is worth exactly as much as the key it produces, and persisting
 * it would leave that value in `config.json` — and therefore in `ocx export` —
 * long after it stopped being useful. The minted key is persisted, because that
 * is the thing with a reason to outlive the process.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";

import { mintDataPlaneKey } from "./host-control";
import type { OcxConfig } from "../types";

/**
 * How long a pairing token stays claimable.
 *
 * Long enough to walk to a phone, unlock it and open the camera; short enough
 * that a QR still on screen after a meeting has already expired.
 */
export const PAIRING_TTL_MS = 5 * 60_000;

/** Name recorded on keys minted through pairing, so they are identifiable later. */
export const PAIRED_KEY_NAME = "Paired device";

interface PendingPairing {
  token: string;
  expiresAt: number;
}

/** In memory only — see the module note. At most one outstanding token. */
let pending: PendingPairing | null = null;

export interface PairingOffer {
  token: string;
  /** Epoch millis. The UI counts down against this rather than assuming the TTL. */
  expiresAt: number;
}

/**
 * Mint a pairing token, replacing any outstanding one.
 *
 * `now` is injected so the expiry rules can be tested without waiting five
 * minutes, and so a test cannot pass merely because it ran quickly.
 */
export function createPairingToken(now: () => number = Date.now): PairingOffer {
  const token = randomBytes(32).toString("base64url");
  pending = { token, expiresAt: now() + PAIRING_TTL_MS };
  return { ...pending };
}

/** Forget any outstanding token — used when the user closes the pairing panel. */
export function cancelPairing(): void {
  pending = null;
}

/** The outstanding offer, or null. Never returns an expired one. */
export function peekPairing(now: () => number = Date.now): PairingOffer | null {
  if (!pending) return null;
  if (now() >= pending.expiresAt) {
    pending = null;
    return null;
  }
  return { ...pending };
}

export type ClaimResult =
  | { ok: true; key: string }
  | { ok: false; reason: "no-pairing" | "expired" | "mismatch" };

/**
 * Spend a pairing token and return a data-plane key for the device.
 *
 * The caller persists the config — this only mutates it — because writing is
 * the caller's concern and a failed write must not leave a token already spent
 * in memory but no key on disk.
 *
 * Compared in constant time. The window is tiny and the token is 256 bits, but
 * a timing-variable compare on a secret is the kind of thing that is free to get
 * right here and awkward to retrofit once something else depends on it.
 */
export function claimPairingToken(
  presented: string,
  config: OcxConfig,
  now: () => number = Date.now,
): ClaimResult {
  // Read before peeking, not after. `peekPairing` *drops* an expired token as a
  // side effect, so asking `pending` afterwards always answered null and the
  // "expired" branch below could never be taken — every timed-out claim reported
  // "no-pairing" instead. The two need different words because they need
  // different actions: "expired" means mint another, "none outstanding" means
  // the user never started pairing on the desktop at all, and telling someone
  // whose code merely aged out to go and start pairing sends them to a screen
  // where pairing is already open.
  const hadOutstanding = pending !== null;
  const offer = peekPairing(now);
  if (!offer) return { ok: false, reason: hadOutstanding ? "expired" : "no-pairing" };

  const a = Buffer.from(presented);
  const b = Buffer.from(offer.token);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    // A wrong token does NOT consume the outstanding one. Otherwise anybody able
    // to reach the endpoint could cancel a legitimate pairing by guessing once.
    return { ok: false, reason: "mismatch" };
  }

  // Consume before minting: if minting throws, the token is still spent, which
  // fails closed. The user mints another; nobody gets a second attempt at this one.
  pending = null;
  return { ok: true, key: mintDataPlaneKey(config, PAIRED_KEY_NAME) };
}

/** Test seam — drops in-process state so cases cannot leak into each other. */
export function resetPairingForTests(): void {
  pending = null;
}
