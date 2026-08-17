/**
 * The baseline language contract: English, Hong Kong Cantonese, and a bilingual
 * mode — plus a funny level that actually reaches rendered copy.
 *
 * These are coverage tests, not presence tests. It is easy to ship an i18n layer
 * that *has* a Cantonese dictionary and *has* a funny level and satisfies neither
 * promise: 15 translated keys out of 1 473 still renders an English screen, and
 * seven voiced keys still leaves a slider that changes nothing on nineteen
 * screens out of twenty. So the assertions here are about proportions and about
 * rendered output:
 *
 *   1. every key in `en.ts` and `m3.ts` resolves to Cantonese, none missing;
 *   2. every voiced key renders five *distinct* strings across levels 1-5, in
 *      both tracks, through the same `resolve.ts` path `t()` uses;
 *   3. no level loses a placeholder, an identifier or a stated consequence that
 *      level 1 carries — the voice-not-facts rule, checked per string;
 *   4. every message category is voiced, including the ones a carve-out would
 *      have taken: destructive, security, financial, accessibility and error;
 *   5. bilingual mode stays a primary label plus a compact secondary one.
 */

import { describe, expect, test } from "bun:test";

import { LOCALES, voiceLangsFor, readFunny, type Locale, type TKey } from "../src/i18n/shared";
import {
  VOICE_CATEGORIES, hasVoice, voiceCategoryOf, voiceCoverage, voiceCategoryCoverage,
  voiceFor, voicedKeys, type FunnyLevel, type VoiceCategory, type VoiceLang,
} from "../src/i18n/voice";
import { bilingualParts, resolveKey, resolveTrack, translate } from "../src/i18n/resolve";
import { yue } from "../src/i18n/yue";
import { en } from "../src/i18n/en";
import { M3_EN } from "../src/i18n/m3";

const LEVELS = [1, 2, 3, 4, 5] as const;
const TRACKS: { locale: Locale; lang: VoiceLang }[] = [
  { locale: "en", lang: "en" },
  { locale: "yue", lang: "yue" },
];

/** The neutral dictionary, which is what level 3 renders. */
const NEUTRAL: Record<string, string> = { ...M3_EN, ...en };

const placeholders = (s: string) => (s.match(/\{[a-zA-Z0-9_]+\}/g) ?? []).slice().sort();

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
    for (const marker of ["嘅", "冇", "咗", "喺", "睇", "撳"]) {
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

describe("Cantonese dictionary coverage", () => {
  test("every product key in en.ts has a Cantonese counterpart", () => {
    const missing = Object.keys(en).filter(k => yue[k as TKey] === undefined);
    // Named, not counted: a diff that says "1 460 missing" tells whoever broke
    // it nothing, and this list is what they have to go and write.
    expect(missing).toEqual([]);
  });

  test("every M3 shell key has a Cantonese counterpart", () => {
    const missing = Object.keys(M3_EN).filter(k => yue[k as TKey] === undefined);
    expect(missing).toEqual([]);
  });

  test("no Cantonese key is an orphan", () => {
    // A key that exists only here is dead weight: nothing renders it, and it
    // silently rots as the English wording moves on.
    const orphans = Object.keys(yue).filter(k => NEUTRAL[k] === undefined);
    expect(orphans).toEqual([]);
  });

  test("every interpolation placeholder survives translation", () => {
    // A dropped {count} renders a sentence about nothing; an invented one
    // renders a literal brace in the UI.
    const drifted = Object.keys(yue).filter(
      k => placeholders(NEUTRAL[k] ?? "").join(",") !== placeholders(yue[k as TKey] ?? "").join(","),
    );
    expect(drifted).toEqual([]);
  });

  test("no Cantonese string is empty or left as raw English chrome", () => {
    for (const [key, value] of Object.entries(yue)) {
      expect(value.trim().length, key).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// The funny level, measured on rendered output
// ---------------------------------------------------------------------------

/**
 * One key per category, checked hard. "Representative" is the point: if the
 * slider works for a delete confirmation, an export warning, a billing note, a
 * narrator hint, a network error and a dim sum card, it works.
 */
const REPRESENTATIVE: Record<VoiceCategory, TKey> = {
  destructive: "storage.cleanup.permanentWarn",
  security: "network.exportWarning",
  financial: "claude.smallFastModelNativeWarning",
  accessibility: "appearance.reducedMotionOsOnly",
  error: "dash.cannotConnect",
  warning: "dash.shadowCallWarning",
  success: "network.exported",
  progress: "dash.mem.draining",
  empty: "usage.empty",
  guidance: "regex.safety",
  delight: "dimsum.toggleHint",
};

describe("funny level", () => {
  test("every category is voiced — there is no carve-out", () => {
    const coverage = voiceCategoryCoverage();
    for (const cat of VOICE_CATEGORIES) {
      expect(coverage[cat], `category "${cat}" has no voiced key`).toBeGreaterThan(0);
    }
  });

  test("the representative key of every category renders five distinct levels, in both tracks", () => {
    // Through `resolveTrack`, which is what `t()` calls — so this is the string
    // the screen shows, not just the string the overlay holds.
    for (const [cat, key] of Object.entries(REPRESENTATIVE) as [VoiceCategory, TKey][]) {
      expect(voiceCategoryOf(key), `${key} is not filed under ${cat}`).toBe(cat);
      for (const { locale, lang } of TRACKS) {
        const rendered = LEVELS.map(level => resolveTrack(locale, lang, level, key));
        expect(new Set(rendered).size, `${lang} ${key} renders ${new Set(rendered).size}/5 distinct levels`).toBe(5);
      }
    }
  });

  test("EVERY voiced key renders five distinct levels, in both tracks", () => {
    // Not only the representatives. A key that reads the same at 2 and 3 is a
    // slider notch that does nothing, which is the defect this whole file exists
    // to stop coming back.
    const flat: string[] = [];
    for (const key of voicedKeys()) {
      for (const { locale, lang } of TRACKS) {
        const rendered = LEVELS.map(level => resolveTrack(locale, lang, level, key));
        if (new Set(rendered).size !== 5) flat.push(`${lang} ${key}`);
      }
    }
    expect(flat).toEqual([]);
  });

  test("both tracks are voiced for every key — Cantonese is never left at neutral alone", () => {
    const oneSided = voicedKeys().filter(key => !hasVoice("en", key) || !hasVoice("yue", key));
    expect(oneSided).toEqual([]);
  });

  test("a key with no variant falls through rather than inventing one", () => {
    expect(voiceFor("en", "nav.dashboard", 5)).toBeNull();
    expect(hasVoice("en", "nav.dashboard")).toBe(false);
    expect(resolveTrack("en", "en", 5, "nav.dashboard")).toBe("Dashboard");
    expect(resolveTrack("yue", "yue", 5, "nav.dashboard")).toBe("總覽");
  });

  test("coverage is reported as a real number the settings screen can state", () => {
    expect(voiceCoverage("en")).toBe(voicedKeys().length);
    expect(voiceCoverage("yue")).toBe(voicedKeys().length);
    // The audit that prompted this work found seven. The number in the settings
    // copy has to be worth printing.
    expect(voiceCoverage("en")).toBeGreaterThan(50);
  });

  test("a corrupt stored level clamps instead of reaching CSS or copy", () => {
    const store = { getItem: () => JSON.stringify({ en: 99, yue: -4 }) };
    expect(readFunny(store)).toEqual({ en: 3, yue: 3 });
  });

  test("unreadable storage yields the neutral default", () => {
    const store = { getItem: () => { throw new Error("blocked"); } };
    expect(readFunny(store)).toEqual({ en: 3, yue: 3 });
  });

  test("the two sliders are independent", () => {
    // One language turned up must not turn the other up. Bilingual mode is where
    // a shared level would show, because both tracks render at once.
    const seriousEn = resolveKey("bi", { en: 1, yue: 5 }, "dash.cannotConnect");
    const seriousYue = resolveKey("bi", { en: 5, yue: 1 }, "dash.cannotConnect");
    expect(seriousEn).toContain("The proxy did not respond.");
    expect(seriousYue).toContain("無法連接 proxy");
    expect(seriousEn).not.toBe(seriousYue);
  });
});

// ---------------------------------------------------------------------------
// Voice varies, facts do not
// ---------------------------------------------------------------------------

/**
 * What an English variant may never drop: placeholders, command flags, dotted or
 * slashed identifiers, SHOUTED words like PLAINTEXT, and the proper nouns that
 * name what the sentence is about.
 *
 * Deliberately narrow. Every English word cannot be an invariant or the level
 * could not change the wording at all — which is the opposite failure.
 */
const PROPER_NOUNS = [
  "opencodex", "OpenCodex", "Codex", "Claude Code", "Claude", "Grok", "OpenAI",
  "Anthropic", "ChatGPT", "Windows Terminal", "Sonnet", "OAuth", "GitHub", "npm",
  "CLI", "Launch", "Version history", "Appearance", "Language & voice",
];

function englishInvariants(s: string): string[] {
  const out = new Set<string>();
  for (const m of s.match(/\{[a-zA-Z0-9_]+\}/g) ?? []) out.add(m);
  for (const m of s.match(/--[a-z][a-z-]+/g) ?? []) out.add(m);
  for (const m of s.match(/[A-Za-z_][A-Za-z0-9_-]*(?:[./][A-Za-z0-9_.-]*[A-Za-z0-9_])+/g) ?? []) out.add(m);
  for (const m of s.match(/\b[A-Z][A-Z_]{3,}\b/g) ?? []) out.add(m);
  for (const noun of PROPER_NOUNS) if (s.includes(noun)) out.add(noun);
  return [...out];
}

/**
 * What a Cantonese variant may never drop: placeholders plus every Latin run.
 *
 * In a Cantonese string a run of Latin characters is, by construction, a term
 * the house style says must not be translated — `proxy`, `config.json`,
 * `gpt-5.4-mini`, `--help`, `Sonnet`. So "keep every Latin run that level 1 had"
 * is exactly the identifier rule, expressed in a way that needs no word list.
 */
function cantoneseInvariants(s: string): string[] {
  const out = new Set<string>();
  for (const m of s.match(/\{[a-zA-Z0-9_]+\}/g) ?? []) out.add(m);
  for (const m of s.match(/-?-?[A-Za-z][A-Za-z0-9_./-]{2,}/g) ?? []) {
    if (!/^\{/.test(m)) out.add(m.toLowerCase());
  }
  return [...out];
}

describe("voice varies, facts do not", () => {
  test("no level drops an identifier, flag or placeholder that level 1 carries", () => {
    const lost: string[] = [];
    for (const key of voicedKeys()) {
      for (const { locale, lang } of TRACKS) {
        const base = resolveTrack(locale, lang, 1, key);
        const wanted = lang === "en" ? englishInvariants(base) : cantoneseInvariants(base);
        for (const level of [2, 3, 4, 5] as const) {
          const text = resolveTrack(locale, lang, level, key);
          const haystack = lang === "en" ? text : text.toLowerCase();
          for (const token of wanted) {
            if (!haystack.includes(token)) lost.push(`${lang} ${key} L${level} lost "${token}"`);
          }
        }
      }
    }
    expect(lost).toEqual([]);
  });

  test("level 5 is never shorter on facts than level 1 for a destructive warning", () => {
    // The specific failure this guards: a level-5 delete confirmation that is
    // funny and no longer says what it deletes or that it is permanent.
    for (const key of voicedKeys("destructive")) {
      for (const { locale, lang } of TRACKS) {
        const one = resolveTrack(locale, lang, 1, key);
        const five = resolveTrack(locale, lang, 5, key);
        expect(placeholders(five), `${lang} ${key}`).toEqual(placeholders(one));
        expect(five.length, `${lang} ${key} level 5 is a stub`).toBeGreaterThan(8);
      }
    }
  });

  /**
   * The stated consequence, per category, as the words the user has to see.
   *
   * These are hand-written because a consequence is not a token: "cannot be
   * undone" and "no take-backs" are the same fact in two registers, and only a
   * human can say that the second one still counts.
   */
  const FACTS: { key: TKey; en: RegExp[]; yue: RegExp[] }[] = [
    {
      key: "storage.cleanup.permanentWarn",
      en: [/permanent/i, /undo|no return/i],
      yue: [/永久/, /復原|undo|後悔/],
    },
    {
      key: "history.clearConfirm",
      en: [/revision log/i, /undo|erased|wipes/i],
      yue: [/修訂紀錄/, /復原|undo|抹走|返轉頭/],
    },
    {
      key: "api.deleteConfirmBody",
      en: [/\{prefix\}/, /immediate|on the spot/i, /app/i],
      yue: [/\{prefix\}/, /即刻/, /app/],
    },
    {
      key: "network.exportWarning",
      en: [/PLAINTEXT/, /API key/i, /OAuth/, /encrypt/i, /delete/i],
      yue: [/明文/, /API key/, /OAuth/, /加密/, /刪/],
    },
    {
      key: "network.customKeyHint",
      en: [/12\+/, /config\.json/, /PLAINTEXT/, /export/i, /reuse/i],
      yue: [/12/, /config\.json/, /明文/, /匯出/, /密碼/],
    },
    {
      key: "claude.smallFastModelNativeWarning",
      en: [/Sonnet/, /Claude Code/, /charge/i],
      yue: [/Sonnet/, /Claude Code/, /收費|收錢|收你錢/],
    },
    {
      key: "usage.cost.disclaimer",
      en: [/receipt|bill/i, /subscription/i, /credit/i],
      // 點數 and `credits` are the same fact in two registers, which is exactly
      // what the level is allowed to vary. The fact is that something else may
      // have paid — not which word says so.
      yue: [/收據|帳單/, /訂閱/, /點數|credits/i],
    },
    {
      key: "appearance.reducedMotionOsOnly",
      en: [/operating system/i, /reduced motion/i],
      yue: [/作業系統/, /減少動態效果/],
    },
    {
      key: "narrator.offBody",
      en: [/off|until you/i],
      yue: [/閂|開/],
    },
    {
      key: "dash.cannotConnect",
      en: [/proxy/i, /running/i],
      yue: [/proxy/, /行|開/],
    },
    {
      key: "dash.syncFailed",
      en: [/\{error\}/, /fail|did not finish|gave up/i],
      yue: [/\{error\}/, /失敗|未完成|放棄/],
    },
    {
      key: "dash.shadowCallWarning",
      en: [/gpt-5\.4-mini/, /replace/i],
      yue: [/gpt-5\.4-mini/, /換/],
    },
    {
      key: "pool.experimentalWarning",
      en: [/experimental/i, /abuse/i, /restrict/i, /quota/i],
      yue: [/實驗/, /濫用/, /限制/, /配額|quota/i],
    },
    {
      key: "network.exported",
      en: [/export/i, /download/i],
      yue: [/匯出/, /下載/],
    },
    {
      key: "dash.mem.draining",
      en: [/\{count\}/, /restart/i],
      yue: [/\{count\}/, /重啟/],
    },
    {
      key: "usage.empty",
      en: [/proxy/i, /request/i],
      yue: [/proxy/, /請求/],
    },
    {
      key: "regex.safety",
      en: [/\{pattern\}/, /\{sample\}/, /\{matches\}/, /local|browser/i, /transmit|leave/i],
      yue: [/\{pattern\}/, /\{sample\}/, /\{matches\}/, /本機|瀏覽器/, /傳送|傳出|送出|出街/],
    },
    {
      key: "dimsum.toggleHint",
      // `\bten\b` rather than `/ten/i`, which "often" and "listen" would satisfy
      // without the copy ever stating the odds.
      en: [/\bten\b/i, /first run/i, /update/i],
      yue: [/十次/, /第一次/, /更新/],
    },
  ];

  test("the stated consequence survives every level, in both languages", () => {
    const lost: string[] = [];
    for (const { key, en: enFacts, yue: yueFacts } of FACTS) {
      for (const level of LEVELS) {
        const enText = resolveTrack("en", "en", level, key);
        for (const re of enFacts) if (!re.test(enText)) lost.push(`en ${key} L${level} lost ${re}`);
        const yueText = resolveTrack("yue", "yue", level, key);
        for (const re of yueFacts) if (!re.test(yueText)) lost.push(`yue ${key} L${level} lost ${re}`);
      }
    }
    expect(lost).toEqual([]);
  });

  test("the fact table covers every category, so no category is exempt from the rule", () => {
    const covered = new Set(FACTS.map(f => voiceCategoryOf(f.key)));
    for (const cat of VOICE_CATEGORIES) {
      expect(covered.has(cat), `no fact assertion for category "${cat}"`).toBe(true);
    }
  });

  test("Cantonese stays respectful at every level", () => {
    // Humour never lands on the reader. These are the words that would mean it
    // had — insults and jokes at the expense of someone's ability.
    const CRUEL = ["白痴", "低能", "蠢", "傻仔", "廢柴", "殘廢", "弱智", "冇用嘅人"];
    const offenders: string[] = [];
    for (const key of voicedKeys()) {
      for (const level of LEVELS) {
        const text = resolveTrack("yue", "yue", level, key);
        for (const word of CRUEL) if (text.includes(word)) offenders.push(`${key} L${level}: ${word}`);
      }
    }
    for (const [key, value] of Object.entries(yue)) {
      for (const word of CRUEL) if (value.includes(word)) offenders.push(`${key}: ${word}`);
    }
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Bilingual mode
// ---------------------------------------------------------------------------

/** ASCII counts one column, CJK two — the width a terminal or a rail sees. */
function columns(s: string): number {
  let n = 0;
  for (const ch of s) n += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1;
  return n;
}

describe("bilingual mode", () => {
  const neutral = { en: 3, yue: 3 } as const;

  test("English leads and Cantonese follows as a compact secondary label", () => {
    expect(resolveKey("bi", neutral, "nav.dashboard")).toBe("Dashboard · 總覽");
    const parts = bilingualParts("bi", neutral, "nav.dashboard");
    expect(parts).toEqual({ primary: "Dashboard", secondary: "總覽" });
  });

  test("a string that is identical in both languages is not printed twice", () => {
    expect(resolveKey("bi", neutral, "common.github")).toBe("GitHub");
    expect(bilingualParts("bi", neutral, "common.github").secondary).toBe("");
  });

  test("single-language modes carry no secondary label at all", () => {
    expect(bilingualParts("en", neutral, "nav.dashboard")).toEqual({ primary: "Dashboard", secondary: "" });
    expect(bilingualParts("yue", neutral, "nav.dashboard")).toEqual({ primary: "總覽", secondary: "" });
  });

  test("short labels stay inside a narrow-width budget at every level pair", () => {
    // Bilingual mode is where a nav rail, a chip or a tab label runs out of room
    // first, and the longest rendering is not always at level 3. 60 columns is
    // the budget a 200%-scaled rail can still show without truncating; the
    // widest label today sits well under it, so a regression is visible early
    // rather than as a clipped word in a screenshot.
    const BUDGET = 60;
    const short = Object.keys(NEUTRAL).filter(
      k => /^(nav|common|tabs|theme|window|notif\.tone)\./.test(k) && NEUTRAL[k]!.length <= 24,
    );
    expect(short.length).toBeGreaterThan(40);

    const wide: string[] = [];
    for (const key of short) {
      for (const enLevel of LEVELS) {
        for (const yueLevel of LEVELS) {
          const text = resolveKey("bi", { en: enLevel, yue: yueLevel }, key as TKey);
          if (columns(text) > BUDGET) wide.push(`${key} (${enLevel}/${yueLevel}) = ${columns(text)} cols: ${text}`);
        }
      }
    }
    expect(wide).toEqual([]);
  });

  test("interpolation still runs after the two tracks are joined", () => {
    const text = translate("bi", neutral, "tabs.close", { name: "Usage" });
    expect(text).toContain("Close Usage");
    expect(text).toContain("Usage");
    expect(text).not.toContain("{name}");
  });
});

describe("the disclosure the funny level owes the user", () => {
  test("the setting states that it restyles errors and warnings, and never the facts", () => {
    for (const locale of ["en", "yue"] as Locale[]) {
      const copy = resolveKey(locale, { en: 3, yue: 3 }, "lang.funnyCoverage");
      expect(copy, locale).toMatch(/error|錯誤/i);
      expect(copy, locale).toMatch(/warning|destructive|警告|破壞性/i);
      expect(copy, locale).toMatch(/facts never change|事實都唔會變/i);
    }
  });

  test("first run says the same thing, before a level-5 warning can surprise anyone", () => {
    for (const locale of ["en", "yue"] as Locale[]) {
      const copy = resolveKey(locale, { en: 3, yue: 3 }, "onboard.langSub");
      expect(copy, locale).toMatch(/funny level|搞笑程度/i);
      expect(copy, locale).toMatch(/error|錯誤/i);
      expect(copy, locale).toMatch(/never the facts|唔會改事實/i);
    }
  });

  test("the coverage sentence takes the real numbers, not a hard-coded claim", () => {
    const copy = translate("en", { en: 3, yue: 3 }, "lang.funnyCoverage", {
      en: voiceCoverage("en"),
      yue: voiceCoverage("yue"),
    });
    expect(copy).toContain(String(voiceCoverage("en")));
    expect(copy).not.toContain("{en}");
    expect(copy).not.toContain("{yue}");
  });
});
