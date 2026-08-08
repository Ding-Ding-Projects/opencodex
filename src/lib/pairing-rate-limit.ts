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
 * ## Two budgets, because one global window could be held down forever
 *
 * An earlier version of this file had a single global window and argued that an
 * attacker who exhausted it "has bought a delay and nothing else". That was
 * wrong, and worth spelling out because the reasoning looked sound. Ten
 * attempts per sixty seconds is **0.17 requests per second** — an attacker
 * spends the whole allowance in the first milliseconds of every window, forever,
 * at a rate no flood detector would notice. The honest phone then gets a 429 for
 * the entire five-minute life of its code, and regenerating does not help
 * because the counter never belonged to the code in the first place. Pairing
 * would be permanently unavailable to anything that can reach the port, with no
 * credential and not even parseable JSON required.
 *
 * So the allowance is split by whether a pairing is actually outstanding:
 *
 * - **Armed** — a token is on screen. This budget is reset by `armClaimBudget()`
 *   every time one is minted, so opening the pairing panel always hands the user
 *   a full allowance no matter what was spent before. This is what makes the
 *   attack above pointless: whatever an attacker drained belonged to a window
 *   nobody was pairing in.
 * - **Idle** — nothing outstanding, so no honest caller is here. This budget is
 *   the original one, kept purely so the route cannot be held open as a free
 *   parse-and-compare loop. Draining it costs a legitimate user nothing, because
 *   the moment they mint a code they are charged against the armed budget.
 *
 * The remaining cost is honest: an attacker who floods *during* the seconds
 * between minting a code and scanning it can still spend the armed allowance.
 * That is a plain flood at a rate worth noticing, not a 0.17 req/s trickle, and
 * it ends when the flood ends.
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

/** One window's worth of allowance. In memory, like the token it guards. */
interface Budget {
  startedAt: number;
  spent: number;
}

const armed: Budget = { startedAt: 0, spent: 0 };
const idle: Budget = { startedAt: 0, spent: 0 };

/**
 * Give the outstanding pairing a full allowance.
 *
 * Called by `createPairingToken`, so it happens exactly when a code appears on
 * screen. This is the whole defence against a caller sitting on the endpoint
 * spending the budget between pairings: whatever they spent, the user who opens
 * the panel starts from zero.
 */
export function armClaimBudget(now: () => number = Date.now): void {
  armed.startedAt = now();
  armed.spent = 0;
}

/**
 * Charge one claim attempt against the budget.
 *
 * Every attempt is charged, not only the failures. A success consumes the token
 * anyway, so at most one attempt per token can succeed, and counting only
 * failures would mean a caller alternating a valid-looking claim with garbage
 * paid nothing for the garbage.
 *
 * `pairingOutstanding` picks which of the two budgets pays — see the header. The
 * caller passes it rather than this module importing `pairing.ts`, so the
 * limiter stays a counter with no opinion about pairing state and the two
 * modules do not become circular.
 *
 * `now` is injected so the window can be tested without sleeping through it.
 */
export function takeClaimAttempt(
  pairingOutstanding: boolean,
  now: () => number = Date.now,
): ClaimAttempt {
  const at = now();
  const budget = pairingOutstanding ? armed : idle;
  if (at - budget.startedAt >= CLAIM_WINDOW_MS) {
    budget.startedAt = at;
    budget.spent = 0;
  }
  if (budget.spent >= CLAIM_ATTEMPTS_PER_WINDOW) {
    const msLeft = Math.max(0, budget.startedAt + CLAIM_WINDOW_MS - at);
    // Ceil, never floor: a floor of 0 tells a well-behaved client to retry
    // immediately into the same refusal.
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(msLeft / 1000)) };
  }
  budget.spent += 1;
  return { allowed: true, remaining: CLAIM_ATTEMPTS_PER_WINDOW - budget.spent };
}

/** Test seam — drops in-process state so cases cannot leak into each other. */
export function resetPairingRateLimitForTests(): void {
  armed.startedAt = 0;
  armed.spent = 0;
  idle.startedAt = 0;
  idle.spent = 0;
}
