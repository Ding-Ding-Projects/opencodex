/**
 * The renderer's half of School Mode: a module-level singleton mirroring the
 * shared, cross-app record the server owns (`src/school-mode/store.ts`), the
 * same shape `personal-vocabulary.ts` uses for its own module-level store —
 * subscribable state plus a synchronous accessor pure modules with no React
 * in their dependency graph can call directly.
 *
 * ## Why this is not localStorage, and why that matters for `isSchoolModeActive`
 *
 * Personal vocabulary lives in `localStorage` because it is genuinely
 * per-browser-profile data. School Mode is the opposite: the contract is
 * explicit that "one toggle, every app, at the same moment" — turning it on
 * in one conforming app has to turn it on in every other one, live, with no
 * restart. That can only be true of a record this renderer does not own, so
 * this module is a *client* of the server's shared file, not an owner of its
 * own copy of the truth.
 *
 * ## "Live" here means two things working together
 *
 * The server watches the shared file with `fs.watch` so an edit from another
 * process — this app's own second window, its CLI, an entirely different
 * conforming app — is picked up without a restart. This module closes the
 * other half: it polls `GET /api/school-mode` on a short interval so *this*
 * renderer's own idea of the state catches up to a server-side change within
 * a second or two, without the user doing anything. Neither half alone
 * satisfies the contract — a watcher nobody asks and a poll with nothing
 * fresh to read are both dead ends — so both exist.
 *
 * A fetch/poll loop necessarily has a startup window before the first
 * response lands, during which `isSchoolModeActive()` reads the safe default
 * (`false`). This is the same bootstrapping latency any client-fetched
 * setting has; `startSchoolModeSync()` — called once, from `App.tsx`,
 * alongside `configureSchoolModeApiBase` — starts the loop as early as the
 * real app boots, which keeps the window as small as it can be without
 * blocking first paint on a network round trip.
 *
 * ## Reading never starts the loop — only `startSchoolModeSync()` does
 *
 * `isSchoolModeActive()` is called from `resolve.ts`'s `translate()`, which
 * runs on essentially every render of every page. An earlier version of this
 * module started polling as a side effect of that first read — the same lazy
 * pattern `personal-vocabulary.ts` uses for its (synchronous, local)
 * hydration — which meant *every* test in this app's suite that rendered any
 * translated text, including ones with nothing to do with School Mode, began
 * a real (failing, in a test environment with no server) fetch and left a
 * 1.5-second interval running for the rest of the test process. Reading is
 * now a plain cache lookup with no side effect at all; only `App.tsx` — the
 * real app's actual entry point — ever calls `startSchoolModeSync()`. A test
 * that wants live polling behavior opts in explicitly by calling it itself.
 *
 * ## Never reading or watching — the honesty rule
 *
 * When the server itself cannot be reached, or when it reports the shared
 * record as unreadable or unwatchable, that is surfaced on `state` rather
 * than silently treated as "off". `LanguageVoice.tsx`'s School Mode card is
 * what turns `fetchError`/`recordReadable`/`recordWatchable` into the copy
 * the control shows, per "if the shared record cannot be read or watched,
 * say so on the control rather than silently behaving as though the mode
 * were off."
 */

export {
  SCHOOL_MODE_MAX_NAME_LENGTH,
  SCHOOL_MODE_MAX_SECRET_LENGTH,
  SCHOOL_MODE_MIN_SECRET_LENGTH,
  validateSchoolModeName,
  validateSchoolModeSecret,
  type SchoolModeSecretValidation,
} from "../../../src/school-mode/contract";

export interface SchoolModeState {
  readonly enabled: boolean;
  readonly hasCustomName: boolean;
  readonly customName: string | null;
  readonly hasCredential: boolean;
  readonly updatedAt: number;
  readonly recordReadable: boolean;
  readonly readError?: string;
  readonly recordWatchable: boolean;
  readonly watchError?: string;
  /** The folder a user can delete by hand to reset the mode — shown verbatim, per the toy-lock contract. */
  readonly recordDir: string;
  /** True once at least one fetch has completed (success or failure). */
  readonly loaded: boolean;
  /** Set when the most recent request to *this app's own server* failed — distinct from `recordReadable`, which is about the shared file once the server was reached. */
  readonly fetchError?: string;
}

export const SCHOOL_MODE_DEFAULT_STATE: SchoolModeState = {
  enabled: false,
  hasCustomName: false,
  customName: null,
  hasCredential: false,
  updatedAt: 0,
  recordReadable: true,
  recordWatchable: false,
  recordDir: "",
  loaded: false,
};

let apiBase = "";
/**
 * Called once from `App.tsx`, mirroring `configureNarrator`'s `apiBase`
 * wiring — and, unlike that one, also what starts the sync loop for the
 * real app. See the module doc comment for why starting is not a side
 * effect of an ordinary read.
 */
export function configureSchoolModeApiBase(base: string): void {
  apiBase = base;
}

const POLL_MS = 1500;

let state: SchoolModeState = SCHOOL_MODE_DEFAULT_STATE;
let started = false;
let pollTimer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();

function setState(next: SchoolModeState): void {
  state = next;
  for (const listener of listeners) listener();
}

function readResponsePayload(data: unknown): SchoolModeState {
  const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  return {
    enabled: d.enabled === true,
    hasCustomName: d.hasCustomName === true,
    customName: typeof d.customName === "string" ? d.customName : null,
    hasCredential: d.hasCredential === true,
    updatedAt: typeof d.updatedAt === "number" ? d.updatedAt : 0,
    recordReadable: d.recordReadable !== false,
    readError: typeof d.readError === "string" ? d.readError : undefined,
    recordWatchable: d.recordWatchable === true,
    watchError: typeof d.watchError === "string" ? d.watchError : undefined,
    recordDir: typeof d.recordDir === "string" ? d.recordDir : "",
    loaded: true,
    fetchError: undefined,
  };
}

async function refresh(): Promise<void> {
  try {
    const res = await fetch(`${apiBase}/api/school-mode`, { cache: "no-store" });
    if (!res.ok) {
      setState({ ...state, loaded: true, fetchError: `School Mode status request failed (HTTP ${res.status})` });
      return;
    }
    setState(readResponsePayload(await res.json()));
  } catch (error) {
    setState({ ...state, loaded: true, fetchError: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Begin watching the shared record: an immediate fetch, then one every
 * `POLL_MS`. Idempotent — safe to call more than once (`App.tsx` calls it
 * from `configureSchoolModeApiBase`, and a test that wants live behavior may
 * call it again after `resetSchoolModeClientForTests()`).
 */
export function startSchoolModeSync(): void {
  if (started) return;
  started = true;
  void refresh();
  pollTimer = setInterval(() => void refresh(), POLL_MS);
}

/**
 * Stop watching the shared record.
 *
 * Paired with `startSchoolModeSync()` from the mounted app's own effect, so the
 * interval lives exactly as long as the app does. It deliberately leaves the
 * last known state in place: unmounting the tree is not evidence the mode
 * changed, and a reader that survives the unmount should keep the last honest
 * answer rather than silently collapsing to "off".
 */
export function stopSchoolModeSync(): void {
  if (pollTimer !== undefined) clearInterval(pollTimer);
  pollTimer = undefined;
  started = false;
}

/** Test-only: stop polling and reset to the default state between test cases. */
export function resetSchoolModeClientForTests(): void {
  if (pollTimer !== undefined) clearInterval(pollTimer);
  pollTimer = undefined;
  started = false;
  state = SCHOOL_MODE_DEFAULT_STATE;
  listeners.clear();
}

/**
 * Test-only: set the in-memory state directly, bypassing the network. What
 * lets a suite exercise `isSchoolModeActive()`'s effect on `resolve.ts`, the
 * settings registry and the command palette without standing up a fake
 * server or waiting on a real fetch — those modules only ever read this same
 * module-level `state`, so writing it directly is exactly what a real
 * successful `GET /api/school-mode` would have done.
 */
export function setSchoolModeStateForTests(patch: Partial<SchoolModeState>): void {
  setState({ ...state, ...patch });
}

/**
 * The one synchronous read every pure module (`resolve.ts`, the settings
 * registry, the command palette) consults. A plain cache lookup with no side
 * effect — see the module doc comment for why triggering the network loop
 * from here was tried and reverted.
 */
export function isSchoolModeActive(): boolean {
  return state.enabled;
}

export function getSchoolModeSnapshot(): SchoolModeState {
  return state;
}

/**
 * Neither this nor either read above starts the sync loop — a component
 * that renders the School Mode card in a focused unit test (outside
 * `App.tsx`, which is the only real caller of `startSchoolModeSync()`) sees
 * the honest "not loaded yet" state rather than triggering a network call
 * the test never asked for.
 */
export function subscribeSchoolMode(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/* ------------------------------------------------------------- actions -- */

export interface SchoolModeActionResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly message?: string;
}

async function post(path: string, body?: unknown): Promise<SchoolModeActionResult> {
  try {
    const res = await fetch(`${apiBase}${path}`, {
      method: "POST",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (res.ok) {
      setState(readResponsePayload(data));
      return { ok: true };
    }
    return {
      ok: false,
      error: typeof data.error === "string" ? data.error : undefined,
      message: typeof data.message === "string" ? data.message : `Request failed (HTTP ${res.status})`,
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** Refused by the server until a credential exists — see the route's own doc comment. */
export function enableSchoolMode(): Promise<SchoolModeActionResult> {
  return post("/api/school-mode/enable");
}

export function disableSchoolMode(secret: string): Promise<SchoolModeActionResult> {
  return post("/api/school-mode/disable", { secret });
}

export function setSchoolModeCredential(newSecret: string, currentSecret?: string): Promise<SchoolModeActionResult> {
  return post("/api/school-mode/credential", { newSecret, currentSecret });
}

export function renameSchoolMode(name: string | null): Promise<SchoolModeActionResult> {
  return post("/api/school-mode/rename", { name });
}
