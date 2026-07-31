/**
 * The page index the regex search runs against, and the pure functions that
 * build it.
 *
 * Pagefind is the site's search and stays the site's search — it is built by
 * Starlight's own integration, it is stemmed, ranked and incremental, and it
 * loads a few kilobytes per query instead of the whole corpus. What it cannot do
 * is evaluate a regular expression: its index is inverted and lossy by design,
 * so there is no text left to run a pattern over. The rule requires the builder
 * beside the site's search bar and requires that surface to honour both modes,
 * so regex mode needs a corpus, and this is it — emitted at build time, one file
 * per locale, fetched only when somebody actually turns regex on.
 *
 * Split into "the pure functions" (here) and "the endpoint that calls them"
 * (`src/pages/ocx-search/[locale].json.ts`) because the interesting half is the
 * mapping from a content entry to the URL it will be published at, and that is
 * exactly the half that would otherwise be untestable. A wrong URL here is a
 * search result that 404s — visible to a reader, invisible to a build.
 *
 * The text is capped at the regex engine's own `SAMPLE_CAP` per page, so the
 * bounds the builder promises are true of the corpus and not just of the sample
 * box: no pattern can be handed more than 20,000 characters from one page,
 * whatever the page contains. Pages longer than that are truncated in the index,
 * and the search surface says so rather than implying it searched every word.
 *
 * What this module deliberately does NOT do: rank, score, or stem. Regex search
 * is literal by nature — a reader who wrote `/^##? Install/m` asked for exactly
 * that, and a relevance model second-guessing them would be noise. Ordering is
 * by match count, which is a fact rather than an opinion.
 */

import { SAMPLE_CAP } from "../../../shared/m3/regex";

/** The five locales the site publishes; `root` is English at the site root. */
export const INDEX_LOCALES = ["root", "ko", "zh-cn", "ru", "ja"] as const;
export type IndexLocale = (typeof INDEX_LOCALES)[number];

export interface PageDoc {
  /** Site-absolute path including the deployment base, e.g. `/opencodex/guides/docker/`. */
  path: string;
  title: string;
  description: string;
  /** Section headings, so a hit can say which part of a long page it is in. */
  headings: string[];
  /** Prose, capped at the engine's sample ceiling. */
  text: string;
  /** True when the page was longer than the cap, so the reader can be told. */
  truncated: boolean;
}

/**
 * Which locale a content id belongs to.
 *
 * Starlight puts the default locale at the collection root with no prefix, so
 * "no locale segment" and "English" are the same answer — the same rule
 * `localeOf` applies to URLs, restated here because this runs at build time
 * against ids rather than in the browser against paths.
 */
export function localeOfId(id: string): IndexLocale {
  const first = id.split("/")[0];
  return (INDEX_LOCALES as readonly string[]).includes(first) && first !== "root"
    ? (first as IndexLocale)
    : "root";
}

/**
 * The URL a content entry is published at.
 *
 * `base` is `import.meta.env.BASE_URL`, which always ends in a slash ("/" at a
 * domain root, "/opencodex/" under the project-site prefix). Getting this wrong
 * in the direction of dropping the base is the failure this site keeps having:
 * it works on the canonical domain, 404s on the other host, and both builds
 * report success.
 *
 * An `index` segment is the section's own page, so it collapses: `ja/index`
 * publishes at `/ja/`, not at `/ja/index/`. The trailing slash matches what the
 * tab strip stores and what Starlight links to.
 */
export function pathForId(id: string, base: string): string {
  const clean = id.replace(/\.(md|mdx)$/i, "").replace(/^\/+|\/+$/g, "");
  // Two trims, not one: collapsing `ja/index` leaves `ja/`, and appending the
  // trailing slash below would then produce `/ja//` — a path that still resolves
  // but is a different string from the one the tab strip stores and the sitemap
  // lists, so the same page would look like two pages to everything comparing URLs.
  const slug = clean.replace(/(^|\/)index$/i, "$1").replace(/\/+$/, "");
  const prefix = base.endsWith("/") ? base : `${base}/`;
  return slug ? `${prefix}${slug}/` : prefix;
}

/**
 * Markdown (and MDX) reduced to the prose a reader would recognise.
 *
 * Order matters and each step is here for a reason a naive strip gets wrong:
 *
 *  - MDX `import`/`export` lines go first, before anything can mangle them into
 *    text. They are the file's machinery and no reader ever sees them, so a
 *    pattern matching `Card` would otherwise hit every page that imports one.
 *  - Fenced code keeps its *contents* and loses its fence. Readers search this
 *    documentation for flags and config keys far more than for prose, and
 *    dropping code blocks would make the index miss the thing most worth finding.
 *  - Link syntax collapses to its label, not to its URL: `[the CLI](/x/)` is
 *    read as "the CLI".
 *  - Tags are removed rather than replaced with a space-less join, because
 *    `<b>a</b><b>b</b>` collapsing to `ab` invents a word that is not on the page.
 */
export function plainText(body: string): string {
  return body
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")
    .replace(/^\s*(?:import|export)\s.*$/gm, "")
    .replace(/```[^\n]*\n([\s\S]*?)```/g, "\n$1\n")
    .replace(/~~~[^\n]*\n([\s\S]*?)~~~/g, "\n$1\n")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>\n]{0,200}>/g, " ")
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]{0,3}[>|]+[ \t]?/gm, "")
    .replace(/[*_`]{1,3}/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** ATX headings, in document order, for the "which section" line on a hit. */
export function headingsOf(body: string): string[] {
  const found: string[] = [];
  // Fences are removed first so a `# comment` inside a shell example is not
  // reported as a section of the page.
  const withoutCode = body.replace(/```[\s\S]*?```/g, "").replace(/~~~[\s\S]*?~~~/g, "");
  for (const [, text] of withoutCode.matchAll(/^[ \t]{0,3}#{1,6}[ \t]+(.+)$/gm)) {
    const clean = text.replace(/[*_`#]/g, "").trim();
    if (clean) found.push(clean);
  }
  return found.slice(0, 60);
}

export interface RawEntry {
  id: string;
  title: string;
  description?: string;
  body?: string;
}

/** One entry, ready to publish. `text` is capped at the engine's sample ceiling. */
export function toPageDoc(entry: RawEntry, base: string): PageDoc {
  const text = plainText(entry.body ?? "");
  return {
    path: pathForId(entry.id, base),
    title: entry.title,
    description: entry.description ?? "",
    headings: headingsOf(entry.body ?? ""),
    text: text.slice(0, SAMPLE_CAP),
    truncated: text.length > SAMPLE_CAP,
  };
}

/** The whole index for one locale, ordered by path so a diff of two builds is readable. */
export function buildLocaleIndex(entries: RawEntry[], locale: IndexLocale, base: string): PageDoc[] {
  return entries
    .filter(entry => localeOfId(entry.id) === locale)
    .map(entry => toPageDoc(entry, base))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** Where a locale's index is published. Kept here so the writer and the reader agree. */
export function indexUrl(base: string, locale: IndexLocale): string {
  const prefix = base.endsWith("/") ? base : `${base}/`;
  return `${prefix}ocx-search/${locale}.json`;
}
