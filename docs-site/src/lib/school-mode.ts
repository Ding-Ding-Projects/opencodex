/** Browser-local School-mode equivalent for the documentation surface. */

export const SCHOOL_MODE_STORAGE_KEY = "ocx-docs:school-mode:v1";

let active = false;
let hydrated = false;
const listeners = new Set<() => void>();

function readStorage(): boolean {
  try { return typeof localStorage !== "undefined" && localStorage.getItem(SCHOOL_MODE_STORAGE_KEY) === "1"; }
  catch { return false; }
}

function ensureHydrated(): void {
  if (!hydrated) { hydrated = true; active = readStorage(); }
}

function notify(): void { for (const listener of listeners) listener(); }

export function isSchoolModeActive(): boolean { ensureHydrated(); return active; }
export function subscribeSchoolMode(listener: () => void): () => void {
  ensureHydrated();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setSchoolModeActive(next: boolean): void {
  ensureHydrated();
  active = next;
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(SCHOOL_MODE_STORAGE_KEY, next ? "1" : "0");
  } catch { /* browser storage may be unavailable; the current page still changes */ }
  notify();
}

export function syncSchoolModeFromStorage(): void {
  ensureHydrated();
  const next = readStorage();
  if (next !== active) { active = next; notify(); }
}

export function resetSchoolModeForTests(): void {
  active = false;
  hydrated = false;
  listeners.clear();
}
