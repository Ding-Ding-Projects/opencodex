/**
 * The in-app documentation browser's completeness guard.
 *
 * Bundling drops a file exactly as easily as it includes one, and the failure
 * mode that actually matters is boring: someone adds a new guide under
 * `docs-site/src/content/docs/guides/`, forgets `bun run scripts/gen-docs-articles.ts`,
 * and the committed `src/docs/generated-articles.ts` quietly keeps shipping
 * the old set. Nothing about that looks broken — the app builds, every
 * existing article still renders — so this is checked by disk, not by trust.
 *
 * This file deliberately does NOT import `scripts/docs-article-source.ts`'s
 * `listArticleFiles`. It re-walks the same source tree with its own, smaller,
 * independently-written logic, so a bug in the real discovery function's
 * exclusion rule (say, a typo that widens the locale-directory skip list to
 * swallow `guides/` too) cannot also hide from the test that exists to catch
 * exactly that class of bug. Two implementations of "which files count" have
 * to agree; one implementation checked against itself proves nothing.
 */

import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { DOCS_ARTICLES } from "../src/docs/generated-articles";

const GUI_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DOCS_ROOT = join(GUI_ROOT, "..", "docs-site", "src", "content", "docs");

/** Independent re-walk: same exclusions, written from scratch, no shared code with the generator. */
function walk(dir: string, root: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (dir === root && (entry === "ja" || entry === "ko" || entry === "ru" || entry === "zh-cn")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { walk(full, root, out); continue; }
    if (entry.endsWith(".md")) out.push(relative(root, full).split("\\").join("/"));
  }
  return out;
}

const REAL_CATEGORIES = new Set(["getting-started", "guides", "reference", "troubleshooting"]);

/** The bundled-article id a root-relative disk path should map to. */
function idForPath(relPath: string): string {
  const segments = relPath.replace(/\.md$/, "").split("/");
  if (segments.length === 1) return `general/${segments[0]}`;
  const [dir, ...rest] = segments;
  const category = REAL_CATEGORIES.has(dir!) ? dir! : "general";
  return `${category}/${rest.join("/")}`;
}

test("every plain-.md article on disk has a matching entry in the committed bundle, and nothing extra is in the bundle", () => {
  const onDisk = walk(DOCS_ROOT, DOCS_ROOT).map(idForPath).sort();
  const bundled = DOCS_ARTICLES.map(a => a.id).sort();
  expect(bundled).toEqual(onDisk);
});

test("bundled ids have no duplicates", () => {
  const ids = DOCS_ARTICLES.map(a => a.id);
  expect(new Set(ids).size).toBe(ids.length);
});

test("every real category on disk contributed at least one article — nothing vanished wholesale", () => {
  const byCategory = new Map<string, number>();
  for (const a of DOCS_ARTICLES) byCategory.set(a.category, (byCategory.get(a.category) ?? 0) + 1);
  for (const category of REAL_CATEGORIES) {
    expect(byCategory.get(category) ?? 0).toBeGreaterThan(0);
  }
});

test("every bundled article's title and description match what is actually in its file's frontmatter today", () => {
  for (const a of DOCS_ARTICLES) {
    const relPath = a.category === "general" ? `${a.slug}.md` : `${a.category}/${a.slug}.md`;
    const raw = readFileSync(join(DOCS_ROOT, relPath), "utf8");
    const lines = raw.split(/\r?\n/);
    const closeAt = lines.slice(1).findIndex(l => l === "---") + 1;
    expect(closeAt).toBeGreaterThan(0);
    const frontmatter = lines.slice(1, closeAt);

    const titleLine = frontmatter.find(l => /^title:/.test(l));
    const descLine = frontmatter.find(l => /^description:/.test(l));
    const unquote = (v: string) => {
      const t = v.trim();
      return t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
    };

    expect(titleLine).toBeTruthy();
    expect(unquote(titleLine!.replace(/^title:\s*/, ""))).toBe(a.title);
    expect(descLine ? unquote(descLine.replace(/^description:\s*/, "")) : "").toBe(a.description);
  }
});

test("no bundled article body still carries its own frontmatter delimiter", () => {
  // A parser bug that fails to strip frontmatter would leave a literal "---"
  // as the article's first line, which the Markdown renderer would then draw
  // as a horizontal rule sitting above the real content.
  for (const a of DOCS_ARTICLES) {
    expect(a.body.startsWith("---")).toBe(false);
    expect(a.body).not.toContain("\ntitle:");
  }
});

test("no locale-mirror or .mdx article leaked into the bundle", () => {
  for (const a of DOCS_ARTICLES) {
    expect(a.id.startsWith("ja/")).toBe(false);
    expect(a.id.startsWith("ko/")).toBe(false);
    expect(a.id.startsWith("ru/")).toBe(false);
    expect(a.id.startsWith("zh-cn/")).toBe(false);
  }
  // The known .mdx-only pages must be absent, not silently present with an
  // empty or mangled body.
  const ids = new Set(DOCS_ARTICLES.map(a => a.id));
  expect(ids.has("general/changelog")).toBe(false);
  expect(ids.has("general/index")).toBe(false);
  expect(ids.has("general/settings")).toBe(false);
  expect(ids.has("getting-started/how-it-works")).toBe(false);
});
