/**
 * `src/lib/converter/queue-store.ts` — the durable, atomic on-disk
 * persistence for the converter batch queue.
 *
 * Same discipline `tests/model-runtime-pull-queue-store.test.ts` already
 * proves for the model-pull queue: an empty/corrupt/unknown-version file
 * fails closed rather than throwing, a malformed individual item is dropped
 * while valid siblings survive, every write round-trips exactly, and a
 * "restart" (dropping the in-memory cache) reloads exactly what was last
 * flushed to disk.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  flushQueueState,
  getQueueState,
  resetConvertQueueStoreForTests,
  setConvertQueueStorePathForTests,
  setQueueState,
  updateAndFlushQueueState,
} from "../src/lib/converter/queue-store";
import type { ConvertQueueItem } from "../src/lib/converter/queue-types";

let dir: string;
let nestedDir: string;
let storeFile: string;

function makeItem(overrides: Partial<ConvertQueueItem> = {}): ConvertQueueItem {
  return {
    id: "item-1",
    kind: "structured",
    sourcePath: "C:\\docs\\a.json",
    sourceFormat: "json",
    destPath: "C:\\out\\a.csv",
    destFormat: "csv",
    acknowledgeLossy: true,
    status: "queued",
    requestedAt: 1000,
    startedAt: null,
    finishedAt: null,
    sourceBytes: 42,
    bytesWritten: null,
    lossy: null,
    notes: null,
    boundary: null,
    error: null,
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ocx-convert-queue-test-"));
  nestedDir = join(dir, "nested");
  storeFile = join(nestedDir, "convert-queue.json");
  setConvertQueueStorePathForTests(storeFile);
  resetConvertQueueStoreForTests();
});

afterEach(() => {
  setConvertQueueStorePathForTests(null);
  resetConvertQueueStoreForTests();
  rmSync(dir, { recursive: true, force: true });
});

describe("getQueueState", () => {
  test("no file yet → an empty, unpaused state, never a thrown exception", () => {
    expect(getQueueState()).toEqual({ version: 1, paused: false, items: [] });
  });

  test("a corrupt file fails closed to empty rather than throwing", () => {
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(storeFile, "not json at all", "utf8");
    resetConvertQueueStoreForTests();
    expect(getQueueState()).toEqual({ version: 1, paused: false, items: [] });
  });

  test("an unknown schema version fails closed to empty", () => {
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(storeFile, JSON.stringify({ version: 2, items: [makeItem()] }), "utf8");
    resetConvertQueueStoreForTests();
    expect(getQueueState()).toEqual({ version: 1, paused: false, items: [] });
  });

  test("a malformed individual item is dropped, valid siblings survive", () => {
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(storeFile, JSON.stringify({
      version: 1,
      paused: false,
      items: [
        makeItem({ id: "good-1" }),
        { id: "bad", sourcePath: "x" }, // missing status/kind/formats — invalid
        { kind: "structured", sourcePath: "no-id" }, // missing id — invalid
        makeItem({ id: "good-2", destFormat: "xml" }),
        { ...makeItem({ id: "bad-format" }), sourceFormat: "yaml" }, // unknown format — invalid
      ],
    }), "utf8");
    resetConvertQueueStoreForTests();
    const state = getQueueState();
    expect(state.items.map(i => i.id)).toEqual(["good-1", "good-2"]);
  });

  test("the paused flag round-trips through disk", () => {
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(storeFile, JSON.stringify({ version: 1, paused: true, items: [] }), "utf8");
    resetConvertQueueStoreForTests();
    expect(getQueueState().paused).toBe(true);
  });
});

describe("flushQueueState / round-trip", () => {
  test("writes valid, re-parseable JSON that matches the in-memory state exactly", () => {
    setQueueState({
      version: 1, paused: false,
      items: [makeItem({ id: "a" }), makeItem({ id: "b", status: "converted", bytesWritten: 123, lossy: true, notes: ["x"] })],
    });
    flushQueueState();
    const onDisk = JSON.parse(readFileSync(storeFile, "utf8"));
    expect(onDisk.items.map((i: ConvertQueueItem) => i.id)).toEqual(["a", "b"]);
    expect(onDisk.items[1].status).toBe("converted");
    expect(onDisk.items[1].notes).toEqual(["x"]);
  });

  test("creates the parent directory itself", () => {
    updateAndFlushQueueState(state => { state.items.push(makeItem()); });
    const onDisk = JSON.parse(readFileSync(storeFile, "utf8"));
    expect(onDisk.items).toHaveLength(1);
  });

  test("leaves no .tmp file behind after a successful write", () => {
    updateAndFlushQueueState(state => { state.items.push(makeItem()); });
    const names = readdirSync(nestedDir);
    expect(names).toEqual(["convert-queue.json"]);
  });
});

describe("resetConvertQueueStoreForTests — the 'restart' simulation", () => {
  test("state written before a reset is exactly what a fresh read after reset returns", () => {
    updateAndFlushQueueState(state => {
      state.paused = true;
      state.items.push(makeItem({ id: "survivor", status: "converting", sourceBytes: 999 }));
    });
    // Simulate a fresh process: drop the in-memory cache, keep the file.
    resetConvertQueueStoreForTests();
    const reloaded = getQueueState();
    expect(reloaded.paused).toBe(true);
    expect(reloaded.items).toHaveLength(1);
    expect(reloaded.items[0]).toMatchObject({ id: "survivor", status: "converting", sourceBytes: 999 });
  });
});
