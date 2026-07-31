/**
 * The site's own search control, with the regex builder anchored beside it.
 *
 * This replaces Starlight's search *button*, not Starlight's search. Pagefind —
 * the index, the integration, the build step — is untouched and is still what
 * answers a plain-text query; see `lib/site-search.ts`. What had to change is the
 * UI, because the rule requires the builder anchored beside the site's search bar
 * and requires that bar to honour both modes, and Pagefind's default UI is a
 * modal dialog with nowhere to put one and no notion of a pattern.
 *
 * Two things fall out of that swap and both are improvements the rule did not ask
 * for. The `@pagefind/default-ui` bundle and its stylesheet are no longer fetched
 * on idle on every page — Pagefind's own core is loaded on the first query
 * instead, which on a phone is the difference between paying for search and
 * paying for search you used. And the results are M3, drawn from the same role
 * tokens as the rest of the site, rather than Pagefind's palette approximated
 * through eight CSS variables.
 *
 * Server-rendered rather than `client:only`, deliberately. The trigger's markup
 * depends on nothing in `localStorage`, so it is in the HTML the moment the page
 * lands: a reader on a slow connection sees a search control immediately, and it
 * becomes live when the island hydrates. The tab strip cannot do that — its
 * contents *are* persisted state — which is why it is the one island here that
 * is `client:only`.
 *
 * Everything behind the trigger is `lazy()`: the panel, the builder and the regex
 * engine arrive on the first open and never before. A reader who came to read a
 * page pays for a button.
 */

import { Suspense, lazy, useCallback, useEffect, useId, useRef, useState } from "react";
import { useChromeT } from "../lib/i18n/use-ui";
import type { DocsLocale } from "../lib/routes";
import { Icon } from "./ui";

const SiteSearchPanel = lazy(() => import("./SiteSearchPanel"));

export interface SiteSearchProps {
  /** The documentation locale of the page this mounted in; `root` is English. */
  locale?: string;
}

export default function SiteSearch({ locale = "root" }: SiteSearchProps) {
  /*
    The reader's chosen interface language, not the page's content locale.

    Two axes: which translation of an *article* you are reading (the URL) and
    what the *chrome* speaks (a stored preference, English / 廣東話 / bilingual
    / one of the documentation languages). `useChromeT` resolves the second,
    defaulting to "follow the page" — so with no preference set this is exactly
    `translator(<content locale>)` and nothing here changes. See
    `lib/i18n/index.ts`.
  */
  const t = useChromeT(locale as DocsLocale);
  const id = useId();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  /* Ctrl/Cmd+K anywhere, and `/` when the reader is not already typing. Both are
     what a documentation reader's fingers expect; the `/` guard is what stops it
     from swallowing a slash inside a pattern they are building. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(prev => !prev);
        return;
      }
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable]")) return;
      event.preventDefault();
      setOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="m3-sitesearch" ref={wrapRef}>
      <button
        type="button"
        ref={triggerRef}
        className="m3-sitesearch-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-keyshortcuts="Control+K"
        aria-label={t("search.open")}
        title={`${t("search.open")} — ${t("search.hint")}`}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span className="m3-sitesearch-icon" aria-hidden="true">{Icon.search}</span>
        <span className="m3-sitesearch-text" aria-hidden="true">{t("search.label")}</span>
        <kbd className="m3-sitesearch-kbd" aria-hidden="true">/</kbd>
      </button>
      {open ? (
        <Suspense fallback={null}>
          <SiteSearchPanel id={`${id}-panel`} t={t} locale={locale} anchorRef={wrapRef} onDismiss={close} />
        </Suspense>
      ) : null}
    </div>
  );
}
