/**
 * The search bar the "On this page" table of contents has to carry.
 *
 * Every other search surface on this site already has one, and the rule that put
 * it there does not exempt a surface for being short: a reader who knows a
 * heading is on this page should be able to type it here and land on it. The ToC
 * is also the one list that grows without anybody deciding it should — a long
 * guide quietly produces twenty entries, and the mobile dropdown then hides most
 * of them behind a scroll inside a popover, which is the worst place to hunt.
 *
 * ## Why it filters rather than re-renders
 *
 * Same reasoning as `SettingsSearch`: the list is Starlight's own markup, with
 * Starlight's scroll-spy watching those anchors and marking the current one. A
 * React island that re-rendered the items would take ownership of a list whose
 * behaviour lives somewhere else — the highlight would keep its logic and lose
 * its DOM. Toggling `hidden` on each `<li>` leaves every binding intact and is a
 * change the ToC cannot notice.
 *
 * The cleanup un-hides everything, so unmounting this island can never strand a
 * reader with a table of contents that is missing most of its entries.
 *
 * ## What it matches
 *
 * The heading text, and nothing else. There is no "current value" here the way
 * there is in settings — a heading is its own label — so the corpus is simply
 * what the reader can see, which keeps "type what you can read" true.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChromeT } from "../lib/i18n/use-ui";
import type { DocsLocale } from "../lib/routes";
import { useSearchQuery } from "../lib/use-search-query";
import { SearchBar } from "./RegexBuilder";

export interface TocSearchProps {
  /** Documentation locale, for the copy. */
  locale?: string;
  /**
   * The list this search owns.
   *
   * Starlight renders the desktop sidebar and the mobile dropdown from the same
   * component but into different containers, and both mount this island — so the
   * selector is passed in rather than guessed, and each copy filters its own list
   * instead of both fighting over whichever one happened to render first.
   */
  rootSelector: string;
}

/** A heading row and the text a reader would search for it by. */
interface Entry {
  li: HTMLLIElement;
  text: string;
}

export default function TocSearch({ locale, rootSelector }: TocSearchProps) {
  const t = useChromeT(locale as DocsLocale);
  const state = useSearchQuery();
  const hostRef = useRef<HTMLDivElement>(null);
  const [entries, setEntries] = useState<Entry[]>([]);

  const rootOf = useCallback((): HTMLElement | null => {
    const host = hostRef.current;
    if (!host) return null;
    // Scope to the `.m3-toc-host` wrapper this island shares with its own copy of
    // Starlight's ToC, and stop there.
    //
    // Not `parentElement`: Astro wraps a hydrated island in an `<astro-island>`
    // element, so the parent is that wrapper and the ToC is its *sibling* — the
    // lookup misses, and a `document.querySelector` fallback then hands both
    // copies the first match on the page. At widths where the sidebar and the
    // dropdown both exist, that is the dropdown filtering the sidebar behind it,
    // which is the exact failure the two-override split was for.
    //
    // No document-wide fallback at all, deliberately: if the wrapper is not
    // found, the honest outcome is a search that does nothing to anything, not
    // one that quietly reaches across the page.
    return host.closest<HTMLElement>(".m3-toc-host")?.querySelector<HTMLElement>(rootSelector) ?? null;
  }, [rootSelector]);

  /* Re-read on mount, and again whenever the list itself changes — a client-side
     navigation swaps the headings without unmounting this island, and a search
     still filtering the previous page's list would be worse than no search. */
  const rescan = useCallback(() => {
    const root = rootOf();
    if (!root) return;
    const found = Array.from(root.querySelectorAll<HTMLLIElement>("li"))
      .map(li => ({ li, text: (li.querySelector("a")?.textContent ?? li.textContent ?? "").trim() }))
      .filter(entry => entry.text.length > 0);
    setEntries(found);
  }, [rootOf]);

  useEffect(() => {
    rescan();
    const root = rootOf();
    if (!root) return;
    const observer = new MutationObserver(rescan);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [rescan, rootOf]);

  const matches = useMemo(
    () => entries.filter(entry => state.matcher(entry.text)),
    [entries, state.matcher],
  );

  useEffect(() => {
    const keep = new Set(matches.map(entry => entry.li));
    for (const entry of entries) entry.li.hidden = !keep.has(entry.li);
    return () => { for (const entry of entries) entry.li.hidden = false; };
  }, [entries, matches]);

  // Real headings from this page, so a pattern is tried against actual data
  // rather than against a placeholder that happens to match everything.
  const sample = useMemo(() => entries.map(entry => entry.text).join("\n"), [entries]);

  // Nothing to search is not the same as a search that found nothing. A page
  // with one heading gets no bar at all rather than a control that can only ever
  // hide the single thing it is pointing at.
  if (entries.length < 2) return null;

  return (
    <div className="m3-toc-search" ref={hostRef}>
      <SearchBar
        t={t}
        state={state}
        searchLabel={t("toc.search")}
        placeholder={t("toc.searchPh")}
        sample={sample}
      />
      <p className="m3-toc-searchstatus" role="status" aria-live="polite">
        {state.query
          ? matches.length === 0
            ? t("toc.none")
            : t("toc.shown", { shown: matches.length, total: entries.length })
          : ""}
      </p>
    </div>
  );
}
