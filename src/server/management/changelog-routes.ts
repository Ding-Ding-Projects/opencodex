/**
 * GET /api/changelog — the packaged CHANGELOG.md, parsed into release records.
 *
 * The dashboard must open offline, so the Changelog screen reads this instead of
 * calling the GitHub releases API at view time. The file ships in the npm
 * tarball; when it is missing (a source checkout that never ran the generator)
 * the route answers `{ releases: [] }` with `available: false` so the screen can
 * say why it is empty rather than looking broken.
 *
 * Response shape is scalar text only — no paths, no tokens, no identifiers.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";

export interface ChangelogRelease {
  version: string;
  /** ISO `YYYY-MM-DD`, or null when the heading carried no date. */
  date: string | null;
  entries: string[];
}

/** `## 2.7.42 — 2026-07-28` (em dash or hyphen; the date is optional). */
const HEADING = /^##\s+(?<version>[^\s—-]+)\s*(?:[—-]\s*(?<date>\d{4}-\d{2}-\d{2}))?\s*$/;

export function parseChangelog(markdown: string): ChangelogRelease[] {
  const releases: ChangelogRelease[] = [];
  let current: ChangelogRelease | null = null;

  for (const line of markdown.split(/\r?\n/)) {
    const heading = HEADING.exec(line);
    if (heading?.groups) {
      current = { version: heading.groups.version, date: heading.groups.date ?? null, entries: [] };
      releases.push(current);
      continue;
    }
    if (!current) continue;
    const entry = /^[-*]\s+(.+)$/.exec(line);
    if (entry) current.entries.push(entry[1].trim());
  }
  return releases;
}

function changelogPath(): string | null {
  const packagedPath = join(import.meta.dir, "..", "..", "..", "CHANGELOG.md");
  return existsSync(packagedPath) ? packagedPath : null;
}

/**
 * The packaged releases, or an empty list when the file did not ship.
 *
 * Exported so the export registry answers from the same parse as this route.
 * Two parses of one file is two answers to "what shipped in 2.7.42", and the
 * heading grammar above is fiddly enough that the second copy would be the
 * wrong one.
 */
export function loadChangelogReleases(): ChangelogRelease[] {
  const path = changelogPath();
  return path ? parseChangelog(readFileSync(path, "utf-8")) : [];
}

export async function handleChangelogRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config } = ctx;
  if (url.pathname !== "/api/changelog" || req.method !== "GET") return null;

  const path = changelogPath();
  if (!path) return jsonResponse({ available: false, releases: [] }, 200, req, config);

  try {
    return jsonResponse(
      { available: true, releases: parseChangelog(readFileSync(path, "utf8")) },
      200,
      req,
      config,
    );
  } catch {
    // An unreadable file is an empty changelog, not a 500 that breaks the page.
    return jsonResponse({ available: false, releases: [] }, 200, req, config);
  }
}
