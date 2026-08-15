/**
 * Regenerate CHANGELOG.md from annotated release tags.
 *
 * The dashboard's Changelog screen reads the generated file through
 * `/api/changelog`, so the dashboard stays fully offline — no GitHub API call
 * at view time. Preview tags (`-preview.*`) are skipped: they are build
 * artefacts, not releases users can install.
 *
 *   bun scripts/generate-changelog.ts
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// `import.meta.dir` is Bun-only; this form works under Bun and Node alike.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

interface Release {
  tag: string;
  version: string;
  date: string;
  entries: string[];
}

// execFileSync (not a shell) so the script runs identically under Bun and Node,
// and so tag names can never be reinterpreted as shell syntax.
function git(args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

/** Tags newest-first, release tags only. */
function releaseTags(): string[] {
  const raw = git(["tag", "--sort=-creatordate"]);
  return raw
    .split("\n")
    .map(t => t.trim())
    .filter(t => /^v\d+\.\d+\.\d+$/.test(t));
}

function normalizeSubject(subject: string): string | null {
  const trimmed = subject.trim();
  if (!trimmed) return null;
  // Merge commits and release bumps are noise in a user-facing changelog.
  if (/^Merge (branch|pull request|remote)/i.test(trimmed)) return null;
  if (/^(chore\(release\)|release|Auto commit)/i.test(trimmed)) return null;
  return trimmed;
}

/**
 * The hand-written `## Unreleased` block, carried across a regeneration.
 *
 * Everything below this line comes from annotated tags, which means work that
 * has landed but not shipped had nowhere to be recorded: the whole file is
 * rewritten from scratch, so a section added by hand was destroyed by the next
 * run with nothing said about it. That is worse than having no place to write
 * it, because the writing looks like it worked.
 *
 * So exactly one section survives regeneration, by name. It is parsed as an
 * ordinary release with a null date (`changelog-routes.ts`'s heading pattern
 * already makes the date optional), so the CLI, the dashboard's Changelog
 * screen and the documentation site all show it without changes of their own.
 * When the next tag is cut its commits appear under that version and the
 * section should be emptied by hand — this preserves what is there, it does not
 * decide when the work has shipped.
 */
function unreleasedSection(path: string): string[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  const start = lines.findIndex(line => /^##\s+Unreleased\s*$/i.test(line));
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(line => line.startsWith("## "));
  const body = (end < 0 ? rest : rest.slice(0, end));
  // A heading with no bullets under it is an empty promise, and the real
  // CHANGELOG's own guard requires every release to carry at least one entry.
  if (!body.some(line => /^[-*]\s+\S/.test(line))) return [];
  // Trailing blank lines are re-added below, so the join cannot grow a gap
  // every time this runs.
  while (body.length && !body[body.length - 1].trim()) body.pop();
  return [lines[start], ...body, ""];
}

function main(): void {
  const tags = releaseTags();
  const releases: Release[] = [];

  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i];
    const previous = tags[i + 1];
    const date = git(["log", "-1", "--format=%cs", tag]) || "";
    const range = previous ? `${previous}..${tag}` : tag;
    const log = git(["log", "--no-merges", "--format=%s", range]);
    const entries = log.split("\n").map(normalizeSubject).filter((s): s is string => !!s);
    releases.push({ tag, version: tag.replace(/^v/, ""), date, entries });
  }

  const target = join(ROOT, "CHANGELOG.md");
  const lines: string[] = [
    "# Changelog",
    "",
    "Generated from release tags by `bun scripts/generate-changelog.ts`.",
    "Preview tags are omitted. The dashboard reads this file through `/api/changelog`.",
    "An `## Unreleased` section, if one is present, is hand-written and carried across a regeneration.",
    "",
    ...unreleasedSection(target),
  ];

  for (const release of releases) {
    lines.push(`## ${release.version} — ${release.date}`, "");
    if (release.entries.length === 0) lines.push("- No user-facing changes recorded.", "");
    else {
      for (const entry of release.entries) lines.push(`- ${entry}`);
      lines.push("");
    }
  }

  writeFileSync(target, lines.join("\n"), "utf8");
  console.log(`Wrote CHANGELOG.md — ${releases.length} releases.`);
}

main();
