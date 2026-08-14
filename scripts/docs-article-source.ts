/**
 * Pure, Node/Bun-only logic for turning the documentation site's plain-Markdown
 * articles into the in-app documentation browser's bundle.
 *
 * Deliberately has no React, no Vite and no DOM in it, and deliberately lives
 * at the repository root rather than under `gui/src/docs/` alongside the
 * types and data it produces: `gui/tsconfig.app.json` type-checks everything
 * under `gui/src` with no Node ambient types available (it is a browser
 * bundle), so a `node:fs` import in a file under `gui/src` fails `tsc -b`
 * outright. This module needs `node:fs` for real, so it sits here instead —
 * exactly where `gen-icons.ts` and `generate-changelog.ts`, this script's
 * neighbours, already put their own Node-only generation logic.
 *
 * Two very different callers need this module and neither one can afford the
 * other's runtime:
 *
 *   - `scripts/gen-docs-articles.ts` runs it under Bun to WRITE the committed
 *     `gui/src/docs/generated-articles.ts` that actually ships in the app
 *     (see that script's header for why the bundle is a committed module
 *     rather than a Vite virtual one).
 *   - `gui/tests/docs-articles-complete.test.ts` runs it under `bun test` to
 *     prove the committed file has not gone stale — a bare Node/fs module is
 *     something `bun:test` can import directly from outside the `gui/`
 *     package tree, exactly like it imports the committed data file from
 *     inside it.
 *
 * ## What gets bundled, and what does not
 *
 * The source corpus is `docs-site/src/content/docs/`: the *public* documentation
 * site's articles (`docs/` at the repository root is explicitly maintainer
 * archaeology, per `docs/README.md` — "not the primary user manual"). Only the
 * top-level, plain-`.md` files are taken:
 *
 *   - Locale subdirectories (`ja/`, `ko/`, `ru/`, `zh-cn/`) are excluded. The
 *     in-app browser's own chrome is localized through the app's normal i18n
 *     system; article *content* ships in whichever language it is written in,
 *     and re-bundling four more copies of the same corpus is a translation
 *     problem for the docs site, not for this browser.
 *   - `.mdx` files are excluded. Several of them (`index.mdx`, `changelog.mdx`,
 *     `settings.mdx`, everything under `benchmarks/`, `getting-started/how-it-works.mdx`)
 *     embed real Astro/React components — `<CardGrid>`, custom charts, imported
 *     data tables — that only render correctly inside the Astro site's own build.
 *     Feeding that source through a plain-Markdown renderer would not "fail
 *     safely"; it would render mangled JSX tags as visible garbage, which is
 *     worse than not shipping the page at all. The 28 plain `.md` files are
 *     genuine prose articles — getting started, guides, reference,
 *     troubleshooting, contributing — exactly the "feature article" shape the
 *     in-app browser contract asks for.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { DocArticle, DocCategory } from "../gui/src/docs/types";

/** repository root → `docs-site/src/content/docs`. */
export const DOCS_SITE_CONTENT_ROOT = join(
  dirname(fileURLToPath(import.meta.url)), "..", "docs-site", "src", "content", "docs",
);

/** Locale mirrors of the same corpus. See the module header for why they are excluded. */
export const EXCLUDED_LOCALE_DIRS = new Set(["ja", "ko", "ru", "zh-cn"]);

/** Top-level directory name → the category this browser groups it under. */
const CATEGORY_BY_DIR: Record<string, DocCategory> = {
  "getting-started": "getting-started",
  guides: "guides",
  reference: "reference",
  troubleshooting: "troubleshooting",
};

/**
 * Recursively list every plain-`.md` file under `root`, as root-relative POSIX
 * paths (`"guides/web-dashboard.md"`, `"contributing.md"`), sorted for a
 * deterministic, diff-friendly order.
 *
 * Written as a plain recursive directory walk with exactly one exclusion rule
 * (skip a locale directory by name) rather than a glob library or pattern —
 * `gui/tests/docs-articles-complete.test.ts` re-implements this same walk on
 * its own, independently, specifically so a bug in *this* function's
 * exclusion logic cannot also hide from the test that exists to catch it.
 */
export function listArticleFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (dirname(full) === root && EXCLUDED_LOCALE_DIRS.has(entry)) continue;
        walk(full);
        continue;
      }
      if (entry.endsWith(".md")) out.push(relative(root, full).split("\\").join("/"));
    }
  };
  walk(root);
  return out.sort();
}

interface Frontmatter {
  title: string;
  description: string;
  body: string;
}

/** Strip a YAML scalar's surrounding quotes, if it has matching ones. */
function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'"))) {
    return v.slice(1, -1).replace(/\\"/g, '"');
  }
  return v;
}

/**
 * A minimal frontmatter reader — not a YAML parser. It reads exactly the two
 * top-level scalar fields this browser needs (`title`, `description`) from a
 * `---`-delimited block and ignores everything else in it (arrays, nested
 * objects, `tableOfContents: false`, and so on), which is sufficient because
 * every field this browser needs from Starlight frontmatter is a single-line
 * scalar. A line is only read as a field when it starts at column 0 — anything
 * indented belongs to a nested structure (`head:`'s array items, for instance)
 * and is deliberately skipped rather than misread as a second `title`.
 */
export function parseFrontmatter(raw: string): Frontmatter {
  const normalized = raw.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---")) {
    throw new Error("missing frontmatter — file does not start with '---'");
  }
  const lines = normalized.split(/\r?\n/);
  let closeAt = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") { closeAt = i; break; }
  }
  if (closeAt === -1) throw new Error("frontmatter never closes with a '---' line");

  let title = "";
  let description = "";
  for (const line of lines.slice(1, closeAt)) {
    const m = /^([A-Za-z][\w-]*):[ \t]?(.*)$/.exec(line);
    if (!m) continue;
    const [, key, value] = m as unknown as [string, string, string];
    if (key === "title") title = unquote(value);
    else if (key === "description") description = unquote(value);
  }

  // The body starts after the closing delimiter; a single blank separator
  // line is dropped so every article's body starts flush, not with a gap
  // that would render as extra vertical space in every single one of them.
  const bodyLines = lines.slice(closeAt + 1);
  if (bodyLines[0] === "") bodyLines.shift();
  return { title, description, body: bodyLines.join("\n").replace(/\s+$/, "") };
}

/** The category a root-relative path belongs to. A file with no subdirectory is `"general"`. */
export function categoryForPath(relPath: string): DocCategory {
  const [first, second] = relPath.split("/");
  if (second === undefined) return "general";
  return CATEGORY_BY_DIR[first!] ?? "general";
}

/** Build one article from a root-relative `.md` path. Throws on a file with no usable title. */
export function articleFromFile(root: string, relPath: string): DocArticle {
  const raw = readFileSync(join(root, ...relPath.split("/")), "utf8");
  const { title, description, body } = parseFrontmatter(raw);
  if (!title.trim()) throw new Error(`${relPath}: frontmatter has no non-empty "title"`);
  const category = categoryForPath(relPath);
  const slug = relPath.split("/").pop()!.replace(/\.md$/, "");
  return { id: `${category}/${slug}`, category, slug, title, description, body };
}

/** Stable ordering: category first (in nav order), then slug alphabetically within it. */
const CATEGORY_SORT_INDEX: Record<DocCategory, number> = {
  "getting-started": 0, guides: 1, reference: 2, troubleshooting: 3, general: 4,
};

/** Build the whole bundle fresh from disk. This is the one function both real callers use. */
export function buildArticleBundle(root: string = DOCS_SITE_CONTENT_ROOT): DocArticle[] {
  return listArticleFiles(root)
    .map(rel => articleFromFile(root, rel))
    .sort((a, b) => CATEGORY_SORT_INDEX[a.category] - CATEGORY_SORT_INDEX[b.category] || a.slug.localeCompare(b.slug));
}
