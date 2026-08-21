/**
 * The personal-vocabulary text boundary: `translate()` in `resolve.ts` is the
 * one function every `t()` call reaches, and this is where the active
 * vocabulary is applied to it — end to end, through the real dictionaries,
 * not through a stub.
 *
 * The load-bearing property under test is ordering: the vocabulary runs on
 * the *resolved template*, strictly before `interpolate()` fills in `{vars}`.
 * That is what keeps a path, a model id, a command or a server's own error
 * text safe from ever being rewritten — they never exist as part of the text
 * this module scans, only as values substituted in afterwards.
 *
 * As with the other two files in this group, no real vocabulary term or
 * replacement appears here — only structural placeholders that make the
 * mechanism checkable without shipping a mapping anyone would actually see.
 * The one deliberate exception is the word "language" itself, used as the
 * matched *term* (never as a replacement) because it happens to appear,
 * lowercase, inside two real dictionary strings this file needs to exercise
 * — `lang.title` ("Interface language") and `narrator.language` ("Narrator
 * language"). Each test states exactly which of the two it expects to change.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { translate } from "../src/i18n/resolve";
import type { FunnyLevels } from "../src/i18n/shared";
import {
  clearVocabulary,
  loadVocabularyFile,
  resetVocabularyForTests,
  VOCAB_SCHEMA_VERSION,
  type VocabStorageLike,
} from "../src/i18n/personal-vocabulary";

const FUNNY: FunnyLevels = { en: 3, yue: 3 };

function makeMemoryStorage(): VocabStorageLike {
  const raw = new Map<string, string>();
  return {
    getItem: (key) => (raw.has(key) ? raw.get(key)! : null),
    setItem: (key, value) => { raw.set(key, value); },
    removeItem: (key) => { raw.delete(key); },
  };
}

async function activate(entries: Record<string, string>): Promise<VocabStorageLike> {
  const storage = makeMemoryStorage();
  const file = new File(
    [JSON.stringify({ version: VOCAB_SCHEMA_VERSION, entries })],
    "vocabulary.json",
    { type: "application/json" },
  );
  const result = await loadVocabularyFile(file, storage);
  if (!result.ok) throw new Error(`test fixture rejected: ${result.reason}`);
  return storage;
}

afterEach(() => {
  resetVocabularyForTests();
});

describe("with no vocabulary loaded — the default, and every existing caller's assumption", () => {
  test("translate() is completely unaffected by this module even existing", () => {
    // A real dictionary key, resolved the ordinary way. If this module changed
    // behaviour merely by being imported, every other i18n test in the suite
    // would already be failing.
    expect(translate("en", FUNNY, "lang.title")).toBe("Interface language");
    expect(translate("yue", FUNNY, "lang.title")).not.toBe("");
    expect(translate("bi", FUNNY, "lang.title")).toContain("Interface language");
  });
});

describe("replacement applies to authored prose", () => {
  test("a term appearing in the resolved English template is replaced", async () => {
    // "language" (lowercase) is the literal second word of both
    // "Interface language" and "Narrator language" — exercise the latter.
    await activate({ language: "STAND-IN-TERM" });
    expect(translate("en", FUNNY, "narrator.language")).toBe("Narrator STAND-IN-TERM");
  });

  test("clearing removes the effect immediately, restoring the original wording", async () => {
    const storage = await activate({ language: "STAND-IN-TERM" });
    expect(translate("en", FUNNY, "narrator.language")).toBe("Narrator STAND-IN-TERM");
    clearVocabulary(storage);
    expect(translate("en", FUNNY, "narrator.language")).toBe("Narrator language");
  });

  test("a term with no match anywhere in the resolved template changes nothing", async () => {
    await activate({ "zzz-no-such-word-zzz": "irrelevant" });
    expect(translate("en", FUNNY, "lang.title")).toBe("Interface language");
  });

  test("the longer of two colliding terms wins, matched as a whole phrase", async () => {
    // Both terms genuinely collide: "language" is a literal substring of the
    // phrase "Narrator language". Without longest-first matching, the shorter
    // term would fire at its own position and leave "Narrator SHORT-MATCH"
    // instead of the whole phrase being replaced as the unit the user asked
    // for.
    await activate({
      "Narrator language": "LONG-MATCH",
      language: "SHORT-MATCH",
    });
    expect(translate("en", FUNNY, "narrator.language")).toBe("LONG-MATCH");
  });

  test("a replacement is never itself re-scanned for a further match", async () => {
    // language → STAGE-ONE, and STAGE-ONE happens to also be a term some other
    // rule maps onward to STAGE-TWO. If the engine looped, "Narrator language"
    // would become "Narrator STAGE-TWO" instead of stopping at the first
    // substitution — a cascading edit the user never asked for and could not
    // predict from their file alone.
    await activate({ language: "STAGE-ONE", "STAGE-ONE": "STAGE-TWO" });
    expect(translate("en", FUNNY, "narrator.language")).toBe("Narrator STAGE-ONE");
  });
});

describe("the boundary never touches interpolated variables", () => {
  test("a var value that happens to equal an active term is left completely alone", async () => {
    // lang.funnyLevel's template is "Level {n}". Map a term that collides with
    // a plausible variable value and pass exactly that value as {n}.
    await activate({ Level: "SHOULD-NOT-APPEAR" });
    const result = translate("en", FUNNY, "lang.funnyLevel", { n: "Level" });
    // The literal word "Level" in the *template* is replaced; the *value*
    // substituted for {n} is the string "Level" verbatim, because it was never
    // part of the text this module scanned.
    expect(result).toBe("SHOULD-NOT-APPEAR Level");
  });

  test("a numeric var is never coerced through the vocabulary matcher", async () => {
    await activate({ "5": "FIVE-REPLACED" });
    const result = translate("en", FUNNY, "lang.funnyLevel", { n: 5 });
    expect(result).toBe("Level 5");
  });

  test("a path-shaped var survives byte for byte even when a vocabulary term would match a substring of it", async () => {
    await activate({ debug: "STAND-IN" });
    const result = translate("en", FUNNY, "narrator.edgeFailed", { reason: "C:\\Users\\debug\\vocabulary.json" });
    expect(result).toContain("C:\\Users\\debug\\vocabulary.json");
  });
});

describe("placeholders themselves are never corrupted", () => {
  test("a term equal to a placeholder's inner name does not rewrite the token", async () => {
    // If replacement ran over the raw template without protecting
    // `{placeholder}` spans, a term literally named "n" would turn "{n}" into
    // "{REPLACED}", which `interpolate()` cannot recognise — the value would
    // render as a literal, broken `{REPLACED}` in the UI instead of the number.
    await activate({ n: "REPLACED" });
    const result = translate("en", FUNNY, "lang.funnyLevel", { n: 4 });
    expect(result).toBe("Level 4");
    expect(result).not.toContain("{");
    expect(result).not.toContain("REPLACED");
  });
});

describe("bilingual mode applies the vocabulary to each track independently", () => {
  test("an English term is only replaced in the English half", async () => {
    await activate({ language: "ENG-ONLY" });
    const result = translate("bi", FUNNY, "narrator.language");
    const [english, cantonese] = result.split(" · ");
    expect(english).toBe("Narrator ENG-ONLY");
    // The Cantonese half ("旁白語言") never contained the English word
    // "language" to begin with, so it is unaffected.
    expect(cantonese).toBeDefined();
    expect(cantonese).not.toContain("ENG-ONLY");
  });

  test("vars still land in each track's own language after vocabulary substitution", async () => {
    await activate({ Level: "TERM" });
    const result = translate("bi", FUNNY, "lang.funnyLevel", { n: 2 });
    expect(result).toContain("2");
  });
});

describe("the settings-save style callers — vars carrying already-translated names — stay correct", () => {
  test("a translated setting name threaded through as a var is not re-scanned by the vocabulary a second time", async () => {
    // Mirrors the real shape `use-settings-save.ts` builds: one t() call's
    // output ("Interface language", with the vocabulary already applied to
    // it once) passed as a var into a second t() call. The outer template
    // ("The server kept its own value for {names}. ...") does not itself
    // contain the word "language", so the only occurrence of the replacement
    // must come from the one substitution that already happened inside the
    // inner call — never a second one applied to the interpolated result.
    await activate({ language: "REPLACED-INNER" });
    const name = translate("en", FUNNY, "lang.title"); // "Interface REPLACED-INNER"
    expect(name).toBe("Interface REPLACED-INNER");
    const body = translate("en", FUNNY, "settings.saveRefusedBody", { names: name });
    const occurrences = body.split("REPLACED-INNER").length - 1;
    expect(occurrences).toBe(1);
  });
});
