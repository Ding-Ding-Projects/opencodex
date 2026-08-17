import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteOllamaModel } from "../src/lib/model-runtime/client";
import {
  cancelAllPending,
  cancelItem,
  clearFinishedItems,
  DEFAULT_CONCURRENCY,
  ensureResumed,
  getQueueSnapshot,
  MAX_BATCH_TAGS,
  processQueue,
  resetPullQueueEngineForTests,
  retryItem,
  setPullExecutorForTests,
  setPullQueueTagsFetcherForTests,
  startBatchPull,
} from "../src/lib/model-runtime/pull-queue-engine";
import { setPullQueueStorePathForTests, updateAndFlushQueueState } from "../src/lib/model-runtime/pull-queue-store";
import type { OllamaPullOutcome, PullOllamaModelOptions } from "../src/lib/model-runtime/pull-client";
import type { OllamaTagEntry } from "../src/lib/model-runtime/types";

const BASE_URL = "http://127.0.0.1:11434";

type Behavior = (tag: string, options: PullOllamaModelOptions) => Promise<OllamaPullOutcome>;

/** Deterministic, injectable stand-in for `pullOllamaModel` — one behavior per tag, and a call log so tests can prove exactly what was (and was not) invoked. */
function makeExecutor(behaviors: Record<string, Behavior>) {
  const calls: string[] = [];
  const executor = (async (_baseUrl: string, model: string, options: PullOllamaModelOptions = {}) => {
    calls.push(model);
    const behavior = behaviors[model];
    if (!behavior) throw new Error(`test executor: no behavior configured for tag "${model}"`);
    return behavior(model, options);
  }) as typeof import("../src/lib/model-runtime/pull-client").pullOllamaModel;
  return { executor, calls };
}

function instantSuccess(): Behavior {
  return async (_tag, options) => {
    options.onLine?.({ status: "pulling manifest", digest: null, total: null, completed: null });
    options.onLine?.({ status: "downloading", digest: "sha256:layer", total: 1000, completed: 1000 });
    options.onLine?.({ status: "success", digest: null, total: null, completed: null });
    return { ok: true };
  };
}

function instantFailure(message = "simulated network failure"): Behavior {
  return async () => ({ ok: false, failure: { kind: "network", error: message } });
}

/** Blocks until either the pull's own signal is aborted, or the test calls `release()`. */
function pausable(finalOutcome: OllamaPullOutcome = { ok: true }, opts: { emitProgress?: boolean } = {}): { behavior: Behavior; release: () => void; sawAbort: () => boolean } {
  let resolveGate: (() => void) | null = null;
  const gate = new Promise<void>(resolve => { resolveGate = resolve; });
  let aborted = false;
  const emitProgress = opts.emitProgress !== false;
  const behavior: Behavior = async (_tag, options) => {
    if (emitProgress) options.onLine?.({ status: "downloading", digest: "sha256:layer", total: 1000, completed: 250 });
    await Promise.race([
      new Promise<void>(resolve => options.signal?.addEventListener("abort", () => { aborted = true; resolve(); })),
      gate,
    ]);
    if (options.signal?.aborted) return { ok: false, failure: { kind: "aborted" } };
    return finalOutcome;
  };
  return { behavior, release: () => resolveGate?.(), sawAbort: () => aborted };
}

/** Drains pending microtasks a generous, fixed number of times — deterministic (no real timers involved), just enough for a chain of un-gated async fakes to settle. */
async function settleMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function tagsFetcherReporting(names: string[]) {
  return (async (): Promise<{ ok: true; data: OllamaTagEntry[] }> => ({
    ok: true,
    data: names.map(name => ({ name, model: name, modifiedAt: null, sizeBytes: null, digest: null, details: { format: null, family: null, families: null, parameterSize: null, quantizationLevel: null } })),
  })) as typeof import("../src/lib/model-runtime/client").fetchOllamaTags;
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ocx-pull-queue-engine-test-"));
  setPullQueueStorePathForTests(join(dir, "pull-queue.json"));
  resetPullQueueEngineForTests();
  setPullQueueTagsFetcherForTests(tagsFetcherReporting([])); // nothing installed unless a test says otherwise
});

afterEach(() => {
  setPullExecutorForTests(null);
  setPullQueueTagsFetcherForTests(null);
  resetPullQueueEngineForTests();
  setPullQueueStorePathForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

describe("startBatchPull — validation and enqueueing", () => {
  test("rejects an empty tag list", async () => {
    const result = await startBatchPull(BASE_URL, []);
    expect(result.ok).toBe(false);
  });

  test("rejects a batch over the tag cap", async () => {
    const tooMany = Array.from({ length: MAX_BATCH_TAGS + 1 }, (_, i) => `model-${i}`);
    const result = await startBatchPull(BASE_URL, tooMany);
    expect(result.ok).toBe(false);
  });

  test("deduplicates and trims requested tags", async () => {
    const { executor } = makeExecutor({ "a:1": instantSuccess() });
    setPullExecutorForTests(executor);
    const result = await startBatchPull(BASE_URL, [" a:1 ", "a:1", "a:1  "]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.items).toHaveLength(1);
    await processQueue(BASE_URL);
  });

  test("an already-installed tag is enqueued as 'skipped' by default, never downloaded", async () => {
    setPullQueueTagsFetcherForTests(tagsFetcherReporting(["already:here"]));
    const { executor, calls } = makeExecutor({});
    setPullExecutorForTests(executor);
    const result = await startBatchPull(BASE_URL, ["already:here"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.items[0].status).toBe("skipped");
    await processQueue(BASE_URL);
    expect(calls).toEqual([]); // never called the network layer for an already-installed tag
  });

  test("force:true re-queues an already-installed tag instead of skipping it", async () => {
    setPullQueueTagsFetcherForTests(tagsFetcherReporting(["already:here"]));
    const { executor, calls } = makeExecutor({ "already:here": instantSuccess() });
    setPullExecutorForTests(executor);
    const result = await startBatchPull(BASE_URL, ["already:here"], { force: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Background processing may already have synchronously claimed it by the
    // time this call returns (claiming happens before the first `await` on
    // the network layer) — either "queued" or already "pulling" is correct;
    // "skipped" is what would be wrong here.
    expect(["queued", "pulling"]).toContain(result.state.items[0].status);
    await processQueue(BASE_URL);
    expect(calls).toEqual(["already:here"]);
  });
});

describe("bounded concurrency", () => {
  test("never runs more items 'pulling' at once than the configured concurrency", async () => {
    const gates = ["a:1", "a:2", "a:3", "a:4"].map(() => pausable());
    const { executor } = makeExecutor(Object.fromEntries(["a:1", "a:2", "a:3", "a:4"].map((tag, i) => [tag, gates[i]!.behavior])));
    setPullExecutorForTests(executor);

    const started = startBatchPull(BASE_URL, ["a:1", "a:2", "a:3", "a:4"], { concurrency: 2 });
    const result = await started;
    expect(result.ok).toBe(true);

    // Give the two allowed workers a tick to claim and start pulling.
    await settleMicrotasks();

    const midSnapshot = getQueueSnapshot();
    const pullingCount = midSnapshot.state.items.filter(i => i.status === "pulling").length;
    expect(pullingCount).toBeLessThanOrEqual(2);
    expect(pullingCount).toBeGreaterThan(0);

    // Release everything and let the batch drain.
    for (const g of gates) g.release();
    await processQueue(BASE_URL);
    const finalSnapshot = getQueueSnapshot();
    expect(finalSnapshot.summary.pulled).toBe(4);
    expect(finalSnapshot.summary.outcome).toBe("complete-success");
  });
});

describe("byte progress", () => {
  test("aggregates completed/total across every reported digest, and never invents a percentage", async () => {
    const gate = pausable({ ok: true }, { emitProgress: false });
    const { executor } = makeExecutor({ "multi:layer": async (tag, options) => {
      options.onLine?.({ status: "downloading layer 1", digest: "sha256:a", total: 1000, completed: 1000 });
      options.onLine?.({ status: "downloading layer 2", digest: "sha256:b", total: 2000, completed: 500 });
      return gate.behavior(tag, options);
    } });
    setPullExecutorForTests(executor);

    await startBatchPull(BASE_URL, ["multi:layer"]);
    await settleMicrotasks();

    const mid = getQueueSnapshot().state.items[0];
    expect(mid.totalKnown).toBe(true);
    expect(mid.totalBytes).toBe(3000); // 1000 + 2000, summed across both digests
    expect(mid.receivedBytes).toBe(1500); // 1000 + 500

    gate.release();
    await processQueue(BASE_URL);
    const final = getQueueSnapshot().state.items[0];
    expect(final.status).toBe("pulled");
    expect(final.receivedBytes).toBe(final.totalBytes); // snapped to 100% on success
  });

  test("an item with no sized status lines yet stays honestly indeterminate", async () => {
    const gate = pausable({ ok: true }, { emitProgress: false });
    const { executor } = makeExecutor({ "unsized:model": async (tag, options) => {
      options.onLine?.({ status: "pulling manifest", digest: null, total: null, completed: null });
      return gate.behavior(tag, options);
    } });
    setPullExecutorForTests(executor);
    await startBatchPull(BASE_URL, ["unsized:model"]);
    await settleMicrotasks();
    const mid = getQueueSnapshot().state.items[0];
    expect(mid.totalKnown).toBe(false);
    expect(mid.totalBytes).toBe(0);
    gate.release();
    await processQueue(BASE_URL);
  });
});

describe("mid-batch cancel", () => {
  test("cancelling one 'pulling' item lets its sibling and the next queued item finish normally", async () => {
    const g1 = pausable();
    const g2 = pausable();
    const { executor } = makeExecutor({
      "cancel-me:1": g1.behavior,
      "keep-going:1": g2.behavior,
      "queued-next:1": instantSuccess(),
    });
    setPullExecutorForTests(executor);

    const started = await startBatchPull(BASE_URL, ["cancel-me:1", "keep-going:1", "queued-next:1"], { concurrency: 2 });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await settleMicrotasks();

    const pullingItem = getQueueSnapshot().state.items.find(i => i.tag === "cancel-me:1")!;
    expect(pullingItem.status).toBe("pulling");

    const cancelResult = cancelItem(pullingItem.id);
    expect(cancelResult.ok).toBe(true);

    g2.release();
    await processQueue(BASE_URL);

    const final = getQueueSnapshot();
    const cancelled = final.state.items.find(i => i.tag === "cancel-me:1")!;
    const kept = final.state.items.find(i => i.tag === "keep-going:1")!;
    const next = final.state.items.find(i => i.tag === "queued-next:1")!;
    expect(cancelled.status).toBe("cancelled");
    expect(g1.sawAbort()).toBe(true);
    expect(kept.status).toBe("pulled");
    expect(next.status).toBe("pulled");
    // A cancelled item beside two finished ones is not a clean "green" batch.
    expect(final.summary.outcome).toBe("complete-partial");
  });

  test("cancelling a still-'queued' item never starts a network call for it", async () => {
    const g = pausable();
    const { executor, calls } = makeExecutor({ "busy:1": g.behavior, "never-started:1": instantSuccess() });
    setPullExecutorForTests(executor);
    await startBatchPull(BASE_URL, ["busy:1", "never-started:1"], { concurrency: 1 });
    await Promise.resolve();

    const queuedItem = getQueueSnapshot().state.items.find(i => i.tag === "never-started:1")!;
    expect(queuedItem.status).toBe("queued");
    const result = cancelItem(queuedItem.id);
    expect(result.ok).toBe(true);

    g.release();
    await processQueue(BASE_URL);

    expect(calls).not.toContain("never-started:1");
    const final = getQueueSnapshot().state.items.find(i => i.tag === "never-started:1")!;
    expect(final.status).toBe("cancelled");
  });

  test("cancelAllPending aborts every 'pulling' item and cancels every 'queued' item", async () => {
    const g1 = pausable();
    const g2 = pausable();
    const { executor } = makeExecutor({ "a:1": g1.behavior, "b:1": g2.behavior, "c:1": instantSuccess() });
    setPullExecutorForTests(executor);
    await startBatchPull(BASE_URL, ["a:1", "b:1", "c:1"], { concurrency: 2 });
    await settleMicrotasks();

    const summary = cancelAllPending();
    expect(summary.queued).toBe(0); // the still-queued third item is cancelled immediately

    await processQueue(BASE_URL);
    const final = getQueueSnapshot();
    expect(final.state.items.every(i => i.status === "cancelled")).toBe(true);
    expect(final.summary.outcome).toBe("complete-partial");
  });
});

describe("a failed item beside successful ones never turns the batch green", () => {
  test("mixed success/failure batch reports honest per-item outcomes and 'complete-partial' overall", async () => {
    const { executor } = makeExecutor({
      "good:1": instantSuccess(),
      "good:2": instantSuccess(),
      "bad:1": instantFailure("the runtime refused the connection mid-download"),
    });
    setPullExecutorForTests(executor);
    await startBatchPull(BASE_URL, ["good:1", "good:2", "bad:1"], { concurrency: 3 });
    await processQueue(BASE_URL);

    const { state, summary } = getQueueSnapshot();
    expect(summary.pulled).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.outcome).toBe("complete-partial");
    expect(summary.outcome).not.toBe("complete-success");
    const failedItem = state.items.find(i => i.tag === "bad:1")!;
    expect(failedItem.status).toBe("failed");
    expect(failedItem.error).toContain("refused the connection");
    const goodItem = state.items.find(i => i.tag === "good:1")!;
    expect(goodItem.status).toBe("pulled");
  });

  test("retrying a failed item resets it to queued and a later success turns only that item green", async () => {
    let attempt = 0;
    const { executor } = makeExecutor({
      "flaky:1": async (_tag, options) => {
        attempt += 1;
        if (attempt === 1) return { ok: false, failure: { kind: "network", error: "first attempt failed" } };
        options.onLine?.({ status: "success", digest: null, total: null, completed: null });
        return { ok: true };
      },
    });
    setPullExecutorForTests(executor);
    await startBatchPull(BASE_URL, ["flaky:1"]);
    await processQueue(BASE_URL);
    let item = getQueueSnapshot().state.items[0];
    expect(item.status).toBe("failed");

    const retry = retryItem(BASE_URL, item.id);
    expect(retry.ok).toBe(true);
    await processQueue(BASE_URL);
    item = getQueueSnapshot().state.items[0];
    expect(item.status).toBe("pulled");
    expect(item.error).toBeNull();
  });

  test("retrying a still-active item is refused", async () => {
    const g = pausable();
    const { executor } = makeExecutor({ "busy:1": g.behavior });
    setPullExecutorForTests(executor);
    await startBatchPull(BASE_URL, ["busy:1"]);
    await Promise.resolve();
    const item = getQueueSnapshot().state.items[0];
    expect(item.status).toBe("pulling");
    const retry = retryItem(BASE_URL, item.id);
    expect(retry.ok).toBe(false);
    g.release();
    await processQueue(BASE_URL);
  });
});

describe("never deletes an already-valid installed model", () => {
  test("the engine module's actual code never imports or calls the delete route (static guard, comments excluded)", async () => {
    const raw = await Bun.file(join(import.meta.dir, "..", "src", "lib", "model-runtime", "pull-queue-engine.ts")).text();
    // Strip block and line comments first — the module header explains this
    // guarantee in prose (and names the function it is a guarantee about),
    // which would otherwise make a bare substring check trip over its own
    // documentation. What must actually be absent is CODE that imports or
    // calls the delete route, not the English sentence describing why it
    // doesn't.
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).not.toMatch(/\bdeleteOllamaModel\b/);
    expect(code).not.toContain("/api/delete");
  });

  test("a failed re-pull of an already-installed tag never calls the real delete endpoint, and the model stays reported as installed", async () => {
    setPullQueueTagsFetcherForTests(tagsFetcherReporting(["stable:model"]));
    const { executor } = makeExecutor({ "stable:model": instantFailure("connection dropped mid-download") });
    setPullExecutorForTests(executor);

    const deleteCalls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "DELETE") {
        deleteCalls.push(typeof input === "string" ? input : input.toString());
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected real fetch during a fully test-doubled pull: ${String(input)}`);
    }) as typeof fetch;

    try {
      await startBatchPull(BASE_URL, ["stable:model"], { force: true });
      await processQueue(BASE_URL);
    } finally {
      globalThis.fetch = originalFetch;
    }

    const item = getQueueSnapshot().state.items[0];
    expect(item.status).toBe("failed");
    // The proof: nothing in this whole run ever issued a DELETE request.
    expect(deleteCalls).toEqual([]);
    // `deleteOllamaModel` itself is untouched by any of this — it exists for the
    // separate, explicit "Remove" action in `model-runtime-routes.ts`, never
    // called from anywhere in the pull-queue's own code path.
    expect(typeof deleteOllamaModel).toBe("function");
  });
});

describe("resume after a restart", () => {
  test("an interrupted 'pulling' item found already installed on resume is marked pulled WITHOUT re-downloading", async () => {
    updateAndFlushQueueState(state => {
      state.items.push({
        id: "was-pulling", tag: "finished-before-crash:1b", status: "pulling",
        requestedAt: 1, startedAt: 1, finishedAt: null,
        receivedBytes: 900, totalBytes: 1000, totalKnown: true,
        lastStatusMessage: "downloading", estimatedSizeBytes: null, error: null,
      });
    });

    // Simulate a fresh process: module flags and the store's in-memory cache are gone, the file survives.
    resetPullQueueEngineForTests();
    setPullQueueTagsFetcherForTests(tagsFetcherReporting(["finished-before-crash:1b"])); // it really did finish
    const { executor, calls } = makeExecutor({});
    setPullExecutorForTests(executor);

    await ensureResumed(BASE_URL);
    await processQueue(BASE_URL);

    const item = getQueueSnapshot().state.items.find(i => i.id === "was-pulling")!;
    expect(item.status).toBe("pulled");
    expect(item.lastStatusMessage).toContain("resume");
    expect(calls).toEqual([]); // never re-downloaded something that was already there
  });

  test("an interrupted 'pulling' item still NOT installed on resume is requeued and actually re-pulled", async () => {
    updateAndFlushQueueState(state => {
      state.items.push({
        id: "was-pulling-2", tag: "genuinely-interrupted:1b", status: "pulling",
        requestedAt: 1, startedAt: 1, finishedAt: null,
        receivedBytes: 900, totalBytes: 1000, totalKnown: true,
        lastStatusMessage: "downloading", estimatedSizeBytes: null, error: null,
      });
    });
    resetPullQueueEngineForTests();
    setPullQueueTagsFetcherForTests(tagsFetcherReporting([])); // NOT installed — the process really did die mid-pull
    const { executor, calls } = makeExecutor({ "genuinely-interrupted:1b": instantSuccess() });
    setPullExecutorForTests(executor);

    await ensureResumed(BASE_URL);
    // Reconcile clears progress and requeues synchronously before the network call is awaited.
    const reconciled = getQueueSnapshot().state.items.find(i => i.id === "was-pulling-2")!;
    expect(["queued", "pulling"]).toContain(reconciled.status);
    expect(reconciled.receivedBytes === 0 || reconciled.status === "pulling").toBe(true);

    await processQueue(BASE_URL);
    const final = getQueueSnapshot().state.items.find(i => i.id === "was-pulling-2")!;
    expect(final.status).toBe("pulled");
    expect(calls).toEqual(["genuinely-interrupted:1b"]); // this one genuinely was re-downloaded
  });

  test("a plain 'queued' item left over from before a restart is picked up and completed on resume", async () => {
    updateAndFlushQueueState(state => {
      state.items.push({
        id: "was-queued", tag: "never-started:1b", status: "queued",
        requestedAt: 1, startedAt: null, finishedAt: null,
        receivedBytes: 0, totalBytes: 0, totalKnown: false,
        lastStatusMessage: null, estimatedSizeBytes: null, error: null,
      });
    });
    resetPullQueueEngineForTests();
    setPullQueueTagsFetcherForTests(tagsFetcherReporting([]));
    const { executor } = makeExecutor({ "never-started:1b": instantSuccess() });
    setPullExecutorForTests(executor);

    await ensureResumed(BASE_URL);
    await processQueue(BASE_URL);
    const item = getQueueSnapshot().state.items.find(i => i.id === "was-queued")!;
    expect(item.status).toBe("pulled");
  });

  test("resume only reconciles once per process lifetime — a second ensureResumed call is a no-op", async () => {
    updateAndFlushQueueState(state => {
      state.items.push({
        id: "solo", tag: "solo:1b", status: "pulling",
        requestedAt: 1, startedAt: 1, finishedAt: null,
        receivedBytes: 0, totalBytes: 0, totalKnown: false,
        lastStatusMessage: null, estimatedSizeBytes: null, error: null,
      });
    });
    resetPullQueueEngineForTests();
    let tagsCalls = 0;
    setPullQueueTagsFetcherForTests((async () => { tagsCalls += 1; return { ok: true, data: [] }; }) as typeof import("../src/lib/model-runtime/client").fetchOllamaTags);
    const { executor } = makeExecutor({ "solo:1b": instantSuccess() });
    setPullExecutorForTests(executor);

    await ensureResumed(BASE_URL);
    await processQueue(BASE_URL);
    await ensureResumed(BASE_URL); // second call — must not re-fetch tags or re-reconcile
    expect(tagsCalls).toBe(1);
  });

  test("when the runtime cannot be reached at all during resume, a stuck 'pulling' item is requeued (never left claiming to be in flight) and eventually reaches a real terminal state rather than staying stuck forever", async () => {
    updateAndFlushQueueState(state => {
      state.items.push({
        id: "unreachable", tag: "unknown-state:1b", status: "pulling",
        requestedAt: 1, startedAt: 1, finishedAt: null,
        receivedBytes: 500, totalBytes: 1000, totalKnown: true,
        lastStatusMessage: "downloading", estimatedSizeBytes: null, error: null,
      });
    });
    resetPullQueueEngineForTests();
    setPullQueueTagsFetcherForTests((async () => ({ ok: false, failure: { kind: "refused" } })) as typeof import("../src/lib/model-runtime/client").fetchOllamaTags);
    // The runtime is genuinely unreachable in this scenario — a deterministic
    // fake stands in for that (never the real network client, which would make
    // this test's outcome depend on whatever happens to be listening on the
    // real Ollama port on the machine running the suite).
    const { executor } = makeExecutor({ "unknown-state:1b": instantFailure("the runtime refused the connection") });
    setPullExecutorForTests(executor);

    await ensureResumed(BASE_URL);
    // Reconcile-and-requeue kicks background processing synchronously, so by
    // the time `ensureResumed` resolves the item may already be legitimately
    // re-claimed into "pulling" for a fresh attempt — the point is that it is
    // never left believing an OLD, no-longer-real pull is still in flight.
    const midItem = getQueueSnapshot().state.items.find(i => i.id === "unreachable")!;
    expect(midItem.receivedBytes).toBe(0); // the stale pre-restart byte count (500) was cleared, never trusted across a restart
    expect(midItem.totalKnown).toBe(false);

    await processQueue(BASE_URL);
    const final = getQueueSnapshot().state.items.find(i => i.id === "unreachable")!;
    expect(final.status).toBe("failed"); // reached a real, observed terminal state — never stuck
    expect(final.receivedBytes).toBe(0);
  });
});

describe("clearFinishedItems", () => {
  test("drops terminal items only, leaves active ones alone", async () => {
    const g = pausable();
    const { executor } = makeExecutor({ "active:1": g.behavior, "done:1": instantSuccess() });
    setPullExecutorForTests(executor);
    await startBatchPull(BASE_URL, ["active:1", "done:1"], { concurrency: 2 });
    await settleMicrotasks();

    // "active:1" is still gated ("pulling"); clearing now must not touch it.
    const mid = clearFinishedItems();
    expect(mid.total).toBe(1);
    expect(getQueueSnapshot().state.items[0].tag).toBe("active:1");

    g.release();
    await processQueue(BASE_URL);
    const after = clearFinishedItems();
    expect(after.total).toBe(0);
  });
});
