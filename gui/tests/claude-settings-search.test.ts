import { expect, test } from "bun:test";
import { en } from "../src/i18n/en";
import { M3_EN } from "../src/i18n/m3";
import type { TFn, Vars } from "../src/i18n/shared";
import {
  CLAUDE_SETTING_IDS,
  claudeSettingsIndex,
  claudeSettingsSearch,
} from "../src/pages/claude-settings-search";

const DICT: Record<string, string> = { ...M3_EN, ...en };
const t: TFn = (key, vars?: Vars) => {
  let out = DICT[key] ?? key;
  for (const name of Object.keys(vars ?? {})) out = out.split(`{${name}}`).join(String(vars![name]));
  return out;
};

test("every indexed setting resolves real copy, not a raw key", () => {
  const index = claudeSettingsIndex(t);
  for (const id of CLAUDE_SETTING_IDS) {
    expect(index[id].trim().length).toBeGreaterThan(0);
    // A missing key falls through to the key itself, which would ship "claude.foo"
    // into a search haystack and silently make that setting unfindable by name.
    expect(index[id]).not.toContain("claude.");
  }
});

// An untouched field has not matched anything, here or anywhere else — so it must not
// hide a single control. This is the difference between "search" and "filter by default".
test("an empty query hides nothing and claims no cross-tab hits", () => {
  const search = claudeSettingsSearch("", false, t);
  expect(search.active).toBe(false);
  expect(search.otherHits).toBe(0);
  for (const id of CLAUDE_SETTING_IDS) expect(search.matches(id)).toBe(true);
});

test("plain text is the default and matches case-insensitively on label and description", () => {
  const search = claudeSettingsSearch("SUBSCRIPTION", false, t);
  expect(search.matches("authMode")).toBe(true);
  expect(search.matches("aliases")).toBe(false);
  expect(search.hits).toBeGreaterThan(0);
});

// Plain text stays plain: a regex metacharacter typed without the `.*` opt-in is a
// literal, so a user searching for "1M" cannot accidentally run a pattern.
test("regex metacharacters are literal until the caller opts in", () => {
  expect(claudeSettingsSearch("auto.*mode", false, t).hits).toBe(0);
  expect(claudeSettingsSearch("auto.*summarize", true, t).matches("autoCompactWindow")).toBe(true);
});

test("an invalid pattern reports itself and matches nothing", () => {
  const search = claudeSettingsSearch("model(", true, t);
  expect(search.error).not.toBeNull();
  expect(search.hits).toBe(0);
  expect(search.matches("modelMap")).toBe(false);
});

// A miss on this surface can still point somewhere: the Desktop tab owns the per-family
// default and the profile import/export, and saying "no match" about them would be a lie.
test("a hit that lives on the Desktop tab is reported by tab name", () => {
  const search = claudeSettingsSearch(t("claudeDesktop.exportJson"), false, t);
  expect(search.otherHits).toBeGreaterThan(0);
  expect(search.otherTabs).toEqual([t("claude.tabDesktop")]);
});

test("a query that matches nothing anywhere reports no hits on either side", () => {
  const search = claudeSettingsSearch("zzz-not-a-setting", false, t);
  expect(search.active).toBe(true);
  expect(search.hits).toBe(0);
  expect(search.otherHits).toBe(0);
});
