/**
 * hunt-int-01: persistence stores that hand-roll "temp file + rename" skip the
 * Windows transient-retry helper that already exists for exactly this purpose.
 *
 * `src/lib/converter/queue-store.ts`, `src/lib/model-runtime/pull-queue-store.ts`
 * and `src/lib/model-runtime/chat-store.ts` each implement their own atomic write
 * as `writeFileSync(tmp, ...)` followed by a bare `renameSync(tmp, path)`, instead
 * of routing through `renameAtomicFile` in `src/config.ts`. `queue-store.ts`'s own
 * top-of-file comment excuses this: the file "carries no secrets, so it needs none
 * of `renameAtomicFile` in `src/config.ts`'s Windows ACL hardening, just the plain
 * atomicity." But `renameAtomicFile` does two independent things, and that comment
 * only excuses skipping one of them. The other is a bounded retry, already proven
 * in `tests/config.test.ts` ("atomic rename retries transient Windows sharing
 * violations"), for exactly `EBUSY`/`EPERM`/`EACCES` on `rename()`, which Windows
 * raises routinely whenever anything else (an AV scanner, the indexer, a backup
 * tool, or another route in this same app) has the destination momentarily open.
 * None of the three bespoke writers below retry at all, so a lock that clears in
 * milliseconds is fatal to the flush today, even though the in-memory mutation
 * already happened (`updateAndFlush*State`'s mutator runs before the flush is
 * attempted) and is simply lost: the failed write's own temp file is deleted in
 * the `catch`, so nothing recoverable is left on disk either.
 *
 * Proven here with a REAL Windows sharing-violation lock (an open `r+` handle on
 * the destination, confirmed empirically on this host to make a concurrent
 * `renameSync(tmp, path)` throw `EPERM`), released from a separate OS thread partway
 * through the call so the lock is genuinely transient and genuinely concurrent,
 * not a same-thread mock, and not merely a permanently-held lock a retry could
 * never have ridden out anyway. A worker thread can close a `node:fs` file
 * descriptor opened on the main thread because both share one OS process; this
 * was confirmed to work under this exact Bun/Windows combination before being
 * relied on here.
 *
 * Expected red now: all three tests below fail, because `thrown` is an EPERM
 * error instead of `undefined`; the lock clears in 40ms but the store gives up
 * on the very first attempt, well before that. Expected green after a correct
 * fix (route each store's rename through `renameAtomicFile`, keeping the unique
 * per-process/per-sequence temp name each already uses): the fixed rename would
 * retry at +0ms/+25ms/+75ms, the third attempt would land after the 40ms release,
 * and both assertions in each test would pass.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import {
  resetConvertQueueStoreForTests,
  setConvertQueueStorePathForTests,
  updateAndFlushQueueState as updateAndFlushConvertQueueState,
} from "../src/lib/converter/queue-store";
import {
  flushQueueState as flushPullQueueState,
  resetPullQueueStoreForTests,
  setPullQueueStorePathForTests,
  updateAndFlushQueueState as updateAndFlushPullQueueState,
} from "../src/lib/model-runtime/pull-queue-store";
import type { PullQueueItem } from "../src/lib/model-runtime/pull-queue-types";
import {
  flushChatState,
  resetChatStoreForTests,
  setChatStorePathForTests,
  updateAndFlushChatState,
} from "../src/lib/model-runtime/chat-store";
import { DEFAULT_CHAT_PARAMETERS, type ChatSession } from "../src/lib/model-runtime/chat-types";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hunt-int-01-"));
});

afterEach(() => {
  setConvertQueueStorePathForTests(null);
  resetConvertQueueStoreForTests();
  setPullQueueStorePathForTests(null);
  resetPullQueueStoreForTests();
  setChatStorePathForTests(null);
  resetChatStoreForTests();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Opens a real Windows sharing-violation lock on `path` and releases it from a
 * separate OS thread after `delayMs`. Returns a `release()` that always leaves
 * the handle closed (even if the caller never waited for the timer), so a test
 * that fails fast never leaks a handle into the next test's directory cleanup.
 */
function holdTransientLock(path: string, delayMs: number): { release: () => Promise<void> } {
  const fd = openSync(path, "r+");
  const worker = new Worker(
    `const { closeSync } = require("node:fs");
     const { workerData } = require("node:worker_threads");
     setTimeout(() => { try { closeSync(workerData.fd); } catch {} }, workerData.delayMs);`,
    { eval: true, workerData: { fd, delayMs } },
  );
  return {
    release: async () => {
      await worker.terminate();
      try { closeSync(fd); } catch { /* already closed by the worker's timer, or never needed */ }
    },
  };
}

describe("temp-then-rename queue/chat stores vs. a transient Windows rename lock", () => {
  test("converter queue-store: a lock that clears in 40ms should not lose the flush", async () => {
    const storeFile = join(dir, "convert-queue.json");
    setConvertQueueStorePathForTests(storeFile);
    resetConvertQueueStoreForTests();
    updateAndFlushConvertQueueState(state => { state.paused = true; }); // creates the destination file

    const lock = holdTransientLock(storeFile, 40);
    let thrown: NodeJS.ErrnoException | undefined;
    try {
      updateAndFlushConvertQueueState(state => { state.paused = false; });
    } catch (error) {
      thrown = error as NodeJS.ErrnoException;
    } finally {
      await lock.release();
    }

    expect(thrown).toBeUndefined();
    expect(JSON.parse(readFileSync(storeFile, "utf8")).paused).toBe(false);
  });

  test("model-runtime pull-queue-store: the identical bespoke rename has the identical gap", async () => {
    const storeFile = join(dir, "pull-queue.json");
    setPullQueueStorePathForTests(storeFile);
    resetPullQueueStoreForTests();
    flushPullQueueState(); // creates the destination file with the default empty state

    const item: PullQueueItem = {
      id: "x", tag: "llama3.1:8b", status: "queued", requestedAt: 1,
      startedAt: null, finishedAt: null, receivedBytes: 0, totalBytes: 0,
      totalKnown: false, lastStatusMessage: null, estimatedSizeBytes: null, error: null,
    };
    const lock = holdTransientLock(storeFile, 40);
    let thrown: NodeJS.ErrnoException | undefined;
    try {
      updateAndFlushPullQueueState(state => { state.items.push(item); });
    } catch (error) {
      thrown = error as NodeJS.ErrnoException;
    } finally {
      await lock.release();
    }

    expect(thrown).toBeUndefined();
    expect(JSON.parse(readFileSync(storeFile, "utf8")).items).toHaveLength(1);
  });

  test("model-runtime chat-store: the identical bespoke rename has the identical gap", async () => {
    const storeFile = join(dir, "chat-sessions.json");
    setChatStorePathForTests(storeFile);
    resetChatStoreForTests();
    flushChatState(); // creates the destination file with the default empty state

    const session: ChatSession = {
      id: "s1", title: "t", model: "llama3.2:3b", systemPrompt: "",
      parameters: DEFAULT_CHAT_PARAMETERS, messages: [], createdAt: 1, updatedAt: 1,
      streamingMessageId: null,
    };
    const lock = holdTransientLock(storeFile, 40);
    let thrown: NodeJS.ErrnoException | undefined;
    try {
      updateAndFlushChatState(state => { state.sessions.push(session); });
    } catch (error) {
      thrown = error as NodeJS.ErrnoException;
    } finally {
      await lock.release();
    }

    expect(thrown).toBeUndefined();
    expect(JSON.parse(readFileSync(storeFile, "utf8")).sessions).toHaveLength(1);
  });
});
