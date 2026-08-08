/** Formatting for the app-bar cost meter, separate from the component so Fast Refresh keeps working. */

/** Sub-cent lifetime totals still deserve digits; big totals stay compact. */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value >= 1000) return `$${Math.round(value).toLocaleString("en-US")}`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(3)}`;
}
