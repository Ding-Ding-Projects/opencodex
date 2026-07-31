/**
 * The picker's recent-colour strip.
 *
 * Kept out of `Prefs` deliberately. Recents are a convenience the user never
 * chose, and folding them into the appearance preferences would mean "reset
 * appearance" wiped a list that is not part of the appearance, while every
 * exported theme carried a log of the colours its author had been trying.
 *
 * Values are stored as the CSS strings `toCssValue` produced, not as hex, so a
 * wide-gamut `oklch()` the user picked comes back as the colour they picked
 * rather than its sRGB clip.
 */

const KEY = "ocx-m3:recent-colors";
const LIMIT = 12;

/** Guards against a hand-edited entry becoming an unbounded string in a style attribute. */
const MAX_LENGTH = 64;

export function readRecentColors(storage?: Pick<Storage, "getItem">): string[] {
  try {
    const raw: unknown = JSON.parse((storage ?? localStorage).getItem(KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= MAX_LENGTH)
      .slice(0, LIMIT);
  } catch {
    return [];
  }
}

/**
 * Record a colour and return the new list.
 *
 * Returns rather than mutating in place so a caller can drive React state from
 * it without a second read that might disagree with what was just written.
 */
export function pushRecentColor(value: string, storage?: Pick<Storage, "getItem" | "setItem">): string[] {
  const trimmed = String(value ?? "").trim();
  if (!trimmed || trimmed.length > MAX_LENGTH) return readRecentColors(storage);
  const next = [trimmed, ...readRecentColors(storage).filter(v => v !== trimmed)].slice(0, LIMIT);
  try {
    (storage ?? localStorage).setItem(KEY, JSON.stringify(next));
  } catch {
    /* quota — the list is a convenience, never a reason to fail a colour change */
  }
  return next;
}
