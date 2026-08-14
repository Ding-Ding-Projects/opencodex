/**
 * "The disclosure line stays exact at every funny level and in both
 * languages" — checked the same way `bilingual-vars.test.ts` checks its own
 * claims: through `translate()`, the exact path `t()` calls, rather than by
 * reading `voice.ts` and trusting that nothing later overrides it.
 *
 * The toy-lock and Support Tickets disclosure keys are deliberately absent
 * from `voice.ts`'s curated overlay (see that file's own doc comment: an
 * unregistered key falls through to the neutral dictionary at every level).
 * This test is what would fail if someone "helpfully" added a playful variant
 * for one of them later — the fact that has to survive every level is that
 * the wording never changes at all, not merely that it stays truthful.
 */

import { describe, expect, test } from "bun:test";
import { translate } from "../src/i18n/resolve";
import type { FunnyLevels } from "../src/i18n/shared";

const LEVELS = [1, 2, 3, 4, 5] as const;
const DISCLOSURE_KEYS = ["lock.disclosureToy", "support.disclosure"] as const;

describe("disclosure copy never changes across the funny-level slider", () => {
  for (const key of DISCLOSURE_KEYS) {
    test(`${key} — English`, () => {
      const strings = new Set(LEVELS.map(level => translate("en", { en: level, yue: 3 }, key)));
      expect(strings.size).toBe(1);
    });

    test(`${key} — Cantonese`, () => {
      const strings = new Set(LEVELS.map(level => translate("yue", { en: 3, yue: level }, key)));
      expect(strings.size).toBe(1);
    });

    test(`${key} — bilingual mode`, () => {
      const strings = new Set(LEVELS.map(level => translate("bi", { en: level, yue: level }, key)));
      expect(strings.size).toBe(1);
    });
  }
});

describe("the disclosure line states the facts it has to state, in English", () => {
  test("the toy-lock disclosure says it is not security", () => {
    const text = translate("en", { en: 3, yue: 3 } as FunnyLevels, "lock.disclosureToy");
    expect(text.toLowerCase()).toContain("not a security boundary");
    expect(text.toLowerCase()).toContain("not encryption");
  });

  test("the Support Tickets disclosure says nothing is sent, no network request, nobody reading", () => {
    const text = translate("en", { en: 3, yue: 3 } as FunnyLevels, "support.disclosure");
    const lower = text.toLowerCase();
    expect(lower).toContain("nothing here is sent anywhere");
    expect(lower).toContain("no network request");
    expect(lower).toContain("nobody is reading");
  });
});
