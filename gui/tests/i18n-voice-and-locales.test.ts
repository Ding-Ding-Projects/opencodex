/**
 * The baseline language contract: English, Hong Kong Cantonese, and a bilingual
 * mode — plus a funny level that actually reaches rendered copy.
 *
 * Both were shipping as claims rather than behaviour: the locale list held
 * neither Cantonese nor a bilingual mode, and the two sliders persisted a number
 * no renderer ever read.
 */

import { describe, expect, test } from "bun:test";

import { LOCALES, voiceLangsFor, readFunny, type Locale } from "../src/i18n/shared";
import { hasVoice, voiceCoverage, voiceFor } from "../src/i18n/voice";
import { yue } from "../src/i18n/yue";

describe("baseline locales", () => {
  test("English, Cantonese and a bilingual mode are all offered", () => {
    const codes = LOCALES.map(l => l.code);
    expect(codes).toContain("en");
    expect(codes).toContain("yue");
    expect(codes).toContain("bi");
  });

  test("Cantonese is tagged zh-HK, not zh-CN", () => {
    // The html lang drives font selection and screen-reader pronunciation. A
    // Cantonese page tagged zh-CN gets read in Mandarin.
    expect(LOCALES.find(l => l.code === "yue")?.htmlLang).toBe("zh-HK");
  });

  test("bilingual mode renders both tracks; every other locale renders one", () => {
    expect(voiceLangsFor("bi")).toEqual(["en", "yue"]);
    expect(voiceLangsFor("yue")).toEqual(["yue"]);
    for (const code of ["en", "de", "ko", "zh", "ru", "ja"] as Locale[]) {
      expect(voiceLangsFor(code)).toEqual(["en"]);
    }
  });

  test("the Cantonese dictionary is written Cantonese, not Mandarin", () => {
    // Spot-check the particles that separate 廣東話 from written Standard
    // Chinese. A dictionary full of 的/是/沒有 would be zh-CN under a yue label.
    const joined = Object.values(yue).join("");
    for (const marker of ["嘅", "冇", "咗", "喺"]) {
      expect(joined).toContain(marker);
    }
  });

  test("technical identifiers survive translation", () => {
    // A reader has to be able to type these. Translating `--help` or `ocx`
    // would make the instruction unusable.
    expect(yue["terminal.fullScreenWarn"]).toContain("--help");
    expect(yue["launch.installRestart"]).toContain("PATH");
  });
});

describe("funny level", () => {
  test("the level actually changes wording, in both tracks", () => {
    for (const lang of ["en", "yue"] as const) {
      const one = voiceFor(lang, "storage.cleanup.permanentWarn", 1);
      const five = voiceFor(lang, "storage.cleanup.permanentWarn", 5);
      expect(one).toBeTruthy();
      expect(five).toBeTruthy();
      expect(one).not.toBe(five);
    }
  });

  test("destructive copy keeps its facts at every level", () => {
    // The whole rule: voice varies, facts do not. Level 5 is still allowed to
    // be funny — it is not allowed to leave out that this cannot be undone.
    for (const level of [1, 2, 3, 4, 5] as const) {
      const en = voiceFor("en", "storage.cleanup.permanentWarn", level);
      if (en) {
        expect(en.toLowerCase()).toMatch(/delete|gone|vaporised/);
        expect(en.toLowerCase()).toMatch(/undo|no take-backs|point of no return/);
      }
      const yueText = voiceFor("yue", "storage.cleanup.permanentWarn", level);
      if (yueText) {
        expect(yueText).toMatch(/刪除|灰飛煙滅/);
        expect(yueText).toMatch(/復原|返轉頭|後悔|undo|喊都冇用/);
      }
    }
  });

  test("interpolation placeholders survive every variant", () => {
    // A variant that drops {label} renders a sentence about nothing.
    for (const level of [1, 2, 3, 4, 5] as const) {
      for (const lang of ["en", "yue"] as const) {
        for (const key of ["launch.installed", "launch.installFailed"] as const) {
          const text = voiceFor(lang, key, level);
          if (text) expect(text).toContain("{label}");
        }
      }
    }
  });

  test("a key with no variant falls through rather than inventing one", () => {
    expect(voiceFor("en", "nav.dashboard", 5)).toBeNull();
    expect(hasVoice("en", "nav.dashboard")).toBe(false);
  });

  test("coverage is reported as a real number the settings screen can state", () => {
    expect(voiceCoverage("en")).toBeGreaterThan(0);
    expect(voiceCoverage("yue")).toBeGreaterThan(0);
  });

  test("a corrupt stored level clamps instead of reaching CSS or copy", () => {
    const store = { getItem: () => JSON.stringify({ en: 99, yue: -4 }) };
    expect(readFunny(store)).toEqual({ en: 3, yue: 3 });
  });

  test("unreadable storage yields the neutral default", () => {
    const store = { getItem: () => { throw new Error("blocked"); } };
    expect(readFunny(store)).toEqual({ en: 3, yue: 3 });
  });
});
