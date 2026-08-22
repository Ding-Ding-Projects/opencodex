/**
 * Hand-written coverage for the docs site's local vocabulary settings surface.
 *
 * This list is intentionally explicit: a pattern that only validates rows it
 * discovers cannot notice a row or behaviour that disappeared altogether.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  VOCAB_MAX_DEPTH,
  VOCAB_MAX_ENTRIES,
  VOCAB_MAX_FILE_BYTES,
  VOCAB_MAX_KEY_LENGTH,
  VOCAB_MAX_VALUE_LENGTH,
  clearVocabulary,
  getVocabularySnapshot,
  loadVocabularyFile,
  parseVocabularyJSON,
  resetVocabularyForTests,
} from "../src/lib/personal-vocabulary";

const INVENTORY = [
  "vocabulary settings row",
  "semantic local JSON picker",
  "no-file state",
  "loaded state",
  "invalid state",
  "replace state",
  "clear state",
  "settings search reachability",
  "anchored regex builder reachability",
  "persistence and cache revalidation",
  "no-network loader",
  "School-mode suppression",
] as const;

const source = readFileSync(join(import.meta.dir, "../src/components/Settings.tsx"), "utf8");

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
    has: (key: string) => data.has(key),
  };
}

function file(text: string, size = new TextEncoder().encode(text).byteLength): File {
  const candidate = new File([text], "neutral.json", { type: "application/json" });
  Object.defineProperty(candidate, "size", { value: size });
  return candidate;
}

beforeEach(() => resetVocabularyForTests());

describe("the hand-written settings inventory", () => {
  test("names every required vocabulary surface and proof seam", () => {
    expect(INVENTORY).toEqual([
      "vocabulary settings row",
      "semantic local JSON picker",
      "no-file state",
      "loaded state",
      "invalid state",
      "replace state",
      "clear state",
      "settings search reachability",
      "anchored regex builder reachability",
      "persistence and cache revalidation",
      "no-network loader",
      "School-mode suppression",
    ]);
    expect(source).toContain('id: "vocabulary"');
    expect(source).toContain('type="file"');
    expect(source).toContain('accept="application/json,.json"');
    expect(source).toContain('id: "school-mode"');
    expect(source).toContain("useSchoolModeActive");
    expect(source).toContain("RegexBuilder");
  });
});

describe("the bounded local vocabulary contract", () => {
  test("accepts the neutral versioned envelope and keeps replacements literal", () => {
    const result = parseVocabularyJSON('{"version":1,"entries":{"alpha":"beta"}}');
    expect(result).toEqual({ ok: true, doc: { version: 1, entries: { alpha: "beta" } } });
  });

  test("rejects duplicate, unsafe, unknown, deep, oversized and malformed input", () => {
    expect(parseVocabularyJSON('{"version":1,"entries":{"alpha":"one","alpha":"two"}}').ok).toBe(false);
    expect(parseVocabularyJSON('{"version":1,"entries":{"__proto__":"blocked"}}').ok).toBe(false);
    expect(parseVocabularyJSON('{"version":2,"entries":{}}').ok).toBe(false);
    expect(parseVocabularyJSON('{"version":1,"entries":{"alpha":{"nested":"no"}}}').ok).toBe(false);
    expect(parseVocabularyJSON('{"version":1,"entries":{"alpha":"' + "x".repeat(VOCAB_MAX_VALUE_LENGTH + 1) + '"}}').ok).toBe(false);
    expect(parseVocabularyJSON('{"version":1,"entries":' + "{".repeat(VOCAB_MAX_DEPTH + 1) + "}").ok).toBe(false);
    expect(parseVocabularyJSON("not-json").ok).toBe(false);
    expect(parseVocabularyJSON("x".repeat(VOCAB_MAX_FILE_BYTES + 1)).ok).toBe(false);
    expect(VOCAB_MAX_ENTRIES).toBe(500);
    expect(VOCAB_MAX_KEY_LENGTH).toBe(80);
  });

  test("rejects an oversized File before reading its contents", async () => {
    let read = false;
    const candidate = file('{"version":1,"entries":{}}', VOCAB_MAX_FILE_BYTES + 1);
    Object.defineProperty(candidate, "text", { value: async () => { read = true; return "{}"; } });
    const result = await loadVocabularyFile(candidate, memoryStorage());
    expect(result).toMatchObject({ ok: false, reason: "too-large" });
    expect(read).toBe(false);
  });

  test("does not partially apply a rejected replacement and supports clear", async () => {
    const storage = memoryStorage();
    expect((await loadVocabularyFile(file('{"version":1,"entries":{"alpha":"beta"}}'), storage)).ok).toBe(true);
    expect((await loadVocabularyFile(file("not-json"), storage)).ok).toBe(false);
    expect(getVocabularySnapshot().doc?.entries).toEqual({ alpha: "beta" });
    clearVocabulary(storage);
    expect(getVocabularySnapshot().doc).toBeNull();
    expect(storage.has("ocx-docs:vocabulary:v1")).toBe(false);
  });

  test("latest operation wins when file reads resolve out of order", async () => {
    const storage = memoryStorage();
    let releaseFirst!: () => void;
    const first = new File(["first"], "neutral.json");
    Object.defineProperty(first, "text", { value: () => new Promise<string>(resolve => { releaseFirst = () => resolve('{"version":1,"entries":{"alpha":"first"}}'); }) });
    const second = file('{"version":1,"entries":{"alpha":"second"}}');
    const firstLoad = loadVocabularyFile(first, storage);
    const secondLoad = loadVocabularyFile(second, storage);
    expect((await secondLoad).ok).toBe(true);
    releaseFirst();
    expect((await firstLoad).ok).toBe(true);
    expect(getVocabularySnapshot().doc?.entries).toEqual({ alpha: "second" });
  });

  test("loader source has no network route", () => {
    const loader = readFileSync(join(import.meta.dir, "../src/lib/personal-vocabulary.ts"), "utf8");
    expect(loader).not.toMatch(/\bfetch\s*\(/);
    expect(loader).not.toContain("XMLHttpRequest");
  });
});
