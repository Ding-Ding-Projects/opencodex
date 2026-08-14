/**
 * Resolves a link found inside a bundled article's body to another bundled
 * article, the way the documentation site itself resolves it.
 *
 * The corpus links two ways, both taken verbatim from `docs-site`'s Starlight
 * conventions rather than invented here:
 *
 *   - site-root-absolute: `/guides/web-dashboard/`, `/reference/cli/#ocx-service`
 *   - directory-relative: `../../changelog/`, `../../getting-started/installation/`
 *
 * Starlight gives every page a trailing-slash "pretty" URL, which is what
 * makes directory-relative resolution predictable: a page's own URL acts as
 * its own directory (`/guides/super-express-release/`), so `../../foo/`
 * written inside it climbs out of that pretend directory twice before
 * descending into `foo/` — exactly like resolving a relative path against any
 * directory. This module reproduces that arithmetic without needing to know
 * anything about Astro or Starlight at runtime.
 *
 * A link that resolves outside the bundled corpus — most commonly one of the
 * `.mdx` pages this browser deliberately does not bundle, like `/changelog/`
 * or `/getting-started/how-it-works/` — is not an error here: `resolveDocHref`
 * returns the segments it computed either way, and it is the caller's job (see
 * `pages/Docs.tsx`) to look those segments up and show an honest "not bundled"
 * state rather than pretend every link in real prose landed somewhere.
 */

import type { DocArticle } from "./types";

/** The path segments this article's own page would live at on the real site. */
export function siteSegments(article: Pick<DocArticle, "category" | "slug">): string[] {
  return article.category === "general" ? [article.slug] : [article.category, article.slug];
}

/** The bundled article id (`"category/slug"`) that a set of site segments would map to, or `null`. */
export function idForSegments(segments: string[]): string | null {
  if (segments.length === 1) return `general/${segments[0]}`;
  if (segments.length === 2) return `${segments[0]}/${segments[1]}`;
  return null;
}

export interface ResolvedDocLink {
  /** The bundled article id this link points at, or `null` if it resolves outside the corpus. */
  id: string | null;
  /** The `#fragment`, if any, with the `#` stripped. */
  anchor: string | null;
}

/**
 * Resolve an in-app link found in `from`'s body.
 *
 * `href` has already been identified by the caller as "internal" (leading
 * `/`, `./`, `../` or `#` — see `shell/Markdown.tsx`'s `MarkdownLinkTarget`).
 * A bare `#anchor` resolves to the same article it was found in, which is why
 * `from` is required rather than optional.
 */
export function resolveDocHref(href: string, from: Pick<DocArticle, "id" | "category" | "slug">): ResolvedDocLink {
  const hashAt = href.indexOf("#");
  const path = hashAt === -1 ? href : href.slice(0, hashAt);
  const anchor = hashAt === -1 ? null : (href.slice(hashAt + 1) || null);

  if (path === "") return { id: from.id, anchor };

  const parts = path.split("/").filter(Boolean);
  let segments: string[];
  if (path.startsWith("/")) {
    segments = parts;
  } else {
    const stack = siteSegments(from);
    for (const part of parts) {
      if (part === ".") continue;
      if (part === "..") stack.pop();
      else stack.push(part);
    }
    segments = stack;
  }

  return { id: idForSegments(segments), anchor };
}
