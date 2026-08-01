/**
 * The phone half of QR pairing: where the token comes from, where the key goes.
 *
 * Separate from `pages/Mobile.tsx` because none of it is a component — it is
 * page-load state and a credential store, and both have to be resettable from a
 * test without the page file exporting non-components.
 *
 * ## The key IS written to this phone's browser storage, on purpose
 *
 * `gui/src/api.ts` says the opposite in as many words — "never write tokens to
 * web storage (XSS can read sessionStorage/localStorage)" — and enforces it by
 * wiping a legacy stored token on every boot. That rule is right for what it
 * guards: an **admin** token, which reconfigures providers, reads every log line
 * and exports every account in plaintext. Nothing is worth leaving that readable
 * by any script on the origin, least of all saving one prompt.
 *
 * This is a different credential and therefore a different trade. Pairing mints
 * a **data-plane** key and nothing else — `claimPairingToken` in
 * `src/lib/pairing.ts` calls `mintDataPlaneKey`, never the management path — so
 * what is stored here can spend tokens through the proxy and cannot reconfigure
 * it. Against that, memory-only meant re-scanning a QR code on the desktop every
 * time a phone browser evicted the tab, which on iOS is roughly "every time you
 * use another app". That is the cost that made the remote unusable in practice,
 * and re-scanning was not a security control anybody was getting the benefit of —
 * they were simply not using the remote.
 *
 * So the accepted cost, stated plainly: an XSS on this origin can read this key
 * and send prompts at the user's expense. It is bounded three ways — the key is
 * listed and revocable on the dashboard's API keys screen, it is named
 * "Paired device" there so it is identifiable among the rest, and "Forget this
 * device" clears it from the phone. This is a decision, not `api.ts`'s rule
 * drifting.
 */

import { hashRouteParams, hashRoutePath } from "../app-routing";
import { normalizeHashPath, replaceHash } from "../hash-routing";

const STORED_KEY = "opencodex-mobile-key";

/**
 * A session mirror of the stored key.
 *
 * Storage can be unavailable — private browsing, a quota, a locked-down webview —
 * and a phone that cannot persist should still work for the session it paired
 * in, rather than failing at the last step of a QR scan.
 */
let memoryKey = "";

/** The paired key, from memory first so a storage-denied browser still works. */
export function readPairedKey(): string {
  if (memoryKey) return memoryKey;
  try {
    return localStorage.getItem(STORED_KEY) ?? "";
  } catch {
    return "";
  }
}

/** Store the paired key, or clear it when `value` is empty ("forget this device"). */
export function savePairedKey(value: string): void {
  memoryKey = value;
  try {
    if (value) localStorage.setItem(STORED_KEY, value);
    else localStorage.removeItem(STORED_KEY);
  } catch {
    /* storage unavailable — `memoryKey` still carries it for this page load */
  }
}

/** Why a claim was refused, in the words the phone can act on. */
export type ClaimFailure = "expired" | "no-pairing" | "mismatch" | "rate-limited" | "no-connection";

export type ClaimOutcome = { ok: true; key: string } | { ok: false; reason: ClaimFailure };

/**
 * Page-load state for the one claim a page load may perform.
 *
 * Module scope rather than component state because all of it has to survive
 * StrictMode's mount/unmount/mount: without it the second mount either re-spends
 * a token that is single-use by design — reporting the resulting refusal over a
 * pairing that actually succeeded — or finds the URL already stripped and
 * reports nothing at all.
 */
let pairTokenTaken = false;
let lastPairToken: string | null = null;
let claimInFlight: Promise<ClaimOutcome> | null = null;
let claimApplied = false;

/**
 * Read the pairing token out of the hash and remove it, once per page load.
 *
 * The strip happens BEFORE the claim is attempted, not after. The URL is the
 * part that leaks: it is what a screenshot captures, what "share this page"
 * copies, and what the browser restores on next launch. The in-memory copy is
 * what the claim — and any retry after a dropped connection — actually spends,
 * so nothing is lost by clearing the address bar first.
 */
function takePairTokenFromUrl(): string | null {
  if (pairTokenTaken) return null;
  pairTokenTaken = true;
  try {
    const raw = normalizeHashPath(window.location.hash);
    const token = hashRouteParams(raw).get("pair");
    if (!token) return null;
    // replaceState, not an assignment: this must not push a history entry whose
    // Back target is the URL with the token still in it.
    replaceHash(hashRoutePath(raw));
    lastPairToken = token;
    return token;
  } catch {
    return null;
  }
}

async function claim(apiBase: string, token: string): Promise<ClaimOutcome> {
  try {
    const res = await fetch(`${apiBase}/api/host/pair/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (res.status === 429) return { ok: false, reason: "rate-limited" };
    const data = await res.json().catch(() => null) as { key?: string; reason?: string } | null;
    if (res.ok && data?.key) return { ok: true, key: data.key };
    const reason = data?.reason;
    if (reason === "expired" || reason === "no-pairing" || reason === "mismatch") return { ok: false, reason };
    return { ok: false, reason: "no-connection" };
  } catch {
    // A phone that dropped off Wi-Fi rejects the fetch rather than answering.
    return { ok: false, reason: "no-connection" };
  }
}

/**
 * Start (or re-join) this page load's claim.
 *
 * Returns null when there is nothing to claim. Re-joining matters: StrictMode's
 * second mount finds the URL already stripped, and must subscribe to the claim
 * the first mount started rather than concluding that no pairing happened.
 */
export function beginPairingClaim(apiBase: string): Promise<ClaimOutcome> | null {
  const token = takePairTokenFromUrl();
  if (token) claimInFlight = claim(apiBase, token);
  return claimInFlight;
}

/** Whether this page load's claim outcome has already been shown to the user. */
export function isClaimApplied(): boolean {
  return claimApplied;
}

/**
 * Take responsibility for showing the outcome. False means somebody already did.
 *
 * Guards against a second subscriber — StrictMode's discarded mount, or an
 * effect re-running because the locale changed mid-request — announcing the same
 * pairing twice.
 */
export function markClaimApplied(): boolean {
  if (claimApplied) return false;
  claimApplied = true;
  return true;
}

/** A token is still held in memory for a retry after a dropped connection. */
export function canRetryPairingClaim(): boolean {
  return lastPairToken !== null;
}

/**
 * Retry the claim with the token this page load already read.
 *
 * Only worth offering for a transport failure: an expired, spent or wrong token
 * refuses identically however many times it is presented.
 */
export function retryPairingClaim(apiBase: string): Promise<ClaimOutcome> | null {
  if (!lastPairToken) return null;
  claimApplied = false;
  claimInFlight = claim(apiBase, lastPairToken);
  return claimInFlight;
}

/**
 * Test seam — drops the page-load state above so cases cannot leak into each
 * other, exactly as `resetApiAuthFetchForTests` does for the fetch wrapper.
 *
 * All of it is page-load scope on purpose, which is right in a browser and
 * sticky in a test runner: without this, the second case in a file inherits the
 * first case's already-spent token and its in-memory key, and reports "Paired"
 * for a device that never paired.
 */
export function resetMobilePairingForTests(): void {
  memoryKey = "";
  pairTokenTaken = false;
  lastPairToken = null;
  claimInFlight = null;
  claimApplied = false;
}
