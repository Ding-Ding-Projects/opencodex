/**
 * The per-locale page index, emitted as five static JSON files.
 *
 * One file per locale rather than one file for the site: a reader searching the
 * Japanese docs has no use for 296KB of English, and splitting on the axis the
 * reader is already on costs nothing at build time. The files are prerendered
 * like every other route here — there is no server, and a search that needed one
 * would not work on GitHub Pages at all.
 *
 * These are the only routes on the site that are not HTML, so they are also the
 * only ones `scripts/check-dist.mjs` does not walk. That is correct: its two
 * checks are about absolute paths inside documents and about the tab-strip
 * island, and a JSON array has neither. What it *does* need to be right about is
 * the `path` on every entry, which is why that mapping lives in
 * `lib/search-index.ts` with tests rather than inline here.
 *
 * `prerender` is stated explicitly even though this site has no adapter and
 * everything is static already. The line is the difference between "this is
 * static" and "this happens to be static today", and an adapter added later for
 * one dynamic route would otherwise turn the search index into a server call.
 */

import type { APIRoute, GetStaticPaths } from "astro";
import { getCollection } from "astro:content";
import { INDEX_LOCALES, buildLocaleIndex, type IndexLocale, type RawEntry } from "../../lib/search-index";

export const prerender = true;

export const getStaticPaths: GetStaticPaths = () =>
  INDEX_LOCALES.map(locale => ({ params: { locale } }));

export const GET: APIRoute = async ({ params }) => {
  const locale = (params.locale ?? "root") as IndexLocale;
  const docs = await getCollection("docs");

  const entries: RawEntry[] = docs.map(entry => ({
    id: entry.id,
    title: entry.data.title,
    description: entry.data.description,
    body: entry.body,
  }));

  const index = buildLocaleIndex(entries, locale, import.meta.env.BASE_URL);

  return new Response(JSON.stringify(index), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      // Fingerprinting is not available for a fixed path, so the index is
      // revalidated rather than held: it changes with the docs, and serving a
      // stale corpus would have regex search quietly answering about a version
      // of the page the reader is not looking at.
      "cache-control": "public, max-age=0, must-revalidate",
    },
  });
};
