import type { Locale } from "./i18n/shared";
import { formatBytes } from "./format-bytes";

/** "45s", "3m 12s", "1h 04m" — never more than two units, so a long transfer's ETA stays scannable. */
export function formatEtaSeconds(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  if (minutes < 60) return `${minutes}m ${String(secs).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${String(mins).padStart(2, "0")}m`;
}

/** e.g. "1.4 MB/s". */
export function formatRate(bytesPerSec: number, locale: Locale): string {
  return `${formatBytes(bytesPerSec, locale)}/s`;
}
