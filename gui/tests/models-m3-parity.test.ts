import { expect, test } from "bun:test";

import { makeMatcher, MODELS_SETTING_IDS } from "../src/pages/models-shared";

const source = () => Bun.file(new URL("../src/pages/Models.tsx", import.meta.url)).text();

test("Models renders the prototype's inline context label and search-miss copy", async () => {
  const src = await source();
  // "350k ctx", not "Context 350k" — the prototype puts the unit after the number.
  expect(src).toContain("models.ctxValue");
  expect(src).not.toMatch(/t\("models\.tipContext"\)\}\s*\{fmtK/);
  // A search that finds nothing says so; it must not borrow the dashboard's string.
  expect(src).toContain("models.noMatch");
  expect(src).not.toContain("dash.modelsNoResults");
  // The screen lead is body-large at a 74ch measure, not the legacy body-small sub.
  expect(src).toContain("m3-page-lead");
});

test("Models carries a settings search bound to its own field, plus a builder on both bars", async () => {
  const src = await source();
  expect(src).toContain("settings.search");
  expect(src).toContain("settings.noMatch");
  expect(src).toContain("settings.openBuilder");
  expect(src).toContain("search.openBuilder");
  // Two independent fields: the settings query must never be fed by the model query.
  expect(src).toContain("setSettingsQuery(e.target.value)");
  expect(src).toContain("setQuery(e.target.value)");
  expect(src).toMatch(/settingsRegex/);
  // Every settings row on the screen is gated by the settings matcher.
  for (const id of MODELS_SETTING_IDS) {
    expect(src).toContain(`settingMatches("${id}")`);
  }
});

test("makeMatcher keeps plain text the default and reports a broken pattern instead of guessing", () => {
  expect(makeMatcher("", false).test("anything")).toBe(true);
  // A regex metacharacter is a literal until the user opts in.
  expect(makeMatcher("gpt.5", false).test("gpt-5")).toBe(false);
  expect(makeMatcher("gpt.5", true).test("gpt-5")).toBe(true);
  expect(makeMatcher("GPT", false).test("openai/gpt-5")).toBe(true);

  const broken = makeMatcher("(unclosed", true);
  expect(broken.error).toBeTruthy();
  // An unusable pattern matches nothing, so the reported error and the result agree.
  expect(broken.test("anything")).toBe(false);

  // 400-character cap: a longer pattern is truncated rather than compiled whole.
  const long = makeMatcher(`${"a".repeat(400)}b`, true);
  expect(long.error).toBeNull();
  expect(long.test("a".repeat(400))).toBe(true);
});
