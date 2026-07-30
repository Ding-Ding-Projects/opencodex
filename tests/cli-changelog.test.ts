import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { handleChangelogCommand } from "../src/cli/changelog";
import { parseChangelog } from "../src/server/management/changelog-routes";

/**
 * `ocx changelog` is the headless half of the dashboard's Changelog screen, so
 * the two must not drift: both read the same CHANGELOG.md through the same
 * parser, and the CLI's filters mirror the screen's (ISO date range, text search
 * composed with it, regex only as an explicit opt-in).
 */

const SAMPLE = [
  "# Changelog",
  "",
  "## 2.7.42 — 2026-07-28",
  "",
  "- fix(codex): report catalog and cache write signals",
  "- fix(gui): keep the account chip populated",
  "",
  "## 2.7.41 — 2026-06-01",
  "",
  "- feat(cli): add a thing",
  "",
  "## 2.7.40",
  "",
  "- chore: undated release",
  "",
].join("\n");

describe("changelog parser", () => {
  test("reads version, ISO date and bullet entries", () => {
    const releases = parseChangelog(SAMPLE);
    expect(releases.map(r => r.version)).toEqual(["2.7.42", "2.7.41", "2.7.40"]);
    expect(releases[0].date).toBe("2026-07-28");
    expect(releases[0].entries).toEqual([
      "fix(codex): report catalog and cache write signals",
      "fix(gui): keep the account chip populated",
    ]);
  });

  test("a heading without a date parses with a null date rather than being dropped", () => {
    const releases = parseChangelog(SAMPLE);
    const undated = releases.find(r => r.version === "2.7.40");
    expect(undated?.date).toBeNull();
    expect(undated?.entries).toEqual(["chore: undated release"]);
  });

  test("bullets before the first heading are ignored, not attributed to a release", () => {
    const releases = parseChangelog("- orphan bullet\n\n## 1.0.0 — 2026-01-01\n\n- real entry\n");
    expect(releases).toHaveLength(1);
    expect(releases[0].entries).toEqual(["real entry"]);
  });

  test("accepts both an em dash and a hyphen between version and date", () => {
    const releases = parseChangelog("## 1.0.0 - 2026-01-01\n\n- entry\n");
    expect(releases[0].date).toBe("2026-01-01");
  });
});

describe("ocx changelog", () => {
  let logged: string[];
  let errored: string[];
  const realLog = console.log;
  const realError = console.error;

  beforeEach(() => {
    logged = [];
    errored = [];
    console.log = (...args: unknown[]) => { logged.push(args.join(" ")); };
    console.error = (...args: unknown[]) => { errored.push(args.join(" ")); };
  });

  afterEach(() => {
    console.log = realLog;
    console.error = realError;
  });

  test("--help exits cleanly and documents every filter", async () => {
    expect(await handleChangelogCommand(["--help"])).toBe(0);
    const help = logged.join("\n");
    for (const flag of ["--from", "--to", "--search", "--regex", "--limit", "--json"]) {
      expect(help).toContain(flag);
    }
  });

  // A malformed filter is a usage error (exit 2), never a silently-ignored filter
  // that would show the user more releases than they asked for.
  test("rejects a non-ISO date instead of ignoring it", async () => {
    expect(await handleChangelogCommand(["--from", "yesterday"])).toBe(2);
    expect(errored.join("\n")).toContain("--from expects YYYY-MM-DD");
  });

  test("rejects a negative or non-integer limit", async () => {
    expect(await handleChangelogCommand(["--limit", "-1"])).toBe(2);
    expect(await handleChangelogCommand(["--limit", "many"])).toBe(2);
  });

  test("rejects an invalid regex rather than falling back to a text search", async () => {
    expect(await handleChangelogCommand(["--search", "([", "--regex"])).toBe(2);
    expect(errored.join("\n")).toContain("invalid --search pattern");
  });

  test("--json emits parseable output carrying the availability flag", async () => {
    expect(await handleChangelogCommand(["--json", "--limit", "1"])).toBe(0);
    const payload = JSON.parse(logged.join("\n"));
    expect(typeof payload.available).toBe("boolean");
    expect(Array.isArray(payload.releases)).toBe(true);
  });
});
