/**
 * A spending limit on guesses at the unauthenticated pairing claim.
 *
 * `POST /api/host/pair/claim` is the one management route that answers without a
 * credential, because a phone that has never paired has none to present. The
 * token is what protects it (see `pairing.ts`), and 256 bits is not a thing
 * anybody guesses. This limiter is not the security boundary and does not
 * pretend to be — it is there so that an endpoint anyone on the LAN can reach
 * cannot be held open as a free constant-time-compare and JSON-parse loop, and
 * so a broken client retrying in a tight loop shows up as a 429 rather than as
 * unbounded work.
 *
 * ## Why the budget is global rather than per-IP
 *
 * Partly because it has to be: the client address is not threaded down to the
 * management route handlers, and `Bun.serve`'s `server.requestIP` is only
 * reachable from the top-level fetch handler.
 *
 * But it is also the right shape. There is at most ONE outstanding pairing
 * token in the whole process, so what is being rationed is attempts against a
 * single secret, not attempts by a single caller. A per-IP budget would be
 * strictly worse here: anything able to rotate its source address would get a
 * fresh allowance each time, while the honest user still has exactly one phone.
 *
 * ## The trade this makes, stated plainly
 *
 * A global budget means noise from one device can spend the allowance a
 * legitimate phone needed. That is a real cost, and it is accepted for three
 * reasons: a genuine pairing spends exactly one attempt; the window is short
 * enough that a locked-out user waits seconds, not minutes; and the token —
 * not this counter — is what makes guessing hopeless, so an attacker who
 * exhausts the budget has bought a delay and nothing else.
 */

/** How long one budget lasts before it refills completely. */
export const CLAIM_WINDOW_MS = 60_000;

/**
 * Attempts allowed per window.
 *
 * Sized for people, not for guessing: one scan is one attempt, and the spare
 * room covers a phone that retried on a flaky Wi-Fi hop or a user who scanned
 * an expired code and then a fresh one.
 */
export const CLAIM_ATTEMPTS_PER_WINDOW = 10;

export type ClaimAttempt =
  | { allowed: true; remaining: number }
  | { allowed: false; retryAfterSeconds: number };

/** In memory, like the token it guards. A restart clears the budget with it. */
let windowStartedAt = 0;
let spent = 0;

/**
 * Charge one claim attempt against the budget.
 *
 * Every attempt is charged, not only the failures. A success consumes the token
 * anyway, so at most one attempt per token can succeed, and counting only
 * failures would mean a caller alternating a valid-looking claim with garbage
 * paid nothing for the garbage.
 *
 * `now` is injected so the window can be tested without sleeping through it.
 */
export function takeClaimAttempt(now: () => number = Date.now): ClaimAttempt {
  const at = now();
  if (at - windowStartedAt >= CLAIM_WINDOW_MS) {
    windowStartedAt = at;
    spent = 0;
  }
  if (spent >= CLAIM_ATTEMPTS_PER_WINDOW) {
    const msLeft = Math.max(0, windowStartedAt + CLAIM_WINDOW_MS - at);
    // Ceil, never floor: a floor of 0 tells a well-behaved client to retry
    // immediately into the same refusal.
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(msLeft / 1000)) };
  }
  spent += 1;
  return { allowed: true, remaining: CLAIM_ATTEMPTS_PER_WINDOW - spent };
}

/** Test seam — drops in-process state so cases cannot leak into each other. */
export function resetPairingRateLimitForTests(): void {
  windowStartedAt = 0;
  spent = 0;
}
