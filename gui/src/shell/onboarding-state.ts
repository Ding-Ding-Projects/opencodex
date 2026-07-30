/**
 * First-run detection and the persisted onboarding flag.
 *
 * The whole value of this module is one guarantee: the wizard is shown to a
 * genuinely new install and to nobody else. A wizard that reappears on every
 * launch is worse than no wizard at all, so every signal below is biased towards
 * *not* showing it — an unreadable store, a failed probe or an ambiguous
 * response all resolve to "hide".
 *
 * The flag lives in `ocx-m3:onboarding`, a sibling of the preferences blob
 * `ocx-m3:v1` in the same `ocx-m3:` namespace (the funny levels in
 * `ocx-m3:funny` follow the same pattern). It is deliberately *not* a field
 * inside the prefs blob: `resetAppearance()` rebuilds that object from
 * `DEFAULT_PREFS`, so a flag stored there would be wiped by "Reset appearance"
 * and the wizard would return to a long-standing user.
 */

import { PREFS_KEY } from "../theme/prefs-context";
import { readRevisions } from "./revisions";

export const ONBOARDING_KEY = "ocx-m3:onboarding";

export interface OnboardingState {
  /**
   * True once the wizard was finished, or dismissed with "Don't show this
   * again" left on. False means the user explicitly asked to see it again.
   */
  completed: boolean;
  /** Epoch ms of the decision, for debugging a store that looks wrong. */
  at: number;
}

export function readOnboarding(): OnboardingState | null {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(ONBOARDING_KEY) || "null");
    if (!raw || typeof raw !== "object") return null;
    const row = raw as Partial<OnboardingState>;
    return { completed: row.completed === true, at: Number(row.at) || 0 };
  } catch {
    return null;
  }
}

function write(completed: boolean): void {
  try {
    localStorage.setItem(ONBOARDING_KEY, JSON.stringify({ completed, at: Date.now() }));
  } catch { /* quota — the wizard still closes, it just may return once */ }
}

/** Finished, or dismissed with the "don't show again" switch left on. */
export function completeOnboarding(): void { write(true); }

/** Dismissed with "don't show again" turned off: it may come back next launch. */
export function deferOnboarding(): void { write(false); }

/**
 * Evidence that this dashboard has been used before, for a user upgrading into
 * the build that first shipped the wizard. `ocx-m3:v1` is only written once a
 * preference actually changes, and the revision log only once something was
 * mutated — neither exists on a genuinely fresh profile.
 *
 * `ocx-lang` and `ocx-m3:tabs` are deliberately *not* consulted: both are
 * written by a mount effect on every launch, including the first one, so they
 * say nothing about prior use.
 */
export function hasPriorUse(): boolean {
  try {
    if (localStorage.getItem(PREFS_KEY) !== null) return true;
  } catch {
    // No readable storage means no way to remember a dismissal either, so the
    // wizard would reappear forever. Stay quiet instead.
    return true;
  }
  return readRevisions().length > 0;
}

/** The synchronous half of the decision: does this profile look brand new? */
export function isFirstRunCandidate(): boolean {
  const state = readOnboarding();
  if (state) return !state.completed;
  return !hasPriorUse();
}

/**
 * Once the wizard has been closed — or decided against — this page load is done
 * with it, whatever happens to the component tree afterwards. The latch lives
 * here rather than in the component file so a test can clear it between cases;
 * nothing in the app ever calls `resetLaunchLatch`.
 */
let launchClosed = false;

export function isClosedForLaunch(): boolean { return launchClosed; }
export function closeForLaunch(): void { launchClosed = true; }
/** Test seam: forget the per-launch latch. */
export function resetLaunchLatch(): void { launchClosed = false; }

interface ProviderRow { hasApiKey?: unknown }

/**
 * True when at least one provider carries a credential, false when none does,
 * and `null` when the answer is unknown — the proxy is not up yet, the
 * management API refused, or the payload was not the expected shape.
 *
 * A provider row with no key is not "configured": a fresh install can already
 * list catalogue entries, and treating those as setup would hide the wizard
 * from exactly the user it exists for.
 */
export async function hasConfiguredProvider(apiBase: string, signal?: AbortSignal): Promise<boolean | null> {
  try {
    const res = await fetch(`${apiBase}/api/providers`, { signal });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    const rows: unknown[] | null = Array.isArray(data)
      ? data
      : Array.isArray((data as { providers?: unknown })?.providers)
        ? (data as { providers: unknown[] }).providers
        : null;
    if (!rows) return null;
    return rows.some(row => !!row && typeof row === "object" && (row as ProviderRow).hasApiKey === true);
  } catch {
    return null;
  }
}

/**
 * The full decision. Resolves true only when the profile looks new *and* the
 * probe came back saying nothing is connected yet. Anything else — an existing
 * credential, a refused request, an abort, a broken payload — resolves false,
 * because the wizard must never be the reason a user cannot reach the app.
 */
export async function decideFirstRun(apiBase: string, signal?: AbortSignal): Promise<boolean> {
  if (!isFirstRunCandidate()) return false;
  const configured = await hasConfiguredProvider(apiBase, signal);
  if (configured === true) {
    // An upgrading user: remember it so the probe is not repeated every launch.
    // An explicit "show me again" is left alone rather than silently overruled.
    if (!readOnboarding()) completeOnboarding();
    return false;
  }
  return configured === false;
}
