/**
 * Searching a settings surface.
 *
 * The case that justifies the whole design is "search by current value": a
 * reader who remembers setting the weight to 700 types 700, not "weight". A
 * search that only indexed labels would tell them no such setting exists while
 * it sits two rows down.
 *
 * The permissive-on-empty case matters as much: a settings panel that empties
 * itself the moment its search field is focused — or while a pattern is
 * half-typed and does not yet compile — is a panel the reader has to fight to
 * use.
 */

import { describe, expect, test } from "bun:test";
import { tabMatcher } from "../../shared/m3/tabs";
import {
  haystackOf,
  readOptionsFrom,
  searchSettings,
  searchSettingsQuery,
  type OptionElement,
  type SettingOption,
} from "../src/lib/settings-search";

const OPTIONS: SettingOption[] = [
  { id: "theme", label: "Theme", description: "Light, dark or follow the system", value: "dark", tab: "Appearance" },
  { id: "seed", label: "Accent colour", description: "Seed every role is derived from", value: "#2F6B4F", tab: "Appearance" },
  { id: "weight", label: "Weight", description: "Interface font weight", value: "700", tab: "Appearance" },
  { id: "lang", label: "Language mode", description: "English, Cantonese or both", value: "English", tab: "Language" },
];

const search = (query: string, regex = false, tab = "Appearance") =>
  searchSettingsQuery(OPTIONS, query, regex, "i", tab);

describe("searchSettings", () => {
  test("finds a setting by its label", () => {
    expect(search("theme").matches.map(o => o.id)).toEqual(["theme"]);
  });

  test("finds a setting by its description", () => {
    expect(search("derived").matches.map(o => o.id)).toEqual(["seed"]);
  });

  test("finds a setting by the value it is currently showing", () => {
    expect(search("700").matches.map(o => o.id)).toEqual(["weight"]);
    expect(search("#2f6b4f").matches.map(o => o.id)).toEqual(["seed"]);
  });

  test("a match on another tab is reported, not hidden and not mixed in", () => {
    const result = search("cantonese");
    expect(result.matches).toHaveLength(0);
    expect(result.elsewhere.map(o => o.id)).toEqual(["lang"]);
    expect(result.otherTabs).toEqual(["Language"]);
  });

  test("an empty query shows the current tab in full", () => {
    const result = search("");
    expect(result.matches).toHaveLength(3);
    expect(result.elsewhere).toHaveLength(0);
  });

  test("a pattern that does not compile yet leaves the panel usable", () => {
    const result = search("(unclosed", true);
    expect(result.matches).toHaveLength(3);
  });

  test("regex is a real pattern over label, description and value", () => {
    expect(search("weigh?t", true).matches.map(o => o.id)).toEqual(["weight"]);
    expect(search("#[0-9a-f]{6}", true).matches.map(o => o.id)).toEqual(["seed"]);
  });

  test("without the m flag an anchored pattern sees one joined string, as it should", () => {
    // The default flags are `i`, the same as every other search bar here, so
    // `^Weight$` anchors to the whole haystack and finds nothing. That is the
    // engine behaving correctly, and the builder's flag chips are how a reader
    // asks for `m` — which is what the next case does.
    expect(search("^Weight$", true).matches).toHaveLength(0);
  });

  test("the total counts the current tab, not the whole app", () => {
    expect(search("zzz").total).toBe(3);
  });

  test("an anchored pattern can still reach a single field", () => {
    // The fields are newline-joined precisely so `m` can anchor to one of them.
    const result = searchSettings(OPTIONS, tabMatcher("^700$", true, "im"), "Appearance");
    expect(result.matches.map(o => o.id)).toEqual(["weight"]);
  });
});

describe("haystackOf", () => {
  test("carries all three searchable fields", () => {
    expect(haystackOf(OPTIONS[0]!)).toBe("Theme\nLight, dark or follow the system\ndark");
  });
});

describe("readOptionsFrom", () => {
  /** A stand-in for an element, so the scraper is testable without a DOM. */
  const el = (attrs: Record<string, string>, children: Record<string, string> = {}, text = ""): OptionElement => ({
    getAttribute: name => attrs[name] ?? null,
    querySelector: selector => (selector in children ? { textContent: children[selector]! } : null),
    textContent: text,
  });

  test("reads the four attributes the markup declares", () => {
    const [option] = readOptionsFrom([
      el({
        "data-setting-id": "density",
        "data-setting-label": "Density",
        "data-setting-desc": "Spacing",
        "data-setting-value": "4",
        "data-setting-tab": "Appearance",
      }),
    ], "Fallback");
    expect(option).toEqual({ id: "density", label: "Density", description: "Spacing", value: "4", tab: "Appearance" });
  });

  test("a row with no id is not a row", () => {
    expect(readOptionsFrom([el({ "data-setting-label": "Orphan" })], "Appearance")).toHaveLength(0);
  });

  test("falls back to the row's own text rather than reporting an unnamed setting", () => {
    const [option] = readOptionsFrom([el({ "data-setting-id": "x" }, {}, "  Text size 120%  ")], "Appearance");
    expect(option!.label).toBe("Text size 120%");
  });

  test("reads a label and a value out of child elements", () => {
    const [option] = readOptionsFrom([
      el({ "data-setting-id": "font" }, { "[data-setting-label]": "Typeface", "[data-setting-value]": "Geist" }),
    ], "Appearance");
    expect(option!.label).toBe("Typeface");
    expect(option!.value).toBe("Geist");
  });

  test("a row with no tab of its own inherits the surface it was read from", () => {
    const [option] = readOptionsFrom([el({ "data-setting-id": "x", "data-setting-label": "X" })], "Appearance");
    expect(option!.tab).toBe("Appearance");
  });
});
