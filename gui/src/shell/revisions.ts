/**
 * Append-only revision log behind the Version history screen.
 *
 * Append-only is the whole point: a restore is itself recorded as a new
 * revision, so an undo can be undone. Nothing is ever mutated or removed except
 * by the explicit "clear" action, and the cap drops the *oldest* entries.
 */

const KEY = "ocx-m3:revisions";
const CAP = 500;

export type RevisionScope = "provider" | "account" | "key" | "combo" | "settings";

export interface Revision {
  id: string;
  scope: RevisionScope;
  /** What changed, e.g. a provider name or "Appearance". */
  label: string;
  /** Human-readable description of the change. */
  summary: string;
  at: number;
  /** Serialized prior value, when the caller can supply one for restore. */
  before?: string;
  /** True when this entry was itself produced by restoring an earlier revision. */
  restored?: boolean;
}

export function readRevisions(): Revision[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

/** Append one revision. Returns the stored entry so callers can reference its id. */
export function recordRevision(input: Omit<Revision, "id" | "at">): Revision {
  const entry: Revision = { ...input, id: `r${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, at: Date.now() };
  try {
    const next = [entry, ...readRevisions()].slice(0, CAP);
    localStorage.setItem(KEY, JSON.stringify(next));
    window.dispatchEvent(new CustomEvent("ocx-revisions"));
  } catch { /* quota — the UI action itself still succeeded */ }
  return entry;
}

export function clearRevisions(): void {
  try {
    localStorage.removeItem(KEY);
    window.dispatchEvent(new CustomEvent("ocx-revisions"));
  } catch { /* ignore */ }
}

/**
 * Subscribe to the log.
 *
 * `recordRevision` fires `ocx-revisions` in this tab; `storage` covers another
 * tab writing the same key. Both matter: the Version history screen is usually
 * open *while* the change is made somewhere else, and a history that only updates
 * on reload is a history nobody trusts.
 *
 * Returns an unsubscribe function, so callers can hand it straight to `useEffect`.
 */
export function subscribeRevisions(listener: () => void): () => void {
  window.addEventListener("ocx-revisions", listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener("ocx-revisions", listener);
    window.removeEventListener("storage", listener);
  };
}
