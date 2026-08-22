/**
 * The personal-vocabulary store: local persistence, cache revalidation, and
 * the "a rejected file never applies partially" / "clear restores original
 * wording immediately" halves of the contract.
 *
 * No real vocabulary term appears in this file — see the header comment on
 * `tests/personal-vocabulary-schema.test.ts` for why that is a hard rule and
 * not merely tidiness here.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  clearVocabulary,
  getActiveVocabularyEntries,
  getVocabularySnapshot,
  loadVocabularyFile,
  resetVocabularyForTests,
  subscribeVocabulary,
  VOCAB_SCHEMA_VERSION,
  type VocabStorageLike,
} from "../src/i18n/personal-vocabulary";

/** A minimal in-memory `Storage`-shaped object — everything
 *  `VocabStorageLike` needs and nothing a real `Storage` also carries, so a
 *  test cannot accidentally depend on `.length` or `.key()` behaviour this
 *  module never uses. */
function makeMemoryStorage(): VocabStorageLike & { raw: Map<string, string> } {
  const raw = new Map<string, string>();
  return {
    raw,
    getItem: (key: string) => (raw.has(key) ? raw.get(key)! : null),
    setItem: (key: string, value: string) => { raw.set(key, value); },
    removeItem: (key: string) => { raw.delete(key); },
  };
}

/** Installs a fresh fake `localStorage` as the real global, for the functions
 *  in this module that read the default storage rather than an injected one
 *  — `getActiveVocabularyEntries`, `getVocabularySnapshot`, hydration itself. */
function installGlobalStorage(): VocabStorageLike & { raw: Map<string, string> } {
  const storage = makeMemoryStorage();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  return storage;
}

function uninstallGlobalStorage(): void {
  Reflect.deleteProperty(globalThis, "localStorage");
}

afterEach(() => {
  resetVocabularyForTests();
  uninstallGlobalStorage();
});

const doc = (entries: Record<string, string>) => JSON.stringify({ version: VOCAB_SCHEMA_VERSION, entries });
const file = (entries: Record<string, string>) => new File([doc(entries)], "vocabulary.json", { type: "application/json" });

function deferredFile(entries: Record<string, string>): {
  file: File;
  resolve: () => void;
} {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const candidate = file(entries);
  Object.defineProperty(candidate, "text", {
    configurable: true,
    value: async () => {
      await gate;
      return doc(entries);
    },
  });
  return { file: candidate, resolve: release };
}

describe("with no file ever loaded", () => {
  beforeEach(() => resetVocabularyForTests());

  test("the active vocabulary is null — original shipped wording renders everywhere", () => {
    expect(getActiveVocabularyEntries()).toBeNull();
  });

  test("the snapshot reports the empty state honestly", () => {
    const snapshot = getVocabularySnapshot();
    expect(snapshot.doc).toBeNull();
    expect(snapshot.loadedAt).toBeNull();
    expect(snapshot.lastRejection).toBeNull();
  });

  test("works with no localStorage global at all — SSR/test environments are a valid state, not a crash", () => {
    uninstallGlobalStorage();
    expect(() => getActiveVocabularyEntries()).not.toThrow();
    expect(getActiveVocabularyEntries()).toBeNull();
  });
});

describe("loading a valid file", () => {
  beforeEach(() => resetVocabularyForTests());

  test("activates immediately and is visible to getActiveVocabularyEntries", async () => {
    const storage = installGlobalStorage();
    const result = await loadVocabularyFile(file({ p7k2: "q3zx" }), storage);
    expect(result.ok).toBe(true);
    expect(getActiveVocabularyEntries()).toEqual({ p7k2: "q3zx" });
  });

  test("is persisted to the injected storage under its own namespaced key", async () => {
    const storage = installGlobalStorage();
    await loadVocabularyFile(file({ p7k2: "q3zx" }), storage);
    // Exactly one key, namespaced so it cannot collide with any other setting
    // this app persists — never the source file's name or path.
    expect([...storage.raw.keys()]).toEqual(["ocx-vocab:v1"]);
    const stored = JSON.parse(storage.raw.get("ocx-vocab:v1")!);
    expect(stored).toEqual({ version: VOCAB_SCHEMA_VERSION, entries: { p7k2: "q3zx" } });
  });

  test("never stores the source file's name anywhere", async () => {
    const storage = installGlobalStorage();
    await loadVocabularyFile(new File([doc({ p7k2: "x" })], "my-private-glossary.json"), storage);
    const stored = storage.raw.get("ocx-vocab:v1")!;
    expect(stored).not.toContain("my-private-glossary");
    expect(stored).not.toContain(".json");
  });

  test("records loadedAt and clears any previous rejection", async () => {
    const storage = installGlobalStorage();
    await loadVocabularyFile(new File(["not json"], "bad.json"), storage);
    expect(getVocabularySnapshot().lastRejection?.reason).toBe("malformed-json");

    const before = Date.now();
    await loadVocabularyFile(file({ p7k2: "x" }), storage);
    const snapshot = getVocabularySnapshot();
    expect(snapshot.lastRejection).toBeNull();
    expect(snapshot.loadedAt).toBeGreaterThanOrEqual(before);
  });

  test("notifies every subscriber synchronously", async () => {
    const storage = installGlobalStorage();
    let notifications = 0;
    const unsubscribe = subscribeVocabulary(() => { notifications++; });
    await loadVocabularyFile(file({ p7k2: "x" }), storage);
    expect(notifications).toBe(1);
    unsubscribe();
    await loadVocabularyFile(file({ p7k2: "y" }), storage);
    // Unsubscribed — must not still be called.
    expect(notifications).toBe(1);
  });
});

describe("a rejected file never applies partially", () => {
  beforeEach(() => resetVocabularyForTests());

  test("a previously active vocabulary is completely untouched by a later rejected file", async () => {
    const storage = installGlobalStorage();
    await loadVocabularyFile(file({ p7k2: "q3zx" }), storage);
    expect(getActiveVocabularyEntries()).toEqual({ p7k2: "q3zx" });

    const rejected = await loadVocabularyFile(new File(["{ not valid"], "broken.json"), storage);
    expect(rejected.ok).toBe(false);

    // Still exactly what was active before — not merged, not cleared, not
    // partially overwritten.
    expect(getActiveVocabularyEntries()).toEqual({ p7k2: "q3zx" });
    expect(getVocabularySnapshot().lastRejection?.reason).toBe("malformed-json");
  });

  test("with nothing loaded yet, a rejected file leaves the state at null — not a half-applied document", async () => {
    const storage = installGlobalStorage();
    const rejected = await loadVocabularyFile(new File(["not json"], "broken.json"), storage);
    expect(rejected.ok).toBe(false);
    expect(getActiveVocabularyEntries()).toBeNull();
    expect(storage.raw.size).toBe(0);
  });

  test("a rejected file is never written to storage", async () => {
    const storage = installGlobalStorage();
    await loadVocabularyFile(new File(["not json"], "broken.json"), storage);
    expect(storage.raw.has("ocx-vocab:v1")).toBe(false);
  });
});

describe("clearing", () => {
  beforeEach(() => resetVocabularyForTests());

  test("restores the empty state immediately and purges the persisted cache", async () => {
    const storage = installGlobalStorage();
    await loadVocabularyFile(file({ p7k2: "x" }), storage);
    expect(getActiveVocabularyEntries()).not.toBeNull();

    clearVocabulary(storage);

    expect(getActiveVocabularyEntries()).toBeNull();
    expect(getVocabularySnapshot()).toEqual({ doc: null, loadedAt: null, lastRejection: null });
    expect(storage.raw.has("ocx-vocab:v1")).toBe(false);
  });

  test("notifies subscribers", async () => {
    const storage = installGlobalStorage();
    await loadVocabularyFile(file({ p7k2: "x" }), storage);
    let notified = false;
    subscribeVocabulary(() => { notified = true; });
    clearVocabulary(storage);
    expect(notified).toBe(true);
  });

  test("clearing with nothing loaded is a harmless no-op", () => {
    const storage = installGlobalStorage();
    expect(() => clearVocabulary(storage)).not.toThrow();
    expect(getActiveVocabularyEntries()).toBeNull();
  });

  test("a storage refusal keeps the last active vocabulary and reports failure", async () => {
    const storage = installGlobalStorage();
    await loadVocabularyFile(file({ p7k2: "q3zx" }), storage);
    storage.setItem = () => { throw new Error("storage refused"); };

    const result = await loadVocabularyFile(file({ r4m8: "s5n1" }), storage);

    expect(result).toEqual({ ok: false, reason: "persistence-failed" });
    expect(getActiveVocabularyEntries()).toEqual({ p7k2: "q3zx" });
    expect(getVocabularySnapshot().lastRejection).toEqual({ reason: "persistence-failed" });
  });

  test("a remove refusal keeps memory aligned with the durable cache", async () => {
    const storage = installGlobalStorage();
    await loadVocabularyFile(file({ p7k2: "q3zx" }), storage);
    storage.removeItem = () => { throw new Error("storage refused"); };

    const result = clearVocabulary(storage);

    expect(result).toEqual({ ok: false, reason: "clear-failed" });
    expect(getActiveVocabularyEntries()).toEqual({ p7k2: "q3zx" });
    expect(storage.raw.has("ocx-vocab:v1")).toBe(true);
  });

  test("an older upload completion cannot overwrite a newer upload", async () => {
    const storage = installGlobalStorage();
    const older = deferredFile({ p7k2: "q3zx" });
    const olderResult = loadVocabularyFile(older.file, storage);
    const newerResult = await loadVocabularyFile(file({ r4m8: "s5n1" }), storage);
    older.resolve();

    expect((await olderResult)).toEqual({ ok: false, reason: "superseded" });
    expect(newerResult.ok).toBe(true);
    expect(getActiveVocabularyEntries()).toEqual({ r4m8: "s5n1" });
    expect(JSON.parse(storage.raw.get("ocx-vocab:v1")!)).toEqual({
      version: VOCAB_SCHEMA_VERSION,
      entries: { r4m8: "s5n1" },
    });
  });

  test("a pending upload cannot resurrect vocabulary after clear", async () => {
    const storage = installGlobalStorage();
    await loadVocabularyFile(file({ p7k2: "q3zx" }), storage);
    const pending = deferredFile({ r4m8: "s5n1" });
    const pendingResult = loadVocabularyFile(pending.file, storage);
    const clearResult = clearVocabulary(storage);
    pending.resolve();

    expect(clearResult).toEqual({ ok: true });
    expect(await pendingResult).toEqual({ ok: false, reason: "superseded" });
    expect(getActiveVocabularyEntries()).toBeNull();
    expect(storage.raw.has("ocx-vocab:v1")).toBe(false);
  });
});

describe("cache revalidation — fail closed to original shipped wording", () => {
  beforeEach(() => resetVocabularyForTests());

  test("a freshly hydrated app trusts a valid persisted cache", () => {
    const storage = installGlobalStorage();
    storage.raw.set("ocx-vocab:v1", doc({ p7k2: "q3zx" }));
    // Hydration happens lazily, on first read — nothing has read it yet.
    expect(getActiveVocabularyEntries()).toEqual({ p7k2: "q3zx" });
  });

  test("a corrupted cache (bad JSON) fails closed to null rather than throwing or partially applying", () => {
    const storage = installGlobalStorage();
    storage.raw.set("ocx-vocab:v1", "{ this is not valid json");
    expect(() => getActiveVocabularyEntries()).not.toThrow();
    expect(getActiveVocabularyEntries()).toBeNull();
  });

  test("a cache written by an unsupported future schema version fails closed to null", () => {
    const storage = installGlobalStorage();
    storage.raw.set("ocx-vocab:v1", JSON.stringify({ version: 999, entries: { p7k2: "x" } }));
    expect(getActiveVocabularyEntries()).toBeNull();
  });

  test("a cache that no longer satisfies the current bounds fails closed to null", () => {
    const storage = installGlobalStorage();
    // A shape that was never legal under this schema at all — same as any
    // other structurally invalid cache, it must not be trusted.
    storage.raw.set("ocx-vocab:v1", JSON.stringify({ version: VOCAB_SCHEMA_VERSION, entries: ["not", "an", "object"] }));
    expect(getActiveVocabularyEntries()).toBeNull();
  });

  test("re-validation happens through the exact same parser a fresh upload uses — not a looser trust-on-read path", () => {
    // If the cache reader used a different (looser) check than the uploader,
    // a file that a fresh upload would refuse could still be resurrected from
    // a stale cache. Proven here by writing something the uploader would
    // reject (a duplicate key at the raw-text level) directly into storage.
    const storage = installGlobalStorage();
    storage.raw.set("ocx-vocab:v1", '{"version":1,"entries":{"p7k2":"a","p7k2":"b"}}');
    expect(getActiveVocabularyEntries()).toBeNull();
  });
});

describe("nothing here ever makes a network request", () => {
  beforeEach(() => resetVocabularyForTests());

  test("load, clear, and hydrate all complete with fetch stubbed to throw", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    // @ts-expect-error -- deliberately shadowing for the duration of the test
    globalThis.fetch = (...args: unknown[]) => {
      calls++;
      throw new Error(`unexpected network call: ${JSON.stringify(args)}`);
    };
    try {
      const storage = installGlobalStorage();
      storage.raw.set("ocx-vocab:v1", doc({ p7k2: "x" }));
      getActiveVocabularyEntries();
      await loadVocabularyFile(file({ p7k2: "y" }), storage);
      clearVocabulary(storage);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(calls).toBe(0);
  });
});
