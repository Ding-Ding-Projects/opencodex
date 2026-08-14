/**
 * The rendering half of School Mode: `translate()` forcing English and the
 * neutral funny level and dropping the personal vocabulary while active
 * (`resolve.ts`), and every enumeration a search bar or the command palette
 * reads (`settings-registry.ts`, `command-palette-index.ts`) excluding the
 * suppressed rows — not merely hiding them from one screen's own render.
 *
 * State is injected directly through `setSchoolModeStateForTests()` rather
 * than a fake server, exactly as `school-mode-client.test.ts` documents.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetSchoolModeClientForTests, setSchoolModeStateForTests } from "../src/school-mode/client";
import { translate } from "../src/i18n/resolve";
import { FUNNY_DEFAULT, type FunnyLevels } from "../src/i18n/shared";
import {
  loadVocabularyFile,
  resetVocabularyForTests,
  type VocabStorageLike,
} from "../src/i18n/personal-vocabulary";
import {
  settingsElsewhere,
  settingsRegistryRows,
  visibleSettingsRows,
} from "../src/shell/settings-registry";
import "../src/shell/settings-registry-entries";
import { paletteSettings } from "../src/shell/command-palette-index";

function memoryStorage(): VocabStorageLike & { raw: Map<string, string> } {
  const raw = new Map<string, string>();
  return {
    raw,
    getItem: key => (raw.has(key) ? raw.get(key)! : null),
    setItem: (key, value) => { raw.set(key, value); },
    removeItem: key => { raw.delete(key); },
  };
}

const t = (locale: "en" | "yue" | "bi", funny: FunnyLevels, key: Parameters<typeof translate>[2]) =>
  translate(locale, funny, key);

afterEach(() => {
  resetSchoolModeClientForTests();
  resetVocabularyForTests();
});

describe("translate() forces English while School Mode is active", () => {
  test("a Cantonese-only lookup renders English instead", () => {
    const before = t("yue", { en: 3, yue: 3 }, "nav.dashboard");
    expect(before).not.toBe(t("en", { en: 3, yue: 3 }, "nav.dashboard"));

    setSchoolModeStateForTests({ enabled: true });
    expect(t("yue", { en: 3, yue: 3 }, "nav.dashboard")).toBe(t("en", { en: 3, yue: 3 }, "nav.dashboard"));
  });

  test("bilingual mode renders English-only — no Cantonese half at all", () => {
    setSchoolModeStateForTests({ enabled: true });
    const rendered = t("bi", { en: 3, yue: 3 }, "nav.dashboard");
    expect(rendered).toBe(t("en", { en: 3, yue: 3 }, "nav.dashboard"));
    expect(rendered).not.toContain("·");
  });

  test("reverts to the real locale the instant the mode turns back off", () => {
    setSchoolModeStateForTests({ enabled: true });
    expect(t("yue", { en: 3, yue: 3 }, "nav.dashboard")).toBe(t("en", { en: 3, yue: 3 }, "nav.dashboard"));
    setSchoolModeStateForTests({ enabled: false });
    expect(t("yue", { en: 3, yue: 3 }, "nav.dashboard")).not.toBe(t("en", { en: 3, yue: 3 }, "nav.dashboard"));
  });
});

describe("translate() forces the neutral funny level while School Mode is active", () => {
  test("a voiced key ignores the caller's funny level and renders the level-3 default", () => {
    const extreme: FunnyLevels = { en: 5, yue: 5 };
    const neutral: FunnyLevels = { en: FUNNY_DEFAULT, yue: FUNNY_DEFAULT };
    const before = t("en", extreme, "storage.cleanup.permanentWarn");

    setSchoolModeStateForTests({ enabled: true });
    const forced = t("en", extreme, "storage.cleanup.permanentWarn");
    expect(forced).toBe(t("en", neutral, "storage.cleanup.permanentWarn"));
    // Sanity: the extreme level actually differed from neutral before the
    // mode forced it — otherwise this test would pass for the wrong reason.
    setSchoolModeStateForTests({ enabled: false });
    expect(before).not.toBe(t("en", neutral, "storage.cleanup.permanentWarn"));
  });
});

describe("translate() drops the personal vocabulary while School Mode is active", () => {
  test("an active vocabulary term is not substituted while the mode is on", async () => {
    const storage = memoryStorage();
    const doc = JSON.stringify({ version: 1, entries: { Dashboard: "REPLACED" } });
    await loadVocabularyFile(new File([doc], "v.json"), storage);

    const withVocab = t("en", { en: 3, yue: 3 }, "nav.dashboard");
    expect(withVocab).toBe("REPLACED");

    setSchoolModeStateForTests({ enabled: true });
    const forced = t("en", { en: 3, yue: 3 }, "nav.dashboard");
    expect(forced).not.toBe("REPLACED");
    expect(forced).toBe("Dashboard");
  });
});

describe("the settings registry excludes suppressed rows from every enumeration while active", () => {
  const SUPPRESSED_ROW_IDS = new Set(["funnyEn", "funnyYue", "dimsum", "vocabulary"]);

  beforeEach(() => resetSchoolModeClientForTests());

  test("settingsRegistryRows('language') includes every row when the mode is off", () => {
    const rows = settingsRegistryRows("language");
    for (const id of SUPPRESSED_ROW_IDS) {
      expect(rows.some(r => r.id === id)).toBe(true);
    }
    expect(rows.some(r => r.id === "schoolMode")).toBe(true);
  });

  test("settingsRegistryRows('language') excludes exactly the suppressed rows while active, keeps the rest", () => {
    setSchoolModeStateForTests({ enabled: true });
    const rows = settingsRegistryRows("language");
    for (const id of SUPPRESSED_ROW_IDS) {
      expect(rows.some(r => r.id === id)).toBe(false);
    }
    // Never suppressed: the mode control itself, and an ordinary row like the
    // locale picker or the narrator card.
    expect(rows.some(r => r.id === "schoolMode")).toBe(true);
    expect(rows.some(r => r.id === "mode")).toBe(true);
    expect(rows.some(r => r.id === "narrator")).toBe(true);
  });

  test("a cross-page search (settingsElsewhere) also excludes the suppressed rows while active", () => {
    const dummyT = ((key: string) => key) as Parameters<typeof settingsElsewhere>[1];
    const before = settingsElsewhere("dashboard", dummyT);
    expect(before.some(row => row.label === "vocab.title")).toBe(true);

    setSchoolModeStateForTests({ enabled: true });
    const after = settingsElsewhere("dashboard", dummyT);
    expect(after.some(row => row.label === "vocab.title")).toBe(false);
    expect(after.some(row => row.label === "dimsum.toggle")).toBe(false);
    expect(after.some(row => row.label === "lang.funnyEn")).toBe(false);
    expect(after.some(row => row.label === "lang.funnyYue")).toBe(false);
    // The mode control is still findable from every other screen.
    expect(after.some(row => row.label === "schoolMode.title")).toBe(true);
  });

  test("the command palette's setting index excludes the same suppressed rows while active", () => {
    const dummyT = ((key: string) => key) as Parameters<typeof paletteSettings>[0];
    const before = paletteSettings(dummyT);
    expect(before.some(entry => entry.page === "language" && entry.rowId === "vocabulary")).toBe(true);

    setSchoolModeStateForTests({ enabled: true });
    const after = paletteSettings(dummyT);
    expect(after.some(entry => entry.page === "language" && entry.rowId === "vocabulary")).toBe(false);
    expect(after.some(entry => entry.page === "language" && entry.rowId === "dimsum")).toBe(false);
    expect(after.some(entry => entry.page === "language" && entry.rowId === "funnyEn")).toBe(false);
    expect(after.some(entry => entry.page === "language" && entry.rowId === "funnyYue")).toBe(false);
    expect(after.some(entry => entry.page === "language" && entry.rowId === "schoolMode")).toBe(true);
  });

  test("visibleSettingsRows never mutates the underlying registered row array", () => {
    const before = settingsRegistryRows("language").length;
    setSchoolModeStateForTests({ enabled: true });
    visibleSettingsRows({ page: "language", navKey: "nav.language", rows: settingsRegistryRows("language") });
    setSchoolModeStateForTests({ enabled: false });
    expect(settingsRegistryRows("language").length).toBe(before);
  });
});
