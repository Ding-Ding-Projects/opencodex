/**
 * The funny level restyles the voice and never the facts.
 *
 * That sentence is the whole promise, and it is the kind of promise that decays
 * silently: someone writes a level-5 variant that is funnier than the neutral
 * one and drops the file path, or the placeholder, or the word "export" that
 * told the reader what to do instead. Nothing about that fails a build, and
 * reading the table does not catch it either — the level-5 line reads *better*
 * than the one it broke.
 *
 * So this file does not check that the wording is funny. It re-derives, from
 * each entry's own **neutral** wording, the tokens that carry the fact — every
 * `{placeholder}`, and every literal a reader has to act on (`YYYY-MM-DD`, an
 * ALL-CAPS term) — and asserts they survive all five rungs in both languages.
 * The neutral wording is the level-3 string in the shipped dictionary, so the
 * fixture cannot drift from the product: there is only one copy of it.
 */

import { describe, expect, test } from "bun:test";
import { VOICE_TABLE } from "../src/lib/i18n/voice";
import { tTrack, voice } from "../src/lib/i18n";
import type { UiKey } from "../src/lib/i18n/keys";
import { FUNNY_LEVELS, VOICE_CATEGORIES, type FunnyLevel, type VoiceLang } from "../../shared/m3/i18n";

const KEYS = Object.keys(VOICE_TABLE) as UiKey[];
const TRACKS: VoiceLang[] = ["en", "yue"];

/**
 * The tokens a variant is not allowed to lose.
 *
 * Derived from the neutral string rather than listed by hand, so adding a voiced
 * key does not also mean remembering to add its facts to a fixture — the day
 * that is forgotten is the day the test stops protecting anything.
 */
function facts(neutral: string): string[] {
  const out = new Set<string>();
  for (const [, name] of neutral.matchAll(/\{(\w+)\}/g)) out.add(`{${name}}`);
  // Formats and identifiers a reader has to reproduce exactly. Two or more
  // upper-case letters, so ordinary sentence capitals are not swept in.
  for (const [token] of neutral.matchAll(/\b[A-Z][A-Z0-9-]{2,}\b/g)) out.add(token);
  return [...out];
}

describe("every voiced key", () => {
  test("there are some, and they are addressable", () => {
    expect(KEYS.length).toBeGreaterThan(15);
    for (const key of KEYS) expect(voice.categoryOf(key)).not.toBeNull();
  });

  test("both tracks vary at exactly the same rungs", () => {
    for (const key of KEYS) {
      const en = voice.levelsFor("en", key);
      const yue = voice.levelsFor("yue", key);
      // One track voiced at four rungs beside another voiced at two is how one
      // language ends up two levels louder than the other for the same message.
      expect(`${key}:${yue.join(",")}`).toBe(`${key}:${en.join(",")}`);
    }
  });

  test("level 3 is never restated in the overlay", () => {
    // The shipped dictionary IS level 3. A copy here would be a second string to
    // keep in step, and the first drift makes the slider lie.
    for (const key of KEYS) {
      for (const track of TRACKS) {
        expect(`${key}/${track}`).toBe(`${key}/${track}`);
        expect(voice.stringFor(track, key, 3)).toBeNull();
      }
    }
  });

  test("no rung is empty or whitespace", () => {
    for (const key of KEYS) {
      for (const track of TRACKS) {
        for (const level of FUNNY_LEVELS) {
          const value = voice.stringFor(track, key, level);
          if (value === null) continue;
          expect(`${key}/${track}/${level}`).toBe(`${key}/${track}/${level}`);
          expect(value.trim().length).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe("the facts survive every rung", () => {
  for (const track of TRACKS) {
    test(`${track}: placeholders and formats are carried at all five levels`, () => {
      for (const key of KEYS) {
        const neutral = tTrack(track, 3, key);
        const required = facts(neutral);
        if (!required.length) continue;
        for (const level of FUNNY_LEVELS) {
          const rendered = tTrack(track, level as FunnyLevel, key);
          for (const token of required) {
            // The label makes a failure name the key, the track and the level
            // rather than printing two long sentences and leaving the reader to
            // diff them.
            expect(`${key}/${track}/${level} missing ${token}`)
              .toBe(rendered.includes(token) ? `${key}/${track}/${level} missing ${token}` : `${key}/${track}/${level} HAS ${token}`);
          }
        }
      }
    });
  }

  test("a destructive message still names what is destroyed, at maximum playfulness", () => {
    // Spot-checked in words as well as by token, because "history" is the fact
    // and a generic "all gone!" would pass a placeholder check.
    expect(tTrack("en", 5, "notif.historyCleared").toLowerCase()).toContain("history");
    expect(tTrack("yue", 5, "notif.historyCleared")).toContain("通知記錄");
  });

  test("an error still names the way out, at maximum playfulness", () => {
    expect(tTrack("en", 5, "changelog.copyFailed").toLowerCase()).toContain("export");
    expect(tTrack("yue", 5, "changelog.copyFailed")).toContain("匯出");
  });

  test("the security statement still says nothing leaves the browser", () => {
    for (const level of FUNNY_LEVELS) {
      expect(tTrack("en", level as FunnyLevel, "settings.lead").toLowerCase()).toContain("browser");
      expect(tTrack("yue", level as FunnyLevel, "settings.lead")).toContain("瀏覽器");
    }
  });

  test("the disclosure always admits it restyles warnings and errors", () => {
    for (const level of FUNNY_LEVELS) {
      const en = tTrack("en", level as FunnyLevel, "funny.disclosure").toLowerCase();
      expect(en).toContain("error");
      expect(en).toContain("warning");
      const yue = tTrack("yue", level as FunnyLevel, "funny.disclosure");
      expect(yue).toContain("警告");
      expect(yue).toContain("錯誤");
    }
  });
});

describe("category coverage", () => {
  const counts = voice.categoryCoverage();

  test("financial is the only empty category, and that is a fact about the site", () => {
    // A documentation site shows no prices, balances or billing, so there is
    // nothing in that category to restyle. Asserting it is the ONLY empty one is
    // what makes the first paid surface landing here fail this test instead of
    // quietly shipping an unvoiced warning.
    const empty = VOICE_CATEGORIES.filter(category => counts[category] === 0);
    expect(empty).toEqual(["financial"]);
  });

  test("the categories that carry weight are all covered", () => {
    for (const category of ["destructive", "security", "error", "warning", "accessibility"] as const) {
      expect(`${category}:${counts[category] > 0}`).toBe(`${category}:true`);
    }
  });

  test("coverage is reported as a real number, not implied", () => {
    // The settings screen states this ratio. It must be the count of keys that
    // genuinely carry level-specific wording, not the size of the deck.
    expect(voice.coverage("en")).toBe(KEYS.length);
    expect(voice.coverage("yue")).toBe(KEYS.length);
  });
});
