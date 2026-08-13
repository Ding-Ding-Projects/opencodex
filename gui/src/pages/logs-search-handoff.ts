/**
 * Hand-off from the regex builder to the Logs search bar.
 *
 * The builder's "Use in search → Logs" button writes a record, then navigates to
 * `#logs`; the Logs screen claims it once on mount and seeds its own free-text
 * search row with the pattern. sessionStorage carries it rather than the URL so
 * the pattern never lands in browser history, and it survives the page swap the
 * hash change causes — a prop could not, because the two screens never coexist.
 *
 * Both ends of the hand-off live here now. The key used to be declared a second
 * time, module-private, inside `RegexBuilder.tsx`, with a comment on each copy
 * asking the other to stay in step — and the record shape was duplicated with
 * it, which is how the writer came to send a field the reader never read. One
 * module owning the key, the shape and the validation is what makes that class
 * of drift impossible rather than merely discouraged.
 */

import { DEFAULT_SEARCH_FLAGS } from "../shell/settings-search";

export const SEARCH_HANDOFF_KEY = "ocx-m3:search-handoff";

/**
 * Every flag an ECMAScript `RegExp` accepts, including the two the builder does
 * not offer (`d` for match indices, `v` for the extended character-class set).
 * A record is not required to have come from the builder's own chip row, so the
 * gate is "is this a real flags string" rather than "is this one of ours".
 */
const REGEXP_FLAG_CHARS = "dgimsuvy";

/**
 * No flag may repeat, so the longest legitimate string is one of each. The cap
 * exists because the string is fed to `new RegExp`, and an unbounded field out
 * of storage is exactly the shape that should never reach a compiler.
 */
export const SEARCH_FLAGS_CAP = REGEXP_FLAG_CHARS.length;

export interface LogsSearchHandoff {
  /** Pattern to seed the Logs search field with. */
  pattern: string;
  /** Whether that field should evaluate the pattern as a regular expression. */
  regex: boolean;
  /**
   * The flags the pattern was built with, so the receiving field compiles the
   * regex the user actually composed rather than a fixed `"i"`.
   *
   * Always present once parsed — a record that carried none has already been
   * given the receiving field's default — but `""` and "absent" are different
   * statements in the stored record and are kept apart there. `""` is a real
   * answer, "case-sensitive and `.` stops at a line break", and is precisely the
   * choice this field used to throw away.
   */
  flags: string;
}

/**
 * Validate a flags string out of storage.
 *
 * Returns the string when it is usable and `null` when it is not — deliberately
 * distinct from `""`, which is a perfectly good flags string and the one this
 * whole change exists to deliver intact. A caller therefore has to use `??` and
 * not `||` when supplying its fallback; `||` would turn "the user chose no
 * flags" back into "the default", which is the original defect wearing a hat.
 *
 * Anything unrecognised is rejected whole rather than filtered down to the
 * characters that happened to be valid. A half-honoured flags string compiles
 * successfully and searches under rules nobody chose, which is worse than
 * falling back to a documented default the affordance then shows the user.
 */
export function sanitizeSearchFlags(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (raw.length > SEARCH_FLAGS_CAP) return null;
  const seen = new Set<string>();
  for (const ch of raw) {
    if (!REGEXP_FLAG_CHARS.includes(ch)) return null;
    // `new RegExp("a", "ii")` throws, so a duplicate is not merely redundant.
    if (seen.has(ch)) return null;
    seen.add(ch);
  }
  return raw;
}

/**
 * A record written by another screen is untrusted input as far as this one is
 * concerned: anything that is not a logs-addressed, non-empty pattern is ignored
 * rather than seeding the table with a filter the user cannot explain.
 *
 * A missing `flags` is not an error. A record written by an earlier build is
 * still sitting in `sessionStorage` on any machine that navigated to the builder
 * before this change and closed the tab mid-hand-off, and refusing it would turn
 * a version skew into a search bar that silently ignores the button the user
 * just pressed. Absent means "the default this field has always compiled";
 * present-but-invalid means the same, because there is no honest way to guess
 * what a malformed string intended.
 */
function parseHandoff(raw: string): LogsSearchHandoff | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.page !== "logs") return null;
  const pattern = typeof record.pattern === "string" ? record.pattern : "";
  if (!pattern) return null;
  const flags = record.flags === undefined
    ? DEFAULT_SEARCH_FLAGS
    : sanitizeSearchFlags(record.flags) ?? DEFAULT_SEARCH_FLAGS;
  return { pattern, regex: record.regex !== false, flags };
}

/**
 * Stash a pattern for the Logs search bar and let the caller navigate.
 *
 * Storage refusal is swallowed on purpose: the builder's snackbar repeats the
 * pattern and its flags, so a private-mode session degrades to the user copying
 * a literal they can already read rather than to an error about a mechanism
 * they never asked about.
 */
export function writeLogsSearchHandoff(pattern: string, flags: string): void {
  const safe = sanitizeSearchFlags(flags);
  // A flags string the writer cannot vouch for is left out of the record
  // altogether rather than sent as `""`. Omitted means "use your default", which
  // the reader already handles; `""` is a claim that the user chose no flags,
  // and inventing that claim out of a value that failed validation would put a
  // setting nobody made in front of them.
  const handoff = { page: "logs", pattern, regex: true, ...(safe === null ? {} : { flags: safe }) };
  try {
    sessionStorage.setItem(SEARCH_HANDOFF_KEY, JSON.stringify(handoff));
  } catch {
    /* storage refused (private mode, disabled): the snackbar still carries it */
  }
}

/**
 * Read and delete the pending hand-off. It is one-shot on purpose: a stored
 * pattern that outlived its navigation would silently re-filter the table on
 * every later visit to Logs, and the user would have no way to tell where the
 * filter came from.
 */
export function consumeLogsSearchHandoff(): LogsSearchHandoff | null {
  try {
    const raw = sessionStorage.getItem(SEARCH_HANDOFF_KEY);
    if (raw === null) return null;
    const handoff = parseHandoff(raw);
    // Only a record this screen actually claims is deleted. A pattern addressed
    // to another search bar has to survive Logs being visited on the way there.
    if (handoff) sessionStorage.removeItem(SEARCH_HANDOFF_KEY);
    return handoff;
  } catch {
    // Storage refused (private mode, disabled, or no session storage at all).
    // The builder's snackbar already carried the pattern, so there is nothing
    // to recover and nothing to report here.
    return null;
  }
}
