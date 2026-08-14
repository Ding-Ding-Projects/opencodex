/**
 * Toy locks — the enumerable list of every "Lock this element…" the user has
 * created, and the session/rate-limit state that decides whether a locked
 * surface currently needs an unlock prompt.
 *
 * ## What this is, said plainly, in the data model itself
 *
 * A lock here is a self-imposed speed bump on one appearance surface — an
 * element, a tab or a group, or a single appearance property on one of those.
 * It is not a security boundary: see `credential-vault.ts` for where the
 * credential actually lives and why, and every user-facing surface that reads
 * this module (the wizard, the unlock prompt, the Locks list) repeats the
 * disclosure in its own copy rather than relying on this comment alone.
 *
 * ## Two stores, two different sensitivities
 *
 * `LockRecord` — the *metadata* (what is locked, which method, how long an
 * unlock lasts) — lives in ordinary `localStorage` under `ocx-m3:locks`,
 * exactly like `revisions.ts`'s history and `prefs.ts`'s appearance settings.
 * It is safe to export, to snapshot into local version history, to search.
 * The credential itself never lives here — `credential-vault.ts` owns a
 * completely separate, never-exported bucket for that.
 *
 * ## Independent credentials, independent everything
 *
 * There is no master credential and no implicit inheritance anywhere in this
 * module. Every function here takes one `lockId` and acts on exactly that
 * lock: `isUnlocked` never asks "is anything unlocked", `verifyLock` never
 * checks a different lock's credential, and removing one lock never touches
 * another. A user who wants the same password on three locks gets there by
 * typing it three times in the wizard, never by the app assuming it once they
 * have typed it anywhere.
 */

import {
  hasCredential, removeCredential, storeCredential, verifyCredential,
  type CredentialInput,
} from "./credential-vault";
import { recordRevision } from "./revisions";

const LOCKS_KEY = "ocx-m3:locks";
/** Session-scoped unlocks for "close" and timed durations — see `unlock()`. */
const SESSIONS_KEY = "ocx-m3:lock-sessions";

export type LockKind = "element" | "tab" | "group";
export type LockMethod = "password" | "totp";

/**
 * How long an unlock lasts once granted.
 *
 *  - `"here"` — this surface only. Never written to any store; the caller
 *    (the unlock prompt) holds it as ordinary component state, so navigating
 *    away or reloading ends it. The truest reading of "this surface only".
 *  - `"close"` — until the app closes. Backed by `sessionStorage`, which the
 *    browser itself clears when the tab/window's session ends — the same
 *    lifetime the words describe, with no bespoke "is the app still open"
 *    bookkeeping required.
 *  - a `number` — that many minutes, also backed by `sessionStorage` but with
 *    a recorded expiry checked on every read.
 */
export type LockDuration = "here" | "close" | number;

export interface LockRecord {
  id: string;
  kind: LockKind;
  /** The element/tab/group id this lock targets — `ElementAppearanceHost`'s resolved id, or a tab/group id from `use-tabs.ts`. */
  targetId: string;
  /** Set only when this lock covers one appearance property rather than the whole target (e.g. `"color"`). Absent means the whole element/tab/group. */
  property?: string;
  /** A human-readable snapshot of what is locked, recorded at creation so the Locks list and history stay legible even if the target is later renamed or removed from view. */
  label: string;
  method: LockMethod;
  createdAt: number;
  /** The duration granted by default when this lock is unlocked from now on. The wizard sets it once; the unlock prompt may still choose a shorter one per-unlock. */
  duration: LockDuration;
  /** Locked again every time the app starts. True by default, per the contract. */
  lockedOnLaunch: boolean;
}

export interface CreateLockInput {
  kind: LockKind;
  targetId: string;
  property?: string;
  label: string;
  credential: CredentialInput;
  duration: LockDuration;
  lockedOnLaunch: boolean;
}

interface SessionEntry {
  /** `null` for `"close"` — no expiry, just "still within this browsing session". */
  expiresAt: number | null;
}

/** In-memory only, by design — see `LockDuration["here"]` above. Cleared by nothing but a reload, which is the point. */
const hereUnlocks = new Map<string, true>();

/** Wrong-attempt counters, in-memory only. A toy lock's rate limiting exists to slow down guessing, not to survive a reload as a punishment. */
interface AttemptState { count: number; lockedUntilMs: number }
const attempts = new Map<string, AttemptState>();

function readLocksRaw(): LockRecord[] {
  try {
    const raw = JSON.parse(localStorage.getItem(LOCKS_KEY) || "[]");
    return Array.isArray(raw) ? raw as LockRecord[] : [];
  } catch {
    return [];
  }
}

function writeLocksRaw(next: LockRecord[]): void {
  try {
    localStorage.setItem(LOCKS_KEY, JSON.stringify(next));
    window.dispatchEvent(new CustomEvent("ocx-locks"));
  } catch { /* quota — the caller's own action still completed */ }
}

function readSessions(): Record<string, SessionEntry> {
  try {
    const raw = JSON.parse(sessionStorage.getItem(SESSIONS_KEY) || "{}");
    return raw && typeof raw === "object" ? raw as Record<string, SessionEntry> : {};
  } catch {
    return {};
  }
}

function writeSessions(next: Record<string, SessionEntry>): void {
  try { sessionStorage.setItem(SESSIONS_KEY, JSON.stringify(next)); } catch { /* quota */ }
}

/** Every lock, newest first — the order the Locks list and search render in. */
export function readLocks(): LockRecord[] {
  return readLocksRaw().slice().sort((a, b) => b.createdAt - a.createdAt);
}

/** The one lock (if any) covering this exact target/property pair. `property` omitted matches only a whole-target lock, never a narrower property lock on the same target — the two are deliberately different locks with different answers, per the contract. */
export function findLock(kind: LockKind, targetId: string, property?: string): LockRecord | undefined {
  return readLocksRaw().find(lock => lock.kind === kind && lock.targetId === targetId && lock.property === property);
}

/** Every lock touching this target, whole-target or property-scoped — what the appearance editor needs to know "is anything about this thing locked at all". */
export function locksForTarget(kind: LockKind, targetId: string): LockRecord[] {
  return readLocksRaw().filter(lock => lock.kind === kind && lock.targetId === targetId);
}

function newLockId(): string {
  return `lk${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Creates a lock and stores its credential. Replaces any existing lock on the
 * exact same (kind, targetId, property) — the wizard's "change credential"
 * path is just calling this again, which is also why it is the one place that
 * writes to both stores and has to keep them from disagreeing: an error
 * storing the credential must never leave a lock record with no credential
 * behind it.
 */
export async function createLock(input: CreateLockInput): Promise<LockRecord> {
  const existing = findLock(input.kind, input.targetId, input.property);
  const record: LockRecord = {
    id: existing?.id ?? newLockId(),
    kind: input.kind,
    targetId: input.targetId,
    property: input.property,
    label: input.label,
    method: input.credential.method,
    createdAt: existing?.createdAt ?? Date.now(),
    duration: input.duration,
    lockedOnLaunch: input.lockedOnLaunch,
  };
  // Credential first: if this throws, no half-created lock record is written.
  await storeCredential(record.id, input.credential);
  const rest = readLocksRaw().filter(lock => lock.id !== record.id);
  writeLocksRaw([...rest, record]);
  attempts.delete(record.id);

  recordRevision({
    scope: "settings",
    label: record.label,
    summary: existing
      ? `Toy lock credential changed (${methodName(record.method)})`
      : `Toy lock created (${methodName(record.method)})`,
  });
  return record;
}

function methodName(method: LockMethod): string {
  return method === "password" ? "password" : "authenticator code";
}

/** Updates duration/lockedOnLaunch without touching the credential. */
export function updateLockSettings(id: string, patch: Partial<Pick<LockRecord, "duration" | "lockedOnLaunch">>): void {
  const locks = readLocksRaw();
  const index = locks.findIndex(lock => lock.id === id);
  if (index === -1) return;
  const next = { ...locks[index]!, ...patch };
  locks[index] = next;
  writeLocksRaw(locks);
  recordRevision({ scope: "settings", label: next.label, summary: "Toy lock settings changed" });
}

/** Removes a lock and its credential together. Never leaves a credential orphaned in the vault, and never leaves a lock record pointing at a wiped credential. */
export function removeLock(id: string): void {
  const locks = readLocksRaw();
  const found = locks.find(lock => lock.id === id);
  if (!found) return;
  writeLocksRaw(locks.filter(lock => lock.id !== id));
  removeCredential(id);
  clearSession(id);
  attempts.delete(id);
  recordRevision({ scope: "settings", label: found.label, summary: "Toy lock removed" });
}

/** Removes several locks in one call — the Locks list's bulk "Remove" action. Returns the ids that were actually found and removed, so the caller can report an honest count rather than assuming every selected id existed. */
export function removeLocks(ids: readonly string[]): string[] {
  const removed: string[] = [];
  for (const id of ids) {
    if (findLockById(id)) { removeLock(id); removed.push(id); }
  }
  return removed;
}

export function findLockById(id: string): LockRecord | undefined {
  return readLocksRaw().find(lock => lock.id === id);
}

export function subscribeLocks(listener: () => void): () => void {
  window.addEventListener("ocx-locks", listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener("ocx-locks", listener);
    window.removeEventListener("storage", listener);
  };
}

/* --------------------------------------------------------- session state -- */

function clearSession(id: string): void {
  hereUnlocks.delete(id);
  const sessions = readSessions();
  if (id in sessions) {
    delete sessions[id];
    writeSessions(sessions);
  }
}

/**
 * Grants an unlock for `duration`. Called only after `verifyLock` has already
 * returned true — this function itself performs no credential check, which is
 * what keeps "verify" and "grant" as two separately callable, separately
 * testable steps rather than one function that is both judge and door.
 */
export function grantUnlock(id: string, duration: LockDuration): void {
  if (duration === "here") {
    hereUnlocks.set(id, true);
    return;
  }
  const sessions = readSessions();
  sessions[id] = { expiresAt: duration === "close" ? null : Date.now() + duration * 60_000 };
  writeSessions(sessions);
}

/** Ends an unlock immediately — the explicit "Lock again" action every unlocked lock carries. */
export function relock(id: string): void {
  clearSession(id);
}

/** Whether `id` is currently unlocked, honouring an expired timed session as locked again. */
export function isUnlocked(id: string): boolean {
  if (hereUnlocks.has(id)) return true;
  const entry = readSessions()[id];
  if (!entry) return false;
  if (entry.expiresAt === null) return true;
  if (Date.now() < entry.expiresAt) return true;
  clearSession(id);
  return false;
}

/**
 * Applies "locked again on launch" to every lock that asks for it, by
 * dropping any session unlock that survived from `sessionStorage`. Exposed as
 * an explicit function — called once from the app shell's mount — rather than
 * a module-load side effect, so it is: (a) testable directly without faking a
 * fresh module import, and (b) not silently re-run by every hot reload during
 * development, which would relock a lock the developer just unlocked to keep
 * working.
 *
 * `"here"` unlocks are never touched: they live only in memory and cannot
 * have survived a relaunch in the first place.
 */
export function applyLockedOnLaunch(): void {
  const sessions = readSessions();
  let changed = false;
  for (const lock of readLocksRaw()) {
    if (lock.lockedOnLaunch && lock.id in sessions) {
      delete sessions[lock.id];
      changed = true;
    }
  }
  if (changed) writeSessions(sessions);
}

/* ------------------------------------------------------------ rate limit -- */

/** 3 free tries, then a wait that grows with each further wrong attempt, capped at 30s — enough friction to be honestly called "rate limiting" without ever pretending to be a lockout. */
const FREE_ATTEMPTS = 3;
const BACKOFF_STEP_MS = 4_000;
const BACKOFF_CAP_MS = 30_000;

export function rateLimitState(id: string, nowMs: number = Date.now()): { limited: boolean; waitMs: number } {
  const state = attempts.get(id);
  if (!state) return { limited: false, waitMs: 0 };
  const remaining = state.lockedUntilMs - nowMs;
  return remaining > 0 ? { limited: true, waitMs: remaining } : { limited: false, waitMs: 0 };
}

function recordWrongAttempt(id: string, nowMs: number): void {
  const state = attempts.get(id) ?? { count: 0, lockedUntilMs: 0 };
  state.count += 1;
  // The FREE_ATTEMPTS-th wrong attempt is itself what trips the limiter — not
  // the one after it — so that the very next attempt (attempt #4, of any
  // credential) is the one that comes back rate-limited, matching "the first
  // three are free, the fourth is limited" rather than "the first four are
  // free, the fifth is limited".
  if (state.count >= FREE_ATTEMPTS) {
    const backoff = Math.min((state.count - FREE_ATTEMPTS + 1) * BACKOFF_STEP_MS, BACKOFF_CAP_MS);
    state.lockedUntilMs = nowMs + backoff;
  }
  attempts.set(id, state);
}

/**
 * Checks the credential, records the outcome for rate limiting, and — only on
 * success — grants the unlock. One function rather than three separately
 * callable steps: a caller that checked and granted separately could grant an
 * unlock without ever recording a wrong attempt for the tries that preceded
 * it, which is exactly the gap a brute-force script would use.
 *
 * Returns `"ok"`, `"wrong"`, or `"rate-limited"` (the credential is not even
 * checked while rate-limited, so a limited caller cannot learn anything about
 * whether a guess would have been right).
 */
export async function attemptUnlock(
  id: string,
  input: { password?: string; code?: string },
  duration: LockDuration,
  nowMs: number = Date.now(),
): Promise<"ok" | "wrong" | "rate-limited"> {
  const limit = rateLimitState(id, nowMs);
  if (limit.limited) return "rate-limited";
  const ok = await verifyCredential(id, input, nowMs);
  if (!ok) {
    recordWrongAttempt(id, nowMs);
    return "wrong";
  }
  attempts.delete(id);
  grantUnlock(id, duration);
  return "ok";
}

/** Whether `id` currently has a stored credential — a lock record with none is a data inconsistency the UI should treat as "not actually locked" rather than crash on. */
export function lockHasCredential(id: string): boolean {
  return hasCredential(id);
}
