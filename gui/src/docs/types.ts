/**
 * The in-app documentation browser's article shape.
 *
 * Hand-written (not generated) on purpose: `generated-articles.ts` imports this
 * type rather than redeclaring it, so the shape article data must satisfy is
 * reviewable independently of the generator that produces it.
 */

/** The four real categories the bundled corpus has, plus the handful of root-level pages. */
export type DocCategory = "getting-started" | "guides" | "reference" | "troubleshooting" | "general";

export interface DocArticle {
  /** `category/slug`, stable, used as the React key and as the in-app link target. */
  id: string;
  category: DocCategory;
  /** File name without extension, e.g. `web-dashboard`. */
  slug: string;
  /** From the article's frontmatter. Never empty — the generator refuses a file without one. */
  title: string;
  /** From the article's frontmatter. May be empty for a file that omitted it. */
  description: string;
  /** The Markdown body, frontmatter already stripped. */
  body: string;
}

/** Category display order and the i18n key naming each one, shared by the nav list and tests. */
export const DOC_CATEGORY_ORDER: DocCategory[] = [
  "getting-started", "guides", "reference", "troubleshooting", "general",
];
