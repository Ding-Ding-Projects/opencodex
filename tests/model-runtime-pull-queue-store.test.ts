import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  flushQueueState,
  getQueueState,
  resetPullQueueStoreForTests,
  setPullQueueStorePathForTests,
  setQueueState,
  updateAndFlushQueueState,
} from "../src/lib/model-runtime/pull-queue-store";
import type { PullQueueItem } from "../src/lib/model-runtime/pull-queue-types";

let dir: string;
let nestedDir: string;
let storeFile: string;

function makeItem(overrides: Partial<PullQueueItem> = {}): PullQueueItem {
  return {
    id: "item-1",
    tag: "llama3.1:8b",
    status: "queued",
    requestedAt: 1000,
    startedAt: null,
    finishedAt: null,
    receivedBytes: 0,
    totalBytes: 0,
    totalKnown: false,
    lastStatusMessage: null,
    estimatedSizeBytes: null,
    error: null,
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ocx-pull-queue-test-"));
  nestedDir = join(dir, "nested");
  storeFile = join(nestedDir, "pull-queue.json");
  setPullQueueStorePathForTests(storeFile);
  resetPullQueueStoreForTests();
});

afterEach(() => {
  setPullQueueStorePathForTests(null);
  resetPullQueueStoreForTests();
  rmSync(dir, { recursive: true, force: true });
});

describe("getQueueState", () => {
  test("no file yet → an empty state, never a thrown exception", () => {
    expect(getQueueState()).toEqual({ version: 1, items: [] });
  });

  test("a corrupt file fails closed to empty rather than throwing", () => {
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(storeFile, "not json at all", "utf8");
    resetPullQueueStoreForTests();
    expect(getQueueState()).toEqual({ version: 1, items: [] });
  });

  test("an unknown schema version fails closed to empty", () => {
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(storeFile, JSON.stringify({ version: 2, items: [makeItem()] }), "utf8");
    resetPullQueueStoreForTests();
    expect(getQueueState()).toEqual({ version: 1, items: [] });
  });

  test("a malformed individual item is dropped, valid siblings survive", () => {
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(storeFile, JSON.stringify({
      version: 1,
      items: [
        makeItem({ id: "good-1" }),
        { id: "bad", tag: "x" }, // missing status — invalid
        { tag: "no-id" }, // missing id — invalid
        makeItem({ id: "good-2", tag: "phi3:mini" }),
      ],
    }), "utf8");
    resetPullQueueStoreForTests();
    const state = getQueueState();
    expect(state.items.map(i => i.id)).toEqual(["good-1", "good-2"]);
  });
});

describe("flushQueueState / round-trip", () => {
  test("writes valid, re-parseable JSON that matches the in-memory state exactly", () => {
    setQueueState({ version: 1, items: [makeItem({ id: "a" }), makeItem({ id: "b", status: "pulled", receivedBytes: 500, totalBytes: 500, totalKnown: true })] });
    flushQueueState();
    const onDisk = JSON.parse(readFileSync(storeFile, "utf8"));
    expect(onDisk.items.map((i: PullQueueItem) => i.id)).toEqual(["a", "b"]);
    expect(onDisk.items[1].status).toBe("pulled");
  });

  test("creates the parent directory itself", () => {
    updateAndFlushQueueState(state => { state.items.push(makeItem()); });
    const onDisk = JSON.parse(readFileSync(storeFile, "utf8"));
    expect(onDisk.items).toHaveLength(1);
  });

  test("leaves no .tmp file behind after a successful write", () => {
    updateAndFlushQueueState(state => { state.items.push(makeItem()); });
    const names = readdirSync(nestedDir);
    expect(names).toEqual(["pull-queue.json"]);
  });
});

describe("resetPullQueueStoreForTests — the 'restart' simulation", () => {
  test("state written before a reset is exactly what a fresh read after reset returns", () => {
    updateAndFlushQueueState(state => {
      state.items.push(makeItem({ id: "survivor", tag: "llama3.1:8b", status: "pulling", receivedBytes: 12345, totalBytes: 999999, totalKnown: true }));
    });
    // Simulate a fresh process: drop the in-memory cache, keep the file.
    resetPullQueueStoreForTests();
    const reloaded = getQueueState();
    expect(reloaded.items).toHaveLength(1);
    expect(reloaded.items[0]).toMatchObject({ id: "survivor", tag: "llama3.1:8b", status: "pulling", receivedBytes: 12345, totalBytes: 999999, totalKnown: true });
  });
});
