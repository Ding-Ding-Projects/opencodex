/**
 * A bilingual sentence with a bilingual value inside it.
 *
 * `t(key, { name })` used to resolve the template for both tracks, join them,
 * and only then substitute `name` into the joined result. That is correct for a
 * number or a model id and wrong for anything that came out of `t()` itself,
 * because the value is already `English · 廣東話` — so it landed in both halves
 * and the English name ended up sitting inside the Cantonese clause.
 *
 * It went unnoticed until the screenshots moved to bilingual mode and the
 * element context menu was photographed reading:
 *
 *   Edit appearance: Filled buttons · 實心按鈕 · 改外觀：Filled buttons · 實心按鈕
 *
 * The first repair was an opt-in helper used by that one menu, which left the
 * broken path as the default — so the same shape reached the settings-save
 * notices and the cross-tab search notes before anyone looked again. `translate`
 * now resolves per track for every caller, and these tests hold that line at
 * both ends: the bilingual path splits the pairs, and the single-language path
 * is left exactly as it was.
 */

import { describe, expect, test } from "bun:test";
import { joinBilingual, translate } from "../src/i18n/resolve";
import type { FunnyLevels, Locale } from "../src/i18n/shared";

const FUNNY: FunnyLevels = { en: 3, yue: 3 };
const KEY = "appearance.editElement";
const SEP = " · ";

/** How many times `needle` occurs in `haystack`. */
const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe("interpolating a bilingual value into a bilingual template", () => {
  test("each half of the name lands in its own clause, exactly once", () => {
    const name = translate("bi", FUNNY, "appearance.elButton");
    const [english, cantonese] = name.split(SEP);
    expect(cantonese).toBeDefined();

    const phrase = translate("bi", FUNNY, KEY, { name });

    expect(phrase).toContain(english!);
    expect(phrase).toContain(cantonese!);
    // Once each — that is the whole fix. Before it, both appeared twice.
    expect(occurrences(phrase, english!)).toBe(1);
    expect(occurrences(phrase, cantonese!)).toBe(1);
    // And the whole pair never survives intact inside one clause.
    expect(occurrences(phrase, name)).toBe(0);
  });

  test("a value with no Cantonese half is used unchanged in both", () => {
    // A model id, a port, a count. Splitting those would be wrong, and dropping
    // them from the Cantonese clause would be worse.
    const phrase = translate("bi", FUNNY, KEY, { name: "gpt-5.6-sol" });
    expect(occurrences(phrase, "gpt-5.6-sol")).toBe(2);
  });

  test("a value carrying several separators is left alone rather than mangled", () => {
    // Two separators is not a pair, so there is no honest way to tell the halves
    // apart. It falls back to the old behaviour — whole value in both clauses —
    // which reads as repetition rather than as shuffled words.
    const value = `alpha${SEP}beta${SEP}gamma`;
    const phrase = translate("bi", FUNNY, KEY, { name: value });
    expect(occurrences(phrase, value)).toBe(2);
  });
});

describe("the single-language path is untouched", () => {
  const SINGLE: Locale[] = ["en", "yue", "de", "ko", "zh", "ru", "ja"];

  test("a value containing the separator is never split", () => {
    // The separator is only meaningful in bilingual mode. Anywhere else it is an
    // ordinary character in an ordinary value — a joined path, a server message
    // — and splitting it would silently drop half of what the user was told.
    const value = `first${SEP}second`;
    for (const locale of SINGLE) {
      const phrase = translate(locale, FUNNY, KEY, { name: value });
      expect(phrase).toContain(value);
      expect(occurrences(phrase, value)).toBe(1);
    }
  });

  test("a bilingual-looking name renders whole, as it always did", () => {
    for (const locale of SINGLE) {
      const name = `${translate("en", FUNNY, "appearance.elButton")}${SEP}${translate("yue", FUNNY, "appearance.elButton")}`;
      expect(translate(locale, FUNNY, KEY, { name })).toContain(name);
    }
  });
});

describe("joining a list of translated names", () => {
  test("a list of pairs becomes one pair, not an interleaved run", () => {
    const language = translate("bi", FUNNY, "lang.title");
    const appearance = translate("bi", FUNNY, "nav.appearance");
    expect(language).toContain(SEP);
    expect(appearance).toContain(SEP);

    const joined = joinBilingual([language, appearance], ", ");

    // Exactly one separator: the list is still something the sentence it is
    // pasted into can take apart. A plain `join(", ")` would leave two.
    expect(occurrences(joined, SEP)).toBe(1);
    const [english, cantonese] = joined.split(SEP);
    expect(english).toBe(`${language.split(SEP)[0]}, ${appearance.split(SEP)[0]}`);
    expect(cantonese).toBe(`${language.split(SEP)[1]}, ${appearance.split(SEP)[1]}`);
  });

  test("a name with no Cantonese half sits in both groups", () => {
    const language = translate("bi", FUNNY, "lang.title");
    const joined = joinBilingual([language, "gpt-5.6-sol"], ", ");
    expect(occurrences(joined, "gpt-5.6-sol")).toBe(2);
  });

  test("with nothing bilingual in it, it is exactly a plain join", () => {
    // Every single-language locale takes this path, and so does a bilingual list
    // whose names are all untranslated. Adding a separator there would print the
    // same list twice, which is the rule bilingual joining has always followed.
    expect(joinBilingual(["alpha", "beta"], ", ")).toBe("alpha, beta");
    expect(joinBilingual([], ", ")).toBe("");
    expect(joinBilingual(["only"], ", ")).toBe("only");
  });
});

describe("the settings-save notices, end to end", () => {
  // The shape `use-settings-save` builds: a joined list of translated setting
  // names, plus a reason quoted verbatim from the browser or the server.
  const namesFor = (keys: Parameters<typeof translate>[2][], locale: Locale) =>
    joinBilingual(keys.map(key => translate(locale, FUNNY, key)), ", ");

  test("each setting name appears once per clause, and the reason in both", () => {
    const reason = "QuotaExceededError";
    const names = namesFor(["lang.title", "nav.appearance"], "bi");
    const body = translate("bi", FUNNY, "settings.saveUnpersistedBody", { names, reason });

    for (const key of ["lang.title", "nav.appearance"] as const) {
      const [english, cantonese] = translate("bi", FUNNY, key).split(SEP);
      expect(occurrences(body, english!)).toBe(1);
      expect(occurrences(body, cantonese!)).toBe(1);
    }
    // The reason is not translated, so it belongs in both clauses unchanged.
    expect(occurrences(body, reason)).toBe(2);
  });

  test("the refused notice names its settings once per clause", () => {
    const names = namesFor(["dash.codexAutoStart", "debug.debug"], "bi");
    const body = translate("bi", FUNNY, "settings.saveRefusedBody", { names });

    for (const key of ["dash.codexAutoStart", "debug.debug"] as const) {
      const [english, cantonese] = translate("bi", FUNNY, key).split(SEP);
      expect(occurrences(body, english!)).toBe(1);
      expect(occurrences(body, cantonese!)).toBe(1);
    }
  });

  test("the error notice keeps the server's own message in both clauses", () => {
    const reason = "503 upstream unavailable";
    const names = namesFor(["debug.usage"], "bi");
    const body = translate("bi", FUNNY, "settings.saveErrorBody", { names, reason });

    const [english, cantonese] = translate("bi", FUNNY, "debug.usage").split(SEP);
    expect(occurrences(body, english!)).toBe(1);
    expect(occurrences(body, cantonese!)).toBe(1);
    expect(occurrences(body, reason)).toBe(2);
  });

  test("in English the notice is one clause with one copy of everything", () => {
    const reason = "QuotaExceededError";
    const names = namesFor(["lang.title", "nav.appearance"], "en");
    const body = translate("en", FUNNY, "settings.saveUnpersistedBody", { names, reason });

    expect(body).toContain(names);
    expect(occurrences(body, reason)).toBe(1);
    expect(body).not.toContain(SEP);
  });
});
