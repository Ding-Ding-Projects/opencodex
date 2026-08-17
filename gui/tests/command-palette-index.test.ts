/**
 * The command palette's index and filter — pure data, no DOM, no React.
 *
 * These tests build the index against the real dictionaries and the real
 * settings registry rather than a hand-built stand-in, so a row that silently
 * stops resolving (a renamed page, a removed setting) fails here rather than
 * only inside the component nobody unit-tests row-by-row.
 */

import { describe, expect, test } from "bun:test";

import {
  buildPaletteIndex, filterPaletteEntries, liveControlSource, paletteDestinations,
  paletteSample, paletteSettings, type PaletteSetting,
} from "../src/shell/command-palette-index";
import { PAGE_META } from "../src/shell/page-meta";
import { settingsRegistrySize } from "../src/shell/settings-registry";
// Registers every settings page, exactly as `command-palette-index.ts` itself
// imports it for. Importing it again here is harmless — re-registration
// replaces rather than appends — and makes this file's own dependency on the
// registry being populated explicit rather than borrowed from import order.
import "../src/shell/settings-registry-entries";
import { translate } from "../src/i18n/resolve";
import type { TFn } from "../src/i18n/shared";

const t: TFn = (key, vars) => translate("en", { en: 3, yue: 3 }, key, vars);

describe("paletteDestinations", () => {
  test("one entry per page, in page-meta order, none missing a label", () => {
    const rows = paletteDestinations(t);
    expect(rows).toHaveLength(PAGE_META.length);
    expect(rows.map(r => r.page)).toEqual(PAGE_META.map(m => m.id));
    for (const row of rows) {
      expect(row.label.trim().length, row.page).toBeGreaterThan(0);
      expect(row.kind).toBe("destination");
    }
  });
});

describe("paletteSettings", () => {
  test("carries every row the cross-page registry has, none dropped or duplicated", () => {
    const rows = paletteSettings(t);
    expect(rows).toHaveLength(settingsRegistrySize());
    const ids = new Set(rows.map(r => r.entryId));
    expect(ids.size).toBe(rows.length);
  });

  test("every row's label actually resolved to something a user would read", () => {
    for (const row of paletteSettings(t)) {
      expect(row.label.trim().length, `${row.page}:${row.rowId}`).toBeGreaterThan(0);
      expect(row.tabLabel.trim().length, `${row.page}:${row.rowId}`).toBeGreaterThan(0);
    }
  });

  /**
   * The completeness guard for the live-control mapping: every entry in
   * `command-palette-index.ts`'s private `LIVE_CONTROL_KINDS` table names a
   * `(page, row id)` pair that has to actually exist in the registry, or the
   * mapping is dead — a row that was meant to render a real control and
   * silently renders a readout instead because the key it was filed under
   * does not match anything. There is no live count to compare against
   * without exporting the table itself, so this asserts the number the table
   * is known to hold today; a mapping that stops resolving drops this number,
   * and the test — not a screenshot six months later — is what says so.
   */
  test("every declared live-control mapping actually resolved to a real row", () => {
    const live = paletteSettings(t).filter(row => row.live !== null);
    expect(live).toHaveLength(20);
  });

  test("appearance:theme, language:mode and storage:enabled are wired live", () => {
    const byId = new Map(paletteSettings(t).map(row => [`${row.page}:${row.rowId}`, row]));
    expect(byId.get("appearance:theme")?.live).toBe("theme");
    expect(byId.get("language:mode")?.live).toBe("locale");
    expect(byId.get("storage:enabled")?.live).toBe("policyEnabled");
  });

  test("a row with no live mapping is simply null, not some other falsy value", () => {
    const byId = new Map(paletteSettings(t).map(row => [`${row.page}:${row.rowId}`, row]));
    // `api.keys` has no live wiring — its whole editor is the API key manager.
    expect(byId.get("api:keys")?.live).toBeNull();
  });
});

describe("liveControlSource", () => {
  test("prefs-backed kinds never depend on a loaded snapshot", () => {
    for (const kind of ["theme", "seed", "density", "fontScale", "fontWeight", "locale", "funnyEn", "funnyYue", "narrator"] as const) {
      expect(liveControlSource(kind)).toBe("prefs");
    }
  });

  test("everything else reads the Settings page's staged snapshot", () => {
    for (const kind of [
      "codexAutoStart", "shadowCall", "maMode", "multiAgentGuidance", "syncCodexSubagentDefaults",
      "policyEnabled", "policySchedule", "debugDebug", "debugUsage", "debugInjection", "debugClaude",
    ] as const) {
      expect(liveControlSource(kind)).toBe("snapshot");
    }
  });
});

describe("buildPaletteIndex", () => {
  test("destinations come before settings, and nothing is lost either side", () => {
    const index = buildPaletteIndex(t);
    expect(index).toHaveLength(PAGE_META.length + settingsRegistrySize());
    const firstSettingIndex = index.findIndex(entry => entry.kind === "setting");
    expect(index.slice(0, firstSettingIndex).every(entry => entry.kind === "destination")).toBe(true);
    expect(index.slice(firstSettingIndex).every(entry => entry.kind === "setting")).toBe(true);
  });
});

describe("filterPaletteEntries", () => {
  const index = buildPaletteIndex(t);

  test("an empty query returns the whole index untouched", () => {
    const { results, error } = filterPaletteEntries(index, "", false);
    expect(error).toBeNull();
    expect(results).toHaveLength(index.length);
  });

  test("plain text narrows to entries whose label, description, keywords or tab actually contain it", () => {
    const { results, error } = filterPaletteEntries(index, "Density", false);
    expect(error).toBeNull();
    expect(results.length).toBeGreaterThan(0);
    expect(results.some(entry => entry.kind === "setting" && entry.label === "Density")).toBe(true);
    // Narrowed, not merely non-empty: something unrelated has to have dropped out.
    expect(results.length).toBeLessThan(index.length);
  });

  test("plain text is case-insensitive, exactly like every other settings search in the app", () => {
    const upper = filterPaletteEntries(index, "DENSITY", false).results.length;
    const lower = filterPaletteEntries(index, "density", false).results.length;
    expect(upper).toBeGreaterThan(0);
    expect(upper).toBe(lower);
  });

  test("regex mode matches the whole corpus a row is searched by, anchors and all", () => {
    // A destination's corpus is its bare label — nothing else is joined in for
    // a page — so an anchored pattern that matches only the exact string proves
    // this runs a real regex rather than a disguised substring search: a plain
    // "Appearance" query also matches every setting row whose tab is Appearance,
    // and this must not.
    const { results } = filterPaletteEntries(index, "^Appearance$", true);
    // Asserted as a property rather than a count. A settings row is now also
    // labelled exactly "Appearance" (`appearance.title`), so pinning the total
    // at one pinned the size of the index rather than the behaviour under
    // test — and every later lane that adds a row or a page breaks it without
    // anything being wrong.
    //
    // What actually proves this is a real regex is that NOTHING whose corpus is
    // more than the bare string survives an anchored pattern: a settings row
    // joins its description and tab into its corpus, so `^Appearance$` must not
    // reach one.
    expect(results.length).toBeGreaterThan(0);
    expect(results.every(entry => entry.label === "Appearance")).toBe(true);
    expect(results.some(entry => entry.kind === "destination")).toBe(true);
  });

  test("an invalid pattern reports the compile error and matches nothing", () => {
    const { results, error } = filterPaletteEntries(index, "(unterminated", true);
    expect(error).not.toBeNull();
    expect(results).toHaveLength(0);
  });

  test("a destination is found by its own page name and nothing else pollutes the match", () => {
    const { results } = filterPaletteEntries(index, "Appearance", false);
    const destinations = results.filter(entry => entry.kind === "destination");
    // The Appearance page is reachable by its own name, and no OTHER page's
    // label contains the word. Stated that way rather than as a count of one,
    // which also asserted the index's size and broke the moment a later lane
    // added a page.
    expect(destinations.map(entry => entry.page)).toEqual(["appearance"]);
  });
});

describe("paletteSample", () => {
  test("carries real row text the regex builder can be tried against", () => {
    const sample = paletteSample(buildPaletteIndex(t));
    expect(sample).toContain("Density");
    expect(sample.split("\n").length).toBeGreaterThan(50);
  });
});

/** One entry, end to end, to pin the exact shape a row carries. */
test("a known setting row carries the fields the palette actually renders", () => {
  const row = paletteSettings(t).find(r => r.page === "appearance" && r.rowId === "density") as PaletteSetting;
  expect(row).toBeDefined();
  expect(row.label).toBe("Density");
  expect(row.tabLabel).toBe("Appearance");
  expect(row.live).toBe("density");
});
