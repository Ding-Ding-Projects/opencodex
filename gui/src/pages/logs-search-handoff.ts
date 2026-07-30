/**
 * Hand-off from the regex builder to the Logs search bar.
 *
 * The builder's "Use in search → Logs" button writes a record, then navigates to
 * `#logs`; the Logs screen claims it once on mount and seeds its own free-text
 * search row with the pattern. sessionStorage carries it rather than the URL so
 * the pattern never lands in browser history, and it survives the page swap the
 * hash change causes — a prop could not, because the two screens never coexist.
 *
 * The key is duplicated from `RegexBuilder.tsx`, which declares it module-private;
 * the two literals must stay in step until it is lifted into a shared module.
 */
export const SEARCH_HANDOFF_KEY = "ocx-m3:search-handoff";

export interface LogsSearchHandoff {
  /** Pattern to seed the Logs search field with. */
  pattern: string;
  /** Whether that field should evaluate the pattern as a regular expression. */
  regex: boolean;
}

/**
 * A record written by another screen is untrusted input as far as this one is
 * concerned: anything that is not a logs-addressed, non-empty pattern is ignored
 * rather than seeding the table with a filter the user cannot explain.
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
  return { pattern, regex: record.regex !== false };
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
