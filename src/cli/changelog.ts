/**
 * `ocx changelog` — headless equivalent of the dashboard's Changelog screen.
 *
 * Reads the packaged CHANGELOG.md directly rather than going through
 * `/api/changelog`, so it works with no proxy running and stays offline. The
 * parser is shared with the management route, so the CLI and the GUI can never
 * disagree about what a release contained.
 *
 * Filters mirror the screen exactly: an ISO date range and a text search that
 * composes with it, with regex as an explicit opt-in rather than the default.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseChangelog, type ChangelogRelease } from "../server/management/changelog-routes";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function usage(): void {
  console.log(
    "Usage: ocx changelog [--from <YYYY-MM-DD>] [--to <YYYY-MM-DD>]\n"
    + "                     [--search <text>] [--regex] [--limit <n>] [--json]\n\n"
    + "Show released versions and their changes.\n\n"
    + "  --from, --to   Restrict to a date range (inclusive).\n"
    + "  --search       Match release notes. Plain text unless --regex is given.\n"
    + "  --regex        Treat --search as a JavaScript regular expression.\n"
    + "  --limit        Show at most n releases (default: 20, 0 for all).\n"
    + "  --json         Emit JSON instead of formatted text.",
  );
}

function changelogPath(): string | null {
  const candidates = [
    join(import.meta.dir, "..", "..", "CHANGELOG.md"),
    join(import.meta.dir, "..", "..", "..", "CHANGELOG.md"),
  ];
  return candidates.find(existsSync) ?? null;
}

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const value = index === -1 ? undefined : args[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function isCalendarDate(value: string): boolean {
  if (!ISO.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export async function handleChangelogCommand(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return 0;
  }

  const json = args.includes("--json");
  const useRegex = args.includes("--regex");
  const from = flagValue(args, "--from") ?? "";
  const to = flagValue(args, "--to") ?? "";
  const search = flagValue(args, "--search") ?? "";
  const rawLimit = flagValue(args, "--limit");
  const limit = rawLimit === undefined ? 20 : Number(rawLimit);

  for (const [flag, value] of [["--from", from], ["--to", to]] as const) {
    if (args.includes(flag) && !value) {
      console.error(`ocx changelog: ${flag} requires a value in YYYY-MM-DD format.`);
      return 2;
    }
    if (value && !isCalendarDate(value)) {
      console.error(`ocx changelog: ${flag} expects YYYY-MM-DD, got "${value}".`);
      return 2;
    }
  }
  if (args.includes("--search") && !search) {
    console.error("ocx changelog: --search requires a text value.");
    return 2;
  }
  if (!Number.isInteger(limit) || limit < 0) {
    console.error(`ocx changelog: --limit expects a non-negative integer, got "${rawLimit}".`);
    return 2;
  }

  const path = changelogPath();
  if (!path) {
    // Same contract as the route: an absent changelog is an empty result that
    // explains itself, not an error the caller has to interpret.
    if (json) console.log(JSON.stringify({ available: false, releases: [] }, null, 2));
    else console.error("ocx changelog: no CHANGELOG.md is packaged with this build.\n  Generate one: bun scripts/generate-changelog.ts");
    return json ? 0 : 1;
  }

  let releases: ChangelogRelease[];
  try {
    releases = parseChangelog(readFileSync(path, "utf8"));
  } catch (error) {
    console.error(`ocx changelog: could not read the changelog (${error instanceof Error ? error.message : String(error)}).`);
    return 1;
  }

  let matches: (text: string) => boolean = () => true;
  if (search) {
    if (useRegex) {
      try {
        const re = new RegExp(search, "i");
        matches = text => re.test(text);
      } catch (error) {
        console.error(`ocx changelog: invalid --search pattern (${error instanceof Error ? error.message : String(error)}).`);
        return 2;
      }
    } else {
      const needle = search.toLowerCase();
      matches = text => text.toLowerCase().includes(needle);
    }
  }

  const filtered = releases
    .filter(r => (!from || (r.date ?? "") >= from) && (!to || (r.date ?? "") <= to))
    .map(r => ({ ...r, entries: search ? r.entries.filter(matches) : r.entries }))
    .filter(r => !search || r.entries.length > 0 || matches(r.version));

  const shown = limit === 0 ? filtered : filtered.slice(0, limit);

  if (json) {
    console.log(JSON.stringify({ available: true, releases: shown, total: filtered.length }, null, 2));
    return 0;
  }

  if (shown.length === 0) {
    console.log("No releases match.");
    return 0;
  }

  for (const release of shown) {
    console.log(`\n${release.version}${release.date ? `  ${release.date}` : ""}`);
    for (const entry of release.entries) console.log(`  - ${entry}`);
  }
  if (filtered.length > shown.length) {
    console.log(`\n… ${filtered.length - shown.length} more. Use --limit 0 to show all.`);
  }
  return 0;
}
