/**
 * What the command palette can find, and how it filters that list.
 *
 * This is the "which feature contract is missing" module: every user-facing app
 * is supposed to ship `Ctrl+Shift+F` opening a palette that lists every command,
 * every page and every setting in the app — and this one had none of that at
 * all, in any form. Building it from a blank slate meant deciding what the
 * index actually *is* before deciding how to render it, which is what this file
 * does and `CommandPalette.tsx` does not: no React, no DOM, a plain array a test
 * can build and filter without mounting anything.
 *
 * Two kinds of row, from two sources that already exist and already agree with
 * each other:
 *
 *  - **Destinations** are `page-meta.ts`'s `PAGE_META` — the same 23 pages the
 *    nav rail and the tab strip already navigate by. A destination is "go to
 *    this page", nothing more.
 *  - **Settings** are `settings-registry.ts`'s cross-page index — the same 80
 *    rows across 14 pages that every settings search bar in the app already
 *    reports as "elsewhere". This module reads the registry directly rather
 *    than through `settingsElsewhere`, because that helper deliberately drops
 *    the page id and row id once a hit is reported (a settings search only
 *    ever needs to *name* the other screen) — and the palette needs both to
 *    teleport to the exact row, and to know which rows this build can wire to
 *    a live control (`liveControlKindFor`) rather than only a readout.
 *
 * Building the index costs one pass over `PAGE_META` and the registry, each
 * translated once through the caller's `t`. It is cheap enough to rebuild on
 * every render rather than memoized here — `CommandPalette.tsx` owns that
 * decision, this module only owns the shape of the data.
 */

import { PAGE_META, type PageMeta } from "./page-meta";
import { settingsRegistryPages, visibleSettingsRows, type SettingsPageId } from "./settings-registry";
// Registers every settings page's rows as a side effect. Imported here, not
// only from `use-settings-search.ts`, so the palette's index is complete even
// on a build where nothing else happened to import the registrations first.
import "./settings-registry-entries";
import { DEFAULT_SEARCH_FLAGS, settingsMatcher } from "./settings-search";
import { SAMPLE_CAP } from "../regex/engine";
import type { Page } from "../app-routing";
import type { TFn } from "../i18n/shared";

/**
 * A row this build can wire to the real control it edits, rather than to a
 * readout. Each name is a `(page, row id)` pair away from being ambiguous —
 * `dashboard:multiAgent` and `models:contextCap` are different settings even
 * though nothing about the string "multiAgent" says so — which is exactly why
 * `LIVE_CONTROL_KINDS` below is keyed by the pair rather than by the kind alone.
 */
export type LiveControlKind =
  | "theme" | "seed" | "density" | "fontScale" | "fontWeight"
  | "locale" | "funnyEn" | "funnyYue" | "narrator"
  | "codexAutoStart" | "shadowCall" | "maMode"
  | "multiAgentGuidance" | "syncCodexSubagentDefaults"
  | "policyEnabled" | "policySchedule"
  | "debugDebug" | "debugUsage" | "debugInjection" | "debugClaude";

/**
 * Where a live kind's current value actually lives.
 *
 * `"prefs"` rows read `usePrefs()` / `useI18n()` — state the draft coordinator
 * holds unconditionally from the moment the app starts, whether or not the
 * screen that edits it has ever been opened. `"snapshot"` rows read the
 * server-backed fields `Settings.tsx` stages through `useSettingsDrafts()`,
 * which are `null` until that specific page has loaded them at least once this
 * session — Dashboard, Storage and Logs each keep their own local state for
 * their own cards, and duplicating each of those fetch paths here just to light
 * up a palette row was judged not worth the surface area it would add. A
 * snapshot row therefore renders live once `Settings` has been opened once, and
 * an honest "not loaded yet" readout before that — never a control that looks
 * live and silently does nothing.
 */
export type LiveControlSource = "prefs" | "snapshot";

const LIVE_CONTROL_KINDS: Readonly<Record<string, LiveControlKind>> = {
  "appearance:theme": "theme",
  "appearance:seed": "seed",
  "appearance:density": "density",
  "appearance:fontScale": "fontScale",
  "appearance:fontWeight": "fontWeight",
  "language:mode": "locale",
  "language:funnyEn": "funnyEn",
  "language:funnyYue": "funnyYue",
  "language:narrator": "narrator",
  "dashboard:codexAutoStart": "codexAutoStart",
  "dashboard:shadowCall": "shadowCall",
  "dashboard:multiAgent": "maMode",
  "dashboard:multiAgentGuidance": "multiAgentGuidance",
  "dashboard:syncCodexSubagentDefaults": "syncCodexSubagentDefaults",
  "storage:enabled": "policyEnabled",
  "storage:schedule": "policySchedule",
  "logs:debug": "debugDebug",
  "logs:usage": "debugUsage",
  "logs:injection": "debugInjection",
  "logs:claude": "debugClaude",
};

const PREFS_KINDS = new Set<LiveControlKind>([
  "theme", "seed", "density", "fontScale", "fontWeight", "locale", "funnyEn", "funnyYue", "narrator",
]);

export function liveControlKindFor(page: SettingsPageId, rowId: string): LiveControlKind | null {
  return LIVE_CONTROL_KINDS[`${page}:${rowId}`] ?? null;
}

export function liveControlSource(kind: LiveControlKind): LiveControlSource {
  return PREFS_KINDS.has(kind) ? "prefs" : "snapshot";
}

export interface PaletteDestination {
  kind: "destination";
  entryId: string;
  page: Page;
  label: string;
  group: PageMeta["group"];
}

export interface PaletteSetting {
  kind: "setting";
  entryId: string;
  page: Page;
  rowId: string;
  label: string;
  desc?: string;
  keywords?: string;
  /** The owning page's nav label, translated — where a "go to" for this row lands. */
  tabLabel: string;
  live: LiveControlKind | null;
}

export type PaletteEntry = PaletteDestination | PaletteSetting;

/** Every page the nav already knows about, as a "go to" result. */
export function paletteDestinations(t: TFn): PaletteDestination[] {
  return PAGE_META.map(meta => ({
    kind: "destination",
    entryId: `page:${meta.id}`,
    page: meta.id,
    label: t(meta.tkey),
    group: meta.group,
  }));
}

/** Every setting the cross-page registry knows about, as a "find and teleport" result. */
export function paletteSettings(t: TFn): PaletteSetting[] {
  const out: PaletteSetting[] = [];
  for (const entry of settingsRegistryPages()) {
    const tabLabel = t(entry.navKey);
    for (const row of visibleSettingsRows(entry)) {
      out.push({
        kind: "setting",
        entryId: `setting:${entry.page}:${row.id}`,
        page: entry.page,
        rowId: row.id,
        label: t(row.tkey),
        desc: row.descKey ? t(row.descKey) : undefined,
        keywords: row.keywordKeys?.map(key => t(key)).join(" "),
        tabLabel,
        live: liveControlKindFor(entry.page, row.id),
      });
    }
  }
  return out;
}

/** The whole index: every page, then every setting, in that order. */
export function buildPaletteIndex(t: TFn): PaletteEntry[] {
  return [...paletteDestinations(t), ...paletteSettings(t)];
}

/** Every word one entry is found by. */
export function paletteEntryText(entry: PaletteEntry): string {
  if (entry.kind === "destination") return entry.label;
  return [entry.label, entry.desc, entry.keywords, entry.tabLabel].filter(Boolean).join(" ");
}

export interface PaletteFilterResult {
  results: PaletteEntry[];
  /** Regex compile failure verbatim; `null` while the pattern is usable. */
  error: string | null;
}

/**
 * Plain text by default, regex on explicit opt-in — the same `settingsMatcher`
 * every other search bar in the app compiles through, so the palette can never
 * disagree with a settings screen about what one pattern matches.
 */
export function filterPaletteEntries(
  entries: readonly PaletteEntry[],
  query: string,
  useRegex: boolean,
  flags: string = DEFAULT_SEARCH_FLAGS,
): PaletteFilterResult {
  const matcher = settingsMatcher(query, useRegex, flags);
  return { results: entries.filter(entry => matcher.test(paletteEntryText(entry))), error: matcher.error };
}

/** The corpus handed to the anchored regex builder, so a pattern is tried against real rows. */
export function paletteSample(entries: readonly PaletteEntry[]): string {
  return entries.map(paletteEntryText).join("\n").slice(0, SAMPLE_CAP);
}
