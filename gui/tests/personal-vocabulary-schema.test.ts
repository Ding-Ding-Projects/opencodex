/**
 * The personal-vocabulary JSON contract: one documented, versioned, bounded
 * schema, validated all the way through before a single byte of it is ever
 * shown to the user or cached.
 *
 * No real vocabulary term or replacement appears anywhere in this file, on
 * purpose — the whole point of the "no shipped mappings" rule is that the only
 * entries that ever exist are the ones a user's own file supplies, and a test
 * fixture is not exempt from that just because it never reaches a build.
 */

import { describe, expect, test } from "bun:test";
import {
  VOCAB_MAX_DEPTH,
  VOCAB_MAX_ENTRIES,
  VOCAB_MAX_FILE_BYTES,
  VOCAB_MAX_KEY_LENGTH,
  VOCAB_MAX_VALUE_LENGTH,
  VOCAB_SCHEMA_VERSION,
  parseVocabularyJSON,
  validateVocabularyFile,
  type VocabRejectReason,
} from "../src/i18n/personal-vocabulary";

/** Builds a syntactically valid envelope around whatever `entries` is given,
 *  so each test only has to state the one thing it is checking. */
const doc = (entries: Record<string, string>, version: unknown = VOCAB_SCHEMA_VERSION) =>
  JSON.stringify({ version, entries });

describe("the bounds are documented constants, not magic numbers", () => {
  test("every bound is a small, sane, positive value", () => {
    expect(VOCAB_SCHEMA_VERSION).toBe(1);
    expect(VOCAB_MAX_FILE_BYTES).toBe(64 * 1024);
    expect(VOCAB_MAX_ENTRIES).toBeGreaterThan(0);
    expect(VOCAB_MAX_KEY_LENGTH).toBeGreaterThan(0);
    expect(VOCAB_MAX_VALUE_LENGTH).toBeGreaterThan(0);
    expect(VOCAB_MAX_DEPTH).toBe(2);
  });
});

describe("a valid file", () => {
  test("a small flat map of alpha-numeric placeholder terms parses cleanly", () => {
    const result = parseVocabularyJSON(doc({ alpha7f: "beta3q", gamma1z: "delta9k" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.doc.version).toBe(1);
    expect(result.doc.entries).toEqual({ alpha7f: "beta3q", gamma1z: "delta9k" });
  });

  test("an empty entries map is valid — a file that says nothing yet", () => {
    const result = parseVocabularyJSON(doc({}));
    expect(result.ok).toBe(true);
  });

  test("a replacement may be the empty string — deleting a term is a legitimate edit", () => {
    const result = parseVocabularyJSON(doc({ zx9q: "" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.doc.entries.zx9q).toBe("");
  });

  test("whitespace and unicode inside values survive intact", () => {
    const result = parseVocabularyJSON(doc({ p7k2: "line one\nline two — 「引用」" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.doc.entries.p7k2).toBe("line one\nline two — 「引用」");
  });
});

describe("malformed JSON is rejected outright", () => {
  const reasonFor = (text: string): VocabRejectReason | null => {
    const result = parseVocabularyJSON(text);
    return result.ok ? null : result.reason;
  };

  test("truncated JSON", () => {
    expect(reasonFor('{"version":1,"entries":{"a7q3"')).toBe("malformed-json");
  });

  test("a trailing comma", () => {
    expect(reasonFor('{"version":1,"entries":{"a7q3":"b2","}')).toBe("malformed-json");
  });

  test("an unquoted key", () => {
    expect(reasonFor('{version:1,"entries":{}}')).toBe("malformed-json");
  });

  test("trailing characters after a valid value", () => {
    expect(reasonFor(`${doc({})} garbage`)).toBe("malformed-json");
  });

  test("an empty file", () => {
    expect(reasonFor("")).toBe("empty-file");
  });

  test("a file that is only whitespace", () => {
    expect(reasonFor("   \n\t  ")).toBe("empty-file");
  });
});

describe("the hard file-size limit", () => {
  test("a payload one byte over the ceiling is refused", () => {
    const pad = "x".repeat(VOCAB_MAX_FILE_BYTES);
    const text = doc({ p7k2: pad });
    expect(new TextEncoder().encode(text).length).toBeGreaterThan(VOCAB_MAX_FILE_BYTES);
    const result = parseVocabularyJSON(text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("too-large");
  });

  test("validateVocabularyFile rejects on File.size alone, never reading an oversized file's bytes", async () => {
    let readCalled = false;
    const bytes = "x".repeat(VOCAB_MAX_FILE_BYTES + 1);
    const file = new File([bytes], "vocabulary.json", { type: "application/json" });
    const originalText = file.text.bind(file);
    // Prove the bytes are never read: if `.text()` were called on an oversized
    // file, this would flip — and it must not.
    Object.defineProperty(file, "text", {
      value: async () => {
        readCalled = true;
        return originalText();
      },
    });
    const result = await validateVocabularyFile(file);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("too-large");
    expect(readCalled).toBe(false);
  });

  test("an empty File is refused before any read", async () => {
    const file = new File([], "vocabulary.json", { type: "application/json" });
    const result = await validateVocabularyFile(file);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("empty-file");
  });

  test("a realistic file using many entries, comfortably under the ceiling, is accepted", async () => {
    // Every field has its own bound (key, value, entry count). A file built
    // from a generous but legal number of near-maximal entries stays well
    // under 64 KiB — proving the ceiling is not so tight that ordinary,
    // schema-legal vocabularies trip it.
    const entries: Record<string, string> = {};
    for (let i = 0; i < 200; i++) {
      entries[`term-${i.toString().padStart(4, "0")}`] = "v".repeat(100);
    }
    const text = doc(entries);
    expect(new TextEncoder().encode(text).length).toBeLessThan(VOCAB_MAX_FILE_BYTES);
    const file = new File([text], "vocabulary.json", { type: "application/json" });
    const result = await validateVocabularyFile(file);
    expect(result.ok).toBe(true);
  });

  /**
   * The exact off-by-one boundary — `> MAX` refuses, `=== MAX` passes — is
   * about the comparison in `validateVocabularyFile`, not about JSON content.
   * Reaching it honestly through real entries would need well over
   * `VOCAB_MAX_ENTRIES` of them (each bounded to `VOCAB_MAX_VALUE_LENGTH`),
   * which the schema itself refuses — so there is no legal document that
   * actually reaches this many bytes. A duck-typed object satisfying exactly
   * the two members `validateVocabularyFile` reads (`size` and `text()`) is
   * the honest way to isolate the size gate from the schema bounds it would
   * otherwise be entangled with.
   */
  const fakeFile = (size: number, text: string): File =>
    ({ size, text: async () => text }) as unknown as File;

  test("file.size one byte over the ceiling is refused without reading text()", async () => {
    let read = false;
    const file = fakeFile(VOCAB_MAX_FILE_BYTES + 1, doc({ p7k2: "v" }));
    Object.defineProperty(file, "text", { value: async () => { read = true; return doc({ p7k2: "v" }); } });
    const result = await validateVocabularyFile(file);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("too-large");
    expect(read).toBe(false);
  });

  test("file.size exactly at the ceiling passes the size gate and is read", async () => {
    const text = doc({ p7k2: "v" });
    const file = fakeFile(VOCAB_MAX_FILE_BYTES, text);
    const result = await validateVocabularyFile(file);
    expect(result.ok).toBe(true);
  });
});

describe("schema version", () => {
  test("an unrecognised version is refused", () => {
    const result = parseVocabularyJSON(doc({}, 2));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unknown-version");
  });

  test("a version encoded as a string, not a number, is refused", () => {
    const result = parseVocabularyJSON(doc({}, "1"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unknown-version");
  });

  test("a missing version field is refused", () => {
    const result = parseVocabularyJSON(JSON.stringify({ entries: {} }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("missing-field");
  });
});

describe("shape and field bounds", () => {
  test("a top-level array instead of an object", () => {
    const result = parseVocabularyJSON("[]");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not-an-object");
  });

  test("a top-level string", () => {
    const result = parseVocabularyJSON('"hello"');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not-an-object");
  });

  test("an unexpected top-level field is refused, not silently ignored", () => {
    const result = parseVocabularyJSON(JSON.stringify({ version: 1, entries: {}, extra: true }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unexpected-field");
    expect(result.detail).toBe("extra");
  });

  test("a missing entries field is refused", () => {
    const result = parseVocabularyJSON(JSON.stringify({ version: 1 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("missing-field");
  });

  test("entries as an array is refused", () => {
    const result = parseVocabularyJSON(JSON.stringify({ version: 1, entries: [] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("entries-not-object");
  });

  test("entries as a string is refused", () => {
    const result = parseVocabularyJSON(JSON.stringify({ version: 1, entries: "nope" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("entries-not-object");
  });
});

describe("nesting depth", () => {
  test("a nested object as an entry's value is refused", () => {
    const result = parseVocabularyJSON(JSON.stringify({ version: 1, entries: { p7k2: { nested: "x" } } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("too-deep");
  });

  test("a nested array as an entry's value is refused", () => {
    const result = parseVocabularyJSON(JSON.stringify({ version: 1, entries: { p7k2: ["x"] } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("too-deep");
  });

  test("the maximum allowed depth — top level plus entries — is accepted", () => {
    // {version, entries:{term: "value"}} is exactly depth 2: the envelope and
    // the entries map. Nothing deeper is ever legitimate under this schema.
    const result = parseVocabularyJSON(doc({ p7k2: "value" }));
    expect(result.ok).toBe(true);
  });
});

describe("duplicate keys", () => {
  test("a repeated term at the top level of entries is refused, not silently overwritten", () => {
    // JSON.parse would keep the second value and give no way to detect the
    // collision; the guarded parser must catch it before that happens.
    const text = '{"version":1,"entries":{"p7k2":"a","p7k2":"b"}}';
    const result = parseVocabularyJSON(text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("duplicate-key");
    expect(result.detail).toBe("p7k2");
  });

  test("a repeated field at the top-level envelope is refused the same way", () => {
    const text = '{"version":1,"version":1,"entries":{}}';
    const result = parseVocabularyJSON(text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("duplicate-key");
  });
});

describe("unsafe object keys", () => {
  for (const unsafe of ["__proto__", "constructor", "prototype"]) {
    test(`"${unsafe}" as a term is refused`, () => {
      const result = parseVocabularyJSON(doc({ [unsafe]: "x" }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("unsafe-key");
      expect(result.detail).toBe(unsafe);
    });

    test(`"${unsafe}" as a top-level field is refused`, () => {
      const text = JSON.stringify({ version: 1, entries: {}, [unsafe]: "x" });
      const result = parseVocabularyJSON(text);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      // Caught by the parser's own unsafe-key check before the top-level field
      // allowlist even gets a chance to report it as "unexpected-field".
      expect(result.reason).toBe("unsafe-key");
    });
  }

  test("parsing an unsafe key never actually creates it as an own property anywhere reachable", () => {
    // A literal `{ __proto__: "x" }` object-literal key sets the prototype
    // rather than creating an own property, so JSON.stringify would drop it
    // silently and the test would prove nothing. The computed-key form forces
    // a genuine own property named "__proto__", which is what a hand-written
    // JSON file actually produces on the wire.
    const text = JSON.stringify({ version: 1, entries: { ["__proto__"]: "x" } });
    expect(text).toContain('"__proto__"');
    const result = parseVocabularyJSON(text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unsafe-key");
    // The refusal itself is the proof: if the parser had let this through and
    // merged it with `Object.assign` or a literal spread, this call would
    // already have polluted `Object.prototype` before the assertion runs.
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});

describe("string-only replacement fields", () => {
  test("a numeric value is refused", () => {
    const result = parseVocabularyJSON(JSON.stringify({ version: 1, entries: { p7k2: 42 } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("non-string-value");
    expect(result.detail).toBe("p7k2");
  });

  test("a boolean value is refused", () => {
    const result = parseVocabularyJSON(JSON.stringify({ version: 1, entries: { p7k2: true } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("non-string-value");
  });

  test("a null value is refused", () => {
    const result = parseVocabularyJSON(JSON.stringify({ version: 1, entries: { p7k2: null } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("non-string-value");
  });
});

describe("bounded lengths and counts", () => {
  test("a key longer than the limit is refused", () => {
    const key = "k".repeat(VOCAB_MAX_KEY_LENGTH + 1);
    const result = parseVocabularyJSON(doc({ [key]: "x" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("key-too-long");
  });

  test("a key exactly at the limit is accepted", () => {
    const key = "k".repeat(VOCAB_MAX_KEY_LENGTH);
    const result = parseVocabularyJSON(doc({ [key]: "x" }));
    expect(result.ok).toBe(true);
  });

  test("an empty-string key is refused", () => {
    const result = parseVocabularyJSON(doc({ "": "x" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("empty-key");
  });

  test("a value longer than the limit is refused", () => {
    const result = parseVocabularyJSON(doc({ p7k2: "v".repeat(VOCAB_MAX_VALUE_LENGTH + 1) }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("value-too-long");
  });

  test("a value exactly at the limit is accepted", () => {
    const result = parseVocabularyJSON(doc({ p7k2: "v".repeat(VOCAB_MAX_VALUE_LENGTH) }));
    expect(result.ok).toBe(true);
  });

  test("more entries than the cap is refused", () => {
    const entries: Record<string, string> = {};
    for (let i = 0; i < VOCAB_MAX_ENTRIES + 1; i++) entries[`term${i}`] = `value${i}`;
    const result = parseVocabularyJSON(doc(entries));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("too-many-entries");
  });

  test("exactly the cap is accepted", () => {
    const entries: Record<string, string> = {};
    for (let i = 0; i < VOCAB_MAX_ENTRIES; i++) entries[`term${i}`] = `value${i}`;
    const result = parseVocabularyJSON(doc(entries));
    expect(result.ok).toBe(true);
  });
});

describe("nothing here parses via a network request", () => {
  test("parseVocabularyJSON never touches fetch", () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    // @ts-expect-error -- deliberately shadowing for the duration of the test
    globalThis.fetch = (...args: unknown[]) => {
      calls++;
      throw new Error(`unexpected network call: ${JSON.stringify(args)}`);
    };
    try {
      parseVocabularyJSON(doc({ p7k2: "v" }));
      parseVocabularyJSON("not json");
      parseVocabularyJSON(doc({}, 99));
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(calls).toBe(0);
  });
});
