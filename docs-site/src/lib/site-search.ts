/**
 * The site's content search, in both modes.
 *
 * Plain text runs on **Pagefind** — the index Starlight's own integration builds
 * from `dist/` at the end of every build. It is not replaced, wrapped or
 * reimplemented: this module loads Pagefind's own JS API and asks it the
 * question. What changed is the surface in front of it, because the rule
 * requires the regex builder anchored beside the site's search bar and requires
 * that bar to honour both modes, and Pagefind's default UI is a closed modal
 * with nowhere to put one.
 *
 * Regex runs locally over `ocx-search/<locale>.json`, fetched the first time a
 * reader turns regex on and cached for the session. Pagefind cannot evaluate a
 * pattern — its index is inverted and lossy, so there is no text left to run one
 * over — and a "regex mode" that quietly did a substring search instead would be
 * the worst kind of feature: one that answers confidently and wrongly.
 *
 * Both modes are bounded by the same engine caps: 400-character pattern, 20,000
 * characters of any one page, 200 matches per page. The corpus is capped when it
 * is *built* rather than when it is searched, so the promise holds for a page
 * however long it is.
 *
 * Excerpts are sanitized into `<mark>`-only HTML by `markSafe`, whichever mode
 * produced them. Pagefind's excerpt arrives as markup and the local one has to
 * be built as markup to highlight anything, so there is one render path and one
 * escape function rather than two shapes and a decision at every call site.
 *
 * What this module deliberately does NOT do: rank regex hits, transmit a query,
 * or fall back silently. When Pagefind is unavailable — `astro dev` never builds
 * it — plain text runs on the local index instead and the caller is told which
 * engine answered, so a reader is never shown "no results" by a search that
 * never ran.
 */

import { MATCH_CAP, capPattern, capSample, evaluate } from "../../../shared/m3/regex";
import type { IndexLocale, PageDoc } from "./search-index";
import { indexUrl } from "./search-index";

/** Pages listed for one query. Beyond this the answer is "narrow the query". */
export const RESULT_CAP = 40;
/** Characters of context kept on each side of a highlighted match. */
const EXCERPT_BEFORE = 70;
const EXCERPT_AFTER = 110;

export interface SearchHit {
  path: string;
  title: string;
  /** The nearest heading, when the local index can name one. */
  section?: string;
  /** Sanitized: text is escaped and only `<mark>` survives. */
  excerptHtml: string;
  /** Matches on this page. Pagefind does not report one, so plain-text hits show 0. */
  count: number;
  /** True when the page was longer than the index cap, so the count is a floor. */
  truncated?: boolean;
}

export type SearchEngine = "pagefind" | "local";

export interface SearchOutcome {
  hits: SearchHit[];
  engine: SearchEngine;
  /** More pages matched than `RESULT_CAP`. */
  more: boolean;
  /** Set when the mode the caller asked for could not run, and why. */
  degraded?: "pagefind-unavailable" | "index-unavailable";
}

/* ------------------------------------------------------------ sanitizing -- */

const ESCAPES: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, ch => ESCAPES[ch]!);
}

/**
 * Everything escaped, then `<mark>` put back.
 *
 * Both excerpt sources need markup — Pagefind returns it and a local highlight
 * has to produce it — and both end up in `dangerouslySetInnerHTML`. Rather than
 * trusting either source, everything is escaped and exactly two tags are
 * restored. Pagefind's excerpt is the site's own build output today, but "our
 * own content" is a property of the pipeline rather than of this function, and
 * this function is the one that has to hold when someone adds a plugin.
 */
export function markSafe(html: string): string {
  return escapeHtml(html)
    .replace(/&lt;mark&gt;/g, "<mark>")
    .replace(/&lt;\/mark&gt;/g, "</mark>");
}

/** An excerpt with one highlighted span, already escaped. */
function excerptAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - EXCERPT_BEFORE);
  const end = Math.min(text.length, index + length + EXCERPT_AFTER);
  const lead = start > 0 ? "…" : "";
  const tail = end < text.length ? "…" : "";
  const before = escapeHtml(text.slice(start, index));
  const hit = escapeHtml(text.slice(index, index + length));
  const after = escapeHtml(text.slice(index + length, end));
  // A zero-width match highlights nothing rather than inventing a character to
  // highlight: `<mark></mark>` renders as an empty box and would read as a hit
  // on something that is not there.
  return `${lead}${before}${hit ? `<mark>${hit}</mark>` : ""}${after}${tail}`;
}

/* -------------------------------------------------------- the local index -- */

const indexCache = new Map<string, Promise<PageDoc[]>>();

/**
 * Fetch and cache one locale's corpus.
 *
 * Cached as the *promise*, not the result, so two search bars asking during the
 * same frame share one request instead of racing two. A rejected fetch is
 * dropped from the cache so a reader who lost their connection for one second is
 * not stuck with a permanently failed search for the rest of the session.
 */
export function loadIndex(base: string, locale: IndexLocale, fetcher: typeof fetch = fetch): Promise<PageDoc[]> {
  const url = indexUrl(base, locale);
  const cached = indexCache.get(url);
  if (cached) return cached;
  const pending = fetcher(url)
    .then(response => {
      if (!response.ok) throw new Error(`${response.status}`);
      return response.json() as Promise<PageDoc[]>;
    })
    .catch(error => { indexCache.delete(url); throw error; });
  indexCache.set(url, pending);
  return pending;
}

export interface LocalQuery {
  query: string;
  regex: boolean;
  flags: string;
}

/**
 * Where a page matches, and how often.
 *
 * The title, the description and the headings are searched alongside the body
 * and are searched *first*, so a page whose title is the query outranks a page
 * that mentions it in passing — the one piece of ranking here, and it is a fact
 * about where the match is rather than a guess about what the reader meant.
 */
function matchPage(doc: PageDoc, q: LocalQuery): { count: number; excerptHtml: string; section?: string } | null {
  const haystack = `${doc.title}\n${doc.description}\n${doc.headings.join("\n")}`;
  const body = capSample(doc.text);

  if (q.regex) {
    const pattern = capPattern(q.query);
    const head = evaluate(pattern, q.flags, haystack);
    if (head.error) return null;
    const inBody = evaluate(pattern, q.flags, body);
    const count = head.rows.length + inBody.rows.length;
    if (!count) return null;
    const row = inBody.rows[0] ?? head.rows[0]!;
    const source = inBody.rows.length ? body : haystack;
    return {
      count: Math.min(count, MATCH_CAP * 2),
      excerptHtml: excerptAround(source, row.index, row.text.length),
      section: nearestHeading(doc, inBody.rows.length ? row.index : -1),
    };
  }

  const needle = q.query.trim().toLowerCase();
  if (!needle) return null;
  const inHead = haystack.toLowerCase().includes(needle);
  const lowerBody = body.toLowerCase();
  let count = inHead ? 1 : 0;
  let first = -1;
  for (let at = lowerBody.indexOf(needle); at !== -1 && count < MATCH_CAP; at = lowerBody.indexOf(needle, at + needle.length)) {
    if (first === -1) first = at;
    count += 1;
  }
  if (!count) return null;
  const source = first === -1 ? haystack : body;
  const index = first === -1 ? haystack.toLowerCase().indexOf(needle) : first;
  return {
    count,
    excerptHtml: excerptAround(source, Math.max(0, index), needle.length),
    section: nearestHeading(doc, first),
  };
}

/**
 * The heading a body offset most likely sits under.
 *
 * Approximate on purpose: the index stores headings as a list rather than with
 * offsets, so this reports the last heading whose text appears before the match
 * in the stripped body. Wrong only when a heading's exact words also occur
 * earlier as prose, and the cost of being wrong is a slightly-off section label
 * beside a correct excerpt — much cheaper than storing an offset table for every
 * page in every locale.
 */
function nearestHeading(doc: PageDoc, bodyIndex: number): string | undefined {
  if (bodyIndex < 0 || !doc.headings.length) return undefined;
  let best: string | undefined;
  for (const heading of doc.headings) {
    const at = doc.text.indexOf(heading);
    if (at === -1 || at > bodyIndex) continue;
    best = heading;
  }
  return best;
}

/** Does the query hit the title itself — the one thing this ranks on. */
function titleMatches(title: string, q: LocalQuery): boolean {
  if (!q.regex) return title.toLowerCase().includes(q.query.trim().toLowerCase());
  const result = evaluate(capPattern(q.query), q.flags, title);
  return !result.error && result.rows.length > 0;
}

/** Run a query over a loaded corpus. Pure, so the ordering and caps are testable. */
export function searchDocs(docs: PageDoc[], q: LocalQuery): SearchOutcome {
  const scored: Array<SearchHit & { titleHit: boolean }> = [];
  for (const doc of docs) {
    const match = matchPage(doc, q);
    if (!match) continue;
    scored.push({
      path: doc.path,
      title: doc.title,
      section: match.section,
      excerptHtml: match.excerptHtml,
      count: match.count,
      truncated: doc.truncated,
      titleHit: titleMatches(doc.title, q),
    });
  }
  scored.sort((a, b) => {
    if (a.titleHit !== b.titleHit) return a.titleHit ? -1 : 1;
    if (a.count !== b.count) return b.count - a.count;
    return a.path.localeCompare(b.path);
  });
  return {
    hits: scored.slice(0, RESULT_CAP).map(({ titleHit: _titleHit, ...hit }) => hit),
    engine: "local",
    more: scored.length > RESULT_CAP,
  };
}

/* ------------------------------------------------------------- pagefind -- */

interface PagefindResult { data: () => Promise<PagefindDoc> }
interface PagefindDoc {
  url: string;
  excerpt: string;
  meta?: { title?: string };
  sub_results?: Array<{ title?: string; url?: string; excerpt?: string }>;
}
interface PagefindApi {
  options: (opts: Record<string, unknown>) => Promise<void>;
  search: (query: string) => Promise<{ results: PagefindResult[] }>;
}

let pagefindPromise: Promise<PagefindApi | null> | null = null;

/**
 * Pagefind's own bundle, loaded once per session.
 *
 * `@vite-ignore` because the specifier is a runtime path into the built output,
 * not a module in this graph: Vite would try to resolve `/pagefind/pagefind.js`
 * at build time, fail, and turn a working search into a build error. The bundle
 * does not exist during `astro dev` either, which is not a failure — the caller
 * falls back to the local index and says which engine answered.
 */
export function loadPagefind(base: string): Promise<PagefindApi | null> {
  if (pagefindPromise) return pagefindPromise;
  const prefix = base.endsWith("/") ? base : `${base}/`;
  pagefindPromise = import(/* @vite-ignore */ `${prefix}pagefind/pagefind.js`)
    .then(async (mod: PagefindApi) => {
      // Pagefind returns URLs relative to the directory it indexed, which is
      // `dist/` — no base prefix in it. Under the project-site deployment every
      // result would then point one level above the site.
      await mod.options({ baseUrl: prefix });
      return mod;
    })
    .catch(() => null);
  return pagefindPromise;
}

/** Idempotent base prefixing, in case a Pagefind version stops honouring `baseUrl`. */
export function withBase(url: string, base: string): string {
  const prefix = base.endsWith("/") ? base : `${base}/`;
  if (prefix === "/" || url.startsWith(prefix)) return url;
  return `${prefix}${url.replace(/^\/+/, "")}`;
}

export async function searchPagefind(api: PagefindApi, query: string, base: string): Promise<SearchOutcome> {
  const response = await api.search(query);
  const top = response.results.slice(0, RESULT_CAP);
  // `data()` is one fetch per result, so only the page the reader can actually
  // see is loaded — the cap above is what keeps a three-letter query from
  // pulling a hundred fragments across a phone connection.
  const docs = await Promise.all(top.map(result => result.data()));
  return {
    hits: docs.map(doc => ({
      path: withBase(doc.url, base),
      title: doc.meta?.title || doc.url,
      section: doc.sub_results?.[0]?.title,
      excerptHtml: markSafe(doc.excerpt ?? ""),
      count: 0,
    })),
    engine: "pagefind",
    more: response.results.length > RESULT_CAP,
  };
}
