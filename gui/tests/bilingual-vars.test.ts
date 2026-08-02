/**
 * A bilingual sentence with a bilingual name inside it.
 *
 * `t(key, { name })` resolves the template for both tracks and then substitutes
 * `name` into the joined result. That is correct for a number or a model id and
 * wrong for anything that came out of `t()` itself, because the value is already
 * `English · 廣東話` — so it lands in both halves and the English name ends up
 * sitting inside the Cantonese clause.
 *
 * It went unnoticed until the screenshots moved to bilingual mode and the
 * element context menu was photographed reading:
 *
 *   Edit appearance: Filled buttons · 實心按鈕 · 改外觀：Filled buttons · 實心按鈕
 */

import { describe, expect, test } from "bun:test";
import { translate, translateWithBilingualVars } from "../src/i18n/resolve";
import type { FunnyLevels } from "../src/i18n/shared";

const FUNNY: FunnyLevels = { en: 3, yue: 3 };
const KEY = "appearance.editElement";

describe("interpolating a bilingual value into a bilingual template", () => {
  test("the plain path doubles the name — this is what it used to render", () => {
    // Kept as a test rather than a comment so the difference is a fact rather
    // than a claim. If `translate` ever stops doing this the new behaviour
    // should be looked at, not silently inherited.
    const name = translate("bi", FUNNY, "appearance.elButton");
    const doubled = translate("bi", FUNNY, KEY, { name });
    expect(name).toContain(" · ");
    // The name appears in both halves of the joined template.
    expect(doubled.split(name).length - 1).toBe(2);
  });

  test("the per-track path puts each name in its own clause", () => {
    const name = translate("bi", FUNNY, "appearance.elButton");
    const [english, cantonese] = name.split(" · ");
    const phrase = translateWithBilingualVars("bi", FUNNY, KEY, { name });

    expect(phrase).toContain(english!);
    expect(phrase).toContain(cantonese!);
    // Each half exactly once — that is the whole fix.
    expect(phrase.split(english!).length - 1).toBe(1);
    expect(phrase.split(cantonese!).length - 1).toBe(1);
  });

  test("a value with no Cantonese half is used unchanged in both", () => {
    // A model id, a port, a count. Splitting those would be wrong, and dropping
    // them from the Cantonese clause would be worse.
    const phrase = translateWithBilingualVars("bi", FUNNY, KEY, { name: "gpt-5.6-sol" });
    expect(phrase.split("gpt-5.6-sol").length - 1).toBe(2);
  });

  test("single-language modes are untouched", () => {
    for (const locale of ["en", "yue"] as const) {
      const name = translate(locale, FUNNY, "appearance.elButton");
      expect(translateWithBilingualVars(locale, FUNNY, KEY, { name }))
        .toBe(translate(locale, FUNNY, KEY, { name }));
    }
  });
});
