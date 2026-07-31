/**
 * The search bar every settings surface has to carry.
 *
 * "A user who knows a setting's name should be able to type it anywhere settings
 * live and land on it" — including the small nested panel this mounts in today.
 * The appearance panel is six rows; it is exactly the surface someone would call
 * obviously scannable, and the rule says no surface is exempt for being small.
 *
 * It filters the panel it is mounted in by toggling `hidden` on the rows, rather
 * than by re-rendering them. The panel is Astro-rendered markup with vanilla
 * listeners bound to it, and a React island that re-rendered those rows would
 * take ownership of controls whose behaviour lives somewhere else — the sliders
 * would keep their bindings and lose their DOM. Toggling visibility leaves every
 * existing binding intact and is a change the panel cannot notice.
 *
 * Values are re-read on every `input` and `change` inside the panel, which is
 * what makes searching by *current value* honest: type "700" and the weight row
 * is the one that stays, because the row is now showing 700.
 *
 * `client:visible` at the call site, and that is load-bearing: the panel starts
 * `hidden`, a hidden element never intersects, so this island costs nothing at
 * all until somebody opens appearance settings. On a phone that is the whole
 * budget difference between a settings search and no settings search.
 *
 * What it deliberately does NOT do: own the settings, restyle the rows, or
 * remove them from the DOM. A hidden row is still there for the panel's own code
 * and comes back the moment the query is cleared.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChromeT } from "../lib/i18n/use-ui";
import type { DocsLocale } from "../lib/routes";
import { useSearchQuery } from "../lib/use-search-query";
import { readOptionsFrom, searchSettings, type SettingOption } from "../lib/settings-search";
import { SearchBar } from "./RegexBuilder";

export interface SettingsSearchProps {
  /** Documentation locale, for the copy. */
  locale?: string;
  /** The name of the surface these rows belong to, shown in the cross-tab message. */
  tab: string;
  /**
   * CSS selector for the container holding the rows, resolved from this island's
   * own position. Defaults to the nearest `[data-settings-root]`.
   */
  rootSelector?: string;
}

export default function SettingsSearch({ locale = "root", tab, rootSelector }: SettingsSearchProps) {
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
  const state = useSearchQuery();
  const hostRef = useRef<HTMLDivElement>(null);
  const [options, setOptions] = useState<SettingOption[]>([]);

  /** The container whose `[data-setting-id]` rows this search owns. */
  const rootOf = useCallback((): HTMLElement | null => {
    const host = hostRef.current;
    if (!host) return null;
    return rootSelector
      ? host.closest<HTMLElement>(rootSelector) ?? document.querySelector<HTMLElement>(rootSelector)
      : host.closest<HTMLElement>("[data-settings-root]");
  }, [rootSelector]);

  const rescan = useCallback(() => {
    const root = rootOf();
    if (!root) return;
    setOptions(readOptionsFrom(Array.from(root.querySelectorAll<HTMLElement>("[data-setting-id]")), tab));
  }, [rootOf, tab]);

  /* Re-read on mount and whenever a control in the panel moves, so a value
     search is answering about the panel as it is now rather than as it was when
     the island hydrated. */
  useEffect(() => {
    rescan();
    const root = rootOf();
    if (!root) return;
    root.addEventListener("input", rescan);
    root.addEventListener("change", rescan);
    root.addEventListener("click", rescan);
    return () => {
      root.removeEventListener("input", rescan);
      root.removeEventListener("change", rescan);
      root.removeEventListener("click", rescan);
    };
  }, [rescan, rootOf]);

  const result = useMemo(
    () => searchSettings(options, state.matcher, tab),
    [options, state.matcher, tab],
  );

  /* Apply the filter to the real rows. The cleanup un-hides everything, so
     unmounting this island can never leave a settings panel with rows the reader
     cannot get back. */
  useEffect(() => {
    const root = rootOf();
    if (!root) return;
    const keep = new Set(result.matches.map(option => option.id));
    const rows = Array.from(root.querySelectorAll<HTMLElement>("[data-setting-id]"));
    for (const row of rows) {
      const id = row.getAttribute("data-setting-id");
      row.hidden = !!id && !keep.has(id);
    }
    return () => { for (const row of rows) row.hidden = false; };
  }, [result.matches, rootOf]);

  const sample = useMemo(
    () => options.map(option => `${option.label} ${option.value}`).join("\n"),
    [options],
  );

  return (
    <div className="m3-settings-search" ref={hostRef}>
      <SearchBar
        t={t}
        state={state}
        searchLabel={t("settings.search")}
        placeholder={t("settings.searchPh")}
        sample={sample}
      />
      <p className="m3-settings-searchstatus" role="status" aria-live="polite">
        {result.matches.length === 0
          ? t("settings.none")
          : t("settings.shown", { shown: result.matches.length, total: result.total })}
        {result.otherTabs.length
          ? ` — ${t("settings.elsewhere", { count: result.elsewhere.length, tabs: result.otherTabs.join(", ") })}`
          : ""}
      </p>
    </div>
  );
}
