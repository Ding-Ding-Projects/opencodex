/**
 * Carries a detected source path from the Converter page into the page that
 * actually owns its adapter (today, only PDF Tools) via a hash query
 * parameter — the same one-shot pattern `mobile-pairing.ts` uses for its
 * pairing token: read once, strip from the URL immediately (a screenshot or
 * "share this page" should not leak a local file path), then act on the
 * in-memory value.
 */
import { hashRouteParams, hashRoutePath } from "../app-routing";
import { navigateHash, normalizeHashPath, replaceHash } from "../hash-routing";

/** Build the hash the Converter page navigates to when handing a detected PDF off to PDF Tools. */
export function pdfToolsHandoffHash(sourcePath: string): string {
  return `pdf?source=${encodeURIComponent(sourcePath)}`;
}

/** Deep-link into a page, carrying `sourcePath` as `?source=`. */
export function navigateWithSource(page: string, sourcePath: string): void {
  navigateHash(`${page}?source=${encodeURIComponent(sourcePath)}`);
}

let sourceTaken = false;

/**
 * Read the `?source=` param out of the current hash and remove it, once per
 * page load. A page that owns an adapter (PDF Tools today) calls this on
 * mount to prefill its own source field when it was opened from the
 * converter's catalogue rather than typed into directly.
 */
export function takeHandoffSourceFromUrl(): string | null {
  if (sourceTaken) return null;
  sourceTaken = true;
  try {
    const raw = normalizeHashPath(window.location.hash);
    const source = hashRouteParams(raw).get("source");
    if (!source) return null;
    replaceHash(hashRoutePath(raw));
    return source;
  } catch {
    return null;
  }
}

/** Test-only: allow a fresh read within one test file's lifetime. */
export function resetHandoffSourceGuardForTests(): void {
  sourceTaken = false;
}
