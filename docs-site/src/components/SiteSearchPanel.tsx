/**
 * The site search's panel: the field, its regex builder, and the results.
 *
 * A separate module from `SiteSearch` so it can be `lazy()`-loaded. This half
 * pulls in the regex engine, the guided palette and the builder's markup, and a
 * reader who lands on a documentation page and reads it should not download any
 * of that. The trigger in the app bar is a button; this is everything behind it,
 * fetched on the first click.
 *
 * Both search modes live here and neither is a fallback for the other:
 *
 *  - **Plain text** asks Pagefind, the index Starlight's own integration builds.
 *    Pagefind's core is loaded on the first query, not on page load.
 *  - **Regex** runs locally over `ocx-search/<locale>.json`, fetched the first
 *    time regex mode is switched on. Pagefind cannot evaluate a pattern, and a
 *    regex mode that quietly did a substring search would answer confidently and
 *    wrongly.
 *
 * When Pagefind is missing — `astro dev` never builds it — plain text runs on the
 * local corpus instead and the panel says so. A search that silently degrades is
 * how a reader concludes the documentation has nothing about their problem.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { INITIAL_PLACEMENT, computePlacement, fixedPanelStyle, type Placement } from "../../../shared/m3/anchor";
import { MATCH_CAP, PATTERN_CAP, SAMPLE_CAP } from "../../../shared/m3/regex";
import { BASE } from "../lib/routes";
import type { TFn } from "../lib/strings";
import { useSearchQuery } from "../lib/use-search-query";
import type { IndexLocale, PageDoc } from "../lib/search-index";
import {
  loadIndex,
  loadPagefind,
  searchDocs,
  searchPagefind,
  type SearchOutcome,
} from "../lib/site-search";
import { SearchBar } from "./RegexBuilder";
import { Icon, IconButton } from "./ui";

/** Long enough that a fast typist issues one query, short enough to feel live. */
const DEBOUNCE_MS = 160;

export interface SiteSearchPanelProps {
  id: string;
  t: TFn;
  locale: string;
  anchorRef: React.RefObject<HTMLDivElement | null>;
  onDismiss: () => void;
}

export default function SiteSearchPanel({ id, t, locale, anchorRef, onDismiss }: SiteSearchPanelProps) {
  const state = useSearchQuery();
  const panelRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<Placement>(INITIAL_PLACEMENT);
  const [outcome, setOutcome] = useState<SearchOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [indexFailed, setIndexFailed] = useState(false);
  const [docs, setDocs] = useState<PageDoc[] | null>(null);
  const listId = `${id}-results`;
  const fieldId = `${id}-field`;

  const indexLocale = (locale || "root") as IndexLocale;

  /* Placement, then re-placement whenever the page moves under it — including
     the address-bar collapse that changes `innerHeight` mid-scroll on a phone. */
  useLayoutEffect(() => {
    const reposition = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      const panel = panelRef.current?.getBoundingClientRect();
      if (!anchor || !panel) return;
      setPlacement(computePlacement(anchor, panel, { width: window.innerWidth, height: window.innerHeight }));
    };
    reposition();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [anchorRef]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onDismiss(); };
    const onDown = (event: MouseEvent) => {
      if (!anchorRef.current?.contains(event.target as Node)) onDismiss();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [onDismiss, anchorRef]);

  /* Focus the field, not the panel: the field is what the reader opened this
     for, and focusing the container makes a keyboard user's first action be
     tabbing past a heading. */
  useEffect(() => { document.getElementById(fieldId)?.focus(); }, [fieldId]);

  /**
   * The corpus, fetched only when regex mode is actually turned on.
   *
   * A reader who never touches regex never downloads it. Turning the mode on is
   * the signal — not opening the panel, and certainly not loading the page.
   */
  useEffect(() => {
    if (!state.regex || docs || indexFailed) return;
    let live = true;
    loadIndex(BASE, indexLocale)
      .then(loaded => { if (live) setDocs(loaded); })
      .catch(() => { if (live) setIndexFailed(true); });
    return () => { live = false; };
  }, [state.regex, docs, indexFailed, indexLocale]);

  /**
   * Drop the previous answer the moment the mode changes.
   *
   * Not tidiness. Switching to regex takes as long as the corpus takes to
   * arrive, and without this the panel spends that time showing Pagefind's
   * plain-text hits underneath a field that now says "Regex" — results from one
   * engine presented as the answer to a question asked of another. Better to
   * show the reader nothing and say the index is loading than to show them
   * something true of a query they have replaced.
   */
  useEffect(() => { setOutcome(null); }, [state.regex]);

  /**
   * Run the query, debounced, with the last answer winning.
   *
   * `live` rather than an AbortController because neither engine here is
   * abortable — Pagefind's promise and a JSON parse both run to completion — so
   * what matters is that a slower earlier query cannot overwrite a faster later
   * one's results.
   */
  useEffect(() => {
    if (!state.query.trim() || state.error) { setOutcome(null); setBusy(false); return; }
    let live = true;
    setBusy(true);
    const timer = setTimeout(async () => {
      try {
        if (state.regex) {
          // Still loading the corpus. This effect re-runs when `docs` arrives,
          // so the query is not lost — it is answered a moment later.
          if (!docs) return;
          const result = searchDocs(docs, { query: state.query, regex: true, flags: state.flags });
          if (live) setOutcome(result);
          return;
        }
        const pagefind = await loadPagefind(BASE);
        if (pagefind) {
          const result = await searchPagefind(pagefind, state.query, BASE);
          if (live) setOutcome(result);
          return;
        }
        const loaded = docs ?? await loadIndex(BASE, indexLocale).catch(() => null);
        if (!loaded) { if (live) { setOutcome(null); setIndexFailed(true); } return; }
        if (!docs && live) setDocs(loaded);
        const result = searchDocs(loaded, { query: state.query, regex: false, flags: state.flags });
        if (live) setOutcome({ ...result, degraded: "pagefind-unavailable" });
      } finally {
        if (live) setBusy(false);
      }
    }, DEBOUNCE_MS);
    return () => { live = false; clearTimeout(timer); };
  }, [state.query, state.regex, state.flags, state.error, docs, indexLocale]);

  /* Arrow keys walk the results from the field, the way a combobox does, so the
     whole surface is reachable without a pointer. */
  const listRef = useRef<HTMLUListElement>(null);
  const onKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const links = Array.from(listRef.current?.querySelectorAll<HTMLAnchorElement>("a") ?? []);
    if (!links.length) return;
    event.preventDefault();
    const current = links.indexOf(document.activeElement as HTMLAnchorElement);
    const next = event.key === "ArrowDown"
      ? (current + 1) % links.length
      : (current - 1 + links.length) % links.length;
    links[next]?.focus();
  }, []);

  const hits = outcome?.hits ?? [];
  /* The builder's sample is real page metadata, so a pattern tried in the
     popover is tried against the same shape of text the search will run it on. */
  const sample = useMemo(
    () => (docs ?? []).slice(0, 6).map(doc => `${doc.title}\n${doc.description}`).join("\n").slice(0, SAMPLE_CAP),
    [docs],
  );

  return (
    <div
      id={id}
      ref={panelRef}
      role="dialog"
      aria-label={t("search.open")}
      className={`m3-searchpanel m3-rxpop--${placement.side}`}
      style={fixedPanelStyle(placement)}
    >
      <header className="m3-searchpanel-head">
        <h2 className="m3-searchpanel-title">{t("search.label")}</h2>
        <IconButton title={t("search.close")} aria-label={t("search.close")} onClick={onDismiss}>
          {Icon.close}
        </IconButton>
      </header>

      <div className="m3-searchpanel-body" onKeyDown={onKeyDown}>
        <SearchBar
          t={t}
          state={state}
          id={fieldId}
          searchLabel={t("search.open")}
          placeholder={t("search.ph")}
          sample={sample}
          controls={listId}
        />

        <p className="m3-searchpanel-engine">{t("search.engine")}</p>
        {state.regex ? (
          <p className="m3-searchpanel-engine">
            {t("regex.safety", { pattern: PATTERN_CAP, sample: SAMPLE_CAP, matches: MATCH_CAP })}
          </p>
        ) : null}
        {indexFailed && state.regex ? <p className="m3-searchpanel-warn">{t("search.indexFailed")}</p> : null}
        {outcome?.degraded === "pagefind-unavailable" ? (
          <p className="m3-searchpanel-warn">{t("search.pagefindFailed")}</p>
        ) : null}

        {/* The index-loading state is read from `docs`, not from `busy`: the
            debounced query returns early while the corpus is still in flight, so
            `busy` has already gone false by then and the reader would be told
            nothing at all during the one wait long enough to need a message. */}
        <p className="m3-searchpanel-status" role="status" aria-live="polite">
          {state.regex && !docs && !indexFailed && state.query.trim()
            ? t("search.indexing")
            : busy
              ? t("search.loading")
              : outcome
                ? t("search.results", { count: hits.length })
                : ""}
        </p>

        <ul className="m3-searchpanel-list" id={listId} ref={listRef}>
          {!busy && outcome && hits.length === 0 ? <li className="m3-ts-empty">{t("search.none")}</li> : null}
          {hits.map(hit => (
            <li key={hit.path} className="m3-searchhit">
              <a href={hit.path} onClick={onDismiss}>
                <span className="m3-searchhit-title">{hit.title}</span>
                {hit.section ? <span className="m3-searchhit-section">{hit.section}</span> : null}
                {hit.count ? (
                  <span className="m3-searchhit-count">{t("search.matchesOnPage", { count: hit.count })}</span>
                ) : null}
                {/* Escaped by `markSafe`, which restores exactly `<mark>` and
                    nothing else — see `lib/site-search.ts`. */}
                <span className="m3-searchhit-excerpt" dangerouslySetInnerHTML={{ __html: hit.excerptHtml }} />
              </a>
            </li>
          ))}
        </ul>
        {outcome?.more ? <p className="m3-searchpanel-more">{t("search.moreResults", { count: hits.length })}</p> : null}
      </div>
    </div>
  );
}
