/**
 * `src/lib/converter/queue-engine.ts` — the converter batch queue's
 * processing engine.
 *
 * Same discipline `tests/model-runtime-pull-queue-engine.test.ts` already
 * proves for the model-pull queue, adapted for a synchronous, bounded job:
 * paged admission and its storage preflight, bounded concurrency, pause
 * (never interrupting an in-flight item), cancel (immediate for `queued`,
 * a documented no-op for `converting`), retry, "a failed item never turns
 * the batch green", and a restart-safe resume. The last section proves the
 * queue is wired to the REAL `convertStructuredDataAtPath` — including this
 * task's other fix, the server-side lossy-acknowledgement refusal — with no
 * injected executor at all, so this is proof of the real thing working
 * end-to-end, not only of the engine's own bookkeeping.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import {
  cancelAllPending,
  cancelItem,
  clearFinishedItems,
  ensureQueueResumed,
  enqueueConvertJobs,
  getQueueSnapshot,
  MAX_ENQUEUE_PAGE,
  pauseQueue,
  processQueue,
  resetConvertQueueEngineForTests,
  resumeQueue,
  retryItem,
  setConcurrencyLimit,
  setConvertExecutorForTests,
  setConvertQueueDiskProbeForTests,
  setPdfRotateExecutorForTests,
  setZipExtractExecutorForTests,
  type ConvertJobInput,
} from "../src/lib/converter/queue-engine";
import { setConvertQueueStorePathForTests, updateAndFlushQueueState } from "../src/lib/converter/queue-store";
import type { StructuredConversionOutcome, StructuredFormat } from "../src/lib/converter/structured-service";
import { buildZip } from "../src/lib/export-archive";
import { makePdf } from "./helpers/pdf-fixtures";

type Behavior = (sourcePath: string, destPath: string) => StructuredConversionOutcome | Promise<StructuredConversionOutcome>;

/** Deterministic, injectable stand-in for `convertStructuredDataAtPath` — one behavior per destPath, and a call log so tests can prove exactly what was (and was not) invoked. */
function makeExecutor(behaviors: Record<string, Behavior>) {
  const calls: string[] = [];
  const executor = async (
    sourcePath: string,
    _sourceFormat: StructuredFormat,
    destPath: string,
    _destFormat: StructuredFormat,
    _acknowledgeLossy?: boolean,
  ): Promise<StructuredConversionOutcome> => {
    calls.push(destPath);
    const behavior = behaviors[destPath];
    if (!behavior) throw new Error(`test executor: no behavior configured for destPath "${destPath}"`);
    return behavior(sourcePath, destPath);
  };
  return { executor, calls };
}

function instantSuccess(bytesWritten = 10): Behavior {
  return () => ({ ok: true, bytesWritten, lossy: false });
}

function instantFailure(message = "simulated conversion failure"): Behavior {
  return () => ({ ok: false, error: message });
}

/** Blocks until the test calls `release()` — the synchronous-conversion analogue of the pull queue's `pausable()`. */
function pausable(finalOutcome: StructuredConversionOutcome = { ok: true, bytesWritten: 1, lossy: false }): { behavior: Behavior; release: () => void } {
  let resolveGate: (() => void) | null = null;
  const gate = new Promise<void>(resolve => { resolveGate = resolve; });
  const behavior: Behavior = async () => { await gate; return finalOutcome; };
  return { behavior, release: () => resolveGate?.() };
}

/** Drains pending microtasks a generous, fixed number of times — deterministic, no real timers, just enough for a chain of un-gated async fakes to settle. */
async function settleMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

let dir: string;

function job(overrides: Partial<ConvertJobInput> = {}): ConvertJobInput {
  return {
    sourcePath: join(dir, "in.json"),
    sourceFormat: "json",
    destPath: join(dir, "out.csv"),
    destFormat: "csv",
    acknowledgeLossy: true,
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ocx-convert-queue-engine-test-"));
  setConvertQueueStorePathForTests(join(dir, "convert-queue.json"));
  resetConvertQueueEngineForTests();
  // Plenty of room unless a test explicitly narrows this to prove the refusal path.
  setConvertQueueDiskProbeForTests(async () => 10_000_000_000);
});

afterEach(() => {
  setConvertExecutorForTests(null);
  setConvertQueueDiskProbeForTests(null);
  resetConvertQueueEngineForTests();
  setConvertQueueStorePathForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

describe("enqueueConvertJobs — validation and admission", () => {
  test("rejects an empty job list", async () => {
    const result = await enqueueConvertJobs([]);
    expect(result.ok).toBe(false);
  });

  test("rejects a page over MAX_ENQUEUE_PAGE", async () => {
    const tooMany = Array.from({ length: MAX_ENQUEUE_PAGE + 1 }, (_, i) => job({ destPath: join(dir, `out-${i}.csv`) }));
    const result = await enqueueConvertJobs(tooMany);
    expect(result.ok).toBe(false);
  });

  test("rejects a relative sourcePath or destPath before touching the disk", async () => {
    const { executor, calls } = makeExecutor({});
    setConvertExecutorForTests(executor);
    const result = await enqueueConvertJobs([job({ sourcePath: "relative\\in.json" })]);
    expect(result.ok).toBe(false);
    await processQueue();
    expect(calls).toEqual([]);
  });

  test("admits a job and kicks background processing automatically — no explicit processQueue() call needed to make progress", async () => {
    writeFileSync(join(dir, "in.json"), JSON.stringify([{ a: 1 }]));
    const { executor } = makeExecutor({ [join(dir, "out.csv")]: instantSuccess() });
    setConvertExecutorForTests(executor);
    const result = await enqueueConvertJobs([job()]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.added).toBe(1);
    await processQueue();
    expect(getQueueSnapshot().state.items[0].status).toBe("converted");
  });

  test("a source file's real size is captured at enqueue time, never guessed", async () => {
    const src = join(dir, "in.json");
    writeFileSync(src, JSON.stringify([{ a: 1 }]));
    const realSize = readFileSync(src).byteLength;
    const { executor } = makeExecutor({ [join(dir, "out.csv")]: instantSuccess() });
    setConvertExecutorForTests(executor);
    await enqueueConvertJobs([job({ sourcePath: src })]);
    expect(getQueueSnapshot().state.items[0].sourceBytes).toBe(realSize);
  });

  test("a missing source's size is honestly null, never guessed, and the job is still admitted", async () => {
    const { executor } = makeExecutor({ [join(dir, "out.csv")]: instantFailure("the source could not be read") });
    setConvertExecutorForTests(executor);
    const result = await enqueueConvertJobs([job({ sourcePath: join(dir, "does-not-exist.json") })]);
    expect(result.ok).toBe(true);
    expect(getQueueSnapshot().state.items[0].sourceBytes).toBeNull();
    await processQueue();
  });

  test("an already-existing destination is skipped by default, never overwritten and never executed", async () => {
    writeFileSync(join(dir, "in.json"), JSON.stringify([{ a: 1 }]));
    const dest = join(dir, "out.csv");
    writeFileSync(dest, "original,untouched");
    const { executor, calls } = makeExecutor({});
    setConvertExecutorForTests(executor);
    const result = await enqueueConvertJobs([job({ destPath: dest })]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.items[0].status).toBe("skipped");
    await processQueue();
    expect(calls).toEqual([]);
    expect(readFileSync(dest, "utf-8")).toBe("original,untouched"); // never touched
  });

  test("overwrite: true re-queues an already-existing destination instead of skipping it", async () => {
    writeFileSync(join(dir, "in.json"), JSON.stringify([{ a: 1 }]));
    const dest = join(dir, "out.csv");
    writeFileSync(dest, "stale,data");
    const { executor, calls } = makeExecutor({ [dest]: instantSuccess() });
    setConvertExecutorForTests(executor);
    const result = await enqueueConvertJobs([job({ destPath: dest, overwrite: true })]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Background processing may already have synchronously claimed AND
    // finished this by the time enqueueConvertJobs's own await chain (the
    // preflight probe) unwinds — a fast, un-gated executor can complete
    // within that same microtask window. Anything but "skipped" proves the
    // point: it was not silently skipped despite overwrite: true.
    expect(["queued", "converting", "converted"]).toContain(result.state.items[0].status);
    await processQueue();
    expect(calls).toEqual([dest]);
    expect(getQueueSnapshot().state.items[0].status).toBe("converted");
  });
});

describe("enqueueConvertJobs — storage-capacity preflight", () => {
  test("refuses the whole page and admits nothing when a destination definitely lacks the free space", async () => {
    writeFileSync(join(dir, "in.json"), JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ i }))));
    setConvertQueueDiskProbeForTests(async () => 1); // basically no free space anywhere
    const { executor, calls } = makeExecutor({ [join(dir, "out.csv")]: instantSuccess() });
    setConvertExecutorForTests(executor);
    const result = await enqueueConvertJobs([job()]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.preflight?.insufficientDiskSpace).toBe(true);
    expect(getQueueSnapshot().state.items).toHaveLength(0); // nothing admitted
    await processQueue();
    expect(calls).toEqual([]);
  });

  test("an unknown (undetermined) disk reading never blocks admission", async () => {
    writeFileSync(join(dir, "in.json"), JSON.stringify([{ a: 1 }]));
    setConvertQueueDiskProbeForTests(async () => null);
    const { executor } = makeExecutor({ [join(dir, "out.csv")]: instantSuccess() });
    setConvertExecutorForTests(executor);
    const result = await enqueueConvertJobs([job()]);
    expect(result.ok).toBe(true);
    await processQueue();
    expect(getQueueSnapshot().state.items[0].status).toBe("converted");
  });
});

describe("bounded concurrency", () => {
  test("never runs more items 'converting' at once than the configured concurrency", async () => {
    const gates = [1, 2, 3, 4].map(() => pausable());
    const jobs = [1, 2, 3, 4].map(i => job({ sourcePath: join(dir, `in-${i}.json`), destPath: join(dir, `out-${i}.csv`) }));
    for (const j of jobs) writeFileSync(j.sourcePath, JSON.stringify([{ a: 1 }]));
    const behaviors: Record<string, Behavior> = {};
    jobs.forEach((j, i) => { behaviors[j.destPath] = gates[i]!.behavior; });
    const { executor } = makeExecutor(behaviors);
    setConvertExecutorForTests(executor);
    setConcurrencyLimit(2);

    const result = await enqueueConvertJobs(jobs);
    expect(result.ok).toBe(true);

    await settleMicrotasks();

    const midSnapshot = getQueueSnapshot();
    const convertingCount = midSnapshot.state.items.filter(i => i.status === "converting").length;
    expect(convertingCount).toBeLessThanOrEqual(2);
    expect(convertingCount).toBeGreaterThan(0);

    for (const g of gates) g.release();
    await processQueue();
    const finalSnapshot = getQueueSnapshot();
    expect(finalSnapshot.summary.converted).toBe(4);
    expect(finalSnapshot.summary.outcome).toBe("complete-success");
  });
});

describe("pause never interrupts an in-flight item", () => {
  test("pausing stops claiming new queued items, but an already-'converting' item still finishes", async () => {
    const gate = pausable();
    const running = job({ destPath: join(dir, "running.csv") });
    const waiting = job({ destPath: join(dir, "waiting.csv") });
    writeFileSync(running.sourcePath, JSON.stringify([{ a: 1 }]));
    writeFileSync(waiting.sourcePath, JSON.stringify([{ a: 1 }]));
    const { executor, calls } = makeExecutor({ [running.destPath]: gate.behavior, [waiting.destPath]: instantSuccess() });
    setConvertExecutorForTests(executor);
    setConcurrencyLimit(1); // force strict ordering: "running" claims first, "waiting" stays queued

    await enqueueConvertJobs([running, waiting]);
    await settleMicrotasks();
    expect(getQueueSnapshot().state.items.find(i => i.destPath === running.destPath)?.status).toBe("converting");

    const summary = pauseQueue();
    expect(summary).toBeTruthy();
    expect(getQueueSnapshot().state.paused).toBe(true);

    gate.release();
    await settleMicrotasks();

    // The already-running item completed even though the queue is paused.
    expect(getQueueSnapshot().state.items.find(i => i.destPath === running.destPath)?.status).toBe("converted");
    // The still-queued item was never claimed while paused.
    expect(getQueueSnapshot().state.items.find(i => i.destPath === waiting.destPath)?.status).toBe("queued");
    expect(calls).toEqual([running.destPath]);

    const resumeSummary = resumeQueue();
    expect(getQueueSnapshot().state.paused).toBe(false);
    void resumeSummary;
    await processQueue();
    expect(getQueueSnapshot().state.items.find(i => i.destPath === waiting.destPath)?.status).toBe("converted");
    expect(calls).toEqual([running.destPath, waiting.destPath]);
  });
});

describe("cancel", () => {
  test("cancelling a still-'queued' item is immediate and it is never executed", async () => {
    const gate = pausable();
    const busy = job({ destPath: join(dir, "busy.csv") });
    const neverStarted = job({ destPath: join(dir, "never-started.csv") });
    writeFileSync(busy.sourcePath, JSON.stringify([{ a: 1 }]));
    writeFileSync(neverStarted.sourcePath, JSON.stringify([{ a: 1 }]));
    const { executor, calls } = makeExecutor({ [busy.destPath]: gate.behavior, [neverStarted.destPath]: instantSuccess() });
    setConvertExecutorForTests(executor);
    setConcurrencyLimit(1);

    await enqueueConvertJobs([busy, neverStarted]);
    await settleMicrotasks();
    const queuedItem = getQueueSnapshot().state.items.find(i => i.destPath === neverStarted.destPath)!;
    expect(queuedItem.status).toBe("queued");

    const result = cancelItem(queuedItem.id);
    expect(result.ok).toBe(true);

    gate.release();
    await processQueue();

    expect(calls).not.toContain(neverStarted.destPath);
    const final = getQueueSnapshot().state.items.find(i => i.destPath === neverStarted.destPath)!;
    expect(final.status).toBe("cancelled");
  });

  test("cancelling an unknown id is an honest failure, not a silent no-op success", () => {
    const result = cancelItem("no-such-id");
    expect(result.ok).toBe(false);
  });

  test("cancelling a 'converting' item is a documented no-op — it still reaches its own natural terminal state", async () => {
    const gate = pausable();
    const j = job();
    writeFileSync(j.sourcePath, JSON.stringify([{ a: 1 }]));
    const { executor } = makeExecutor({ [j.destPath]: gate.behavior });
    setConvertExecutorForTests(executor);

    await enqueueConvertJobs([j]);
    await settleMicrotasks();
    const converting = getQueueSnapshot().state.items[0];
    expect(converting.status).toBe("converting");

    const result = cancelItem(converting.id);
    expect(result.ok).toBe(true); // reports ok — cancel is never a hard error here — but changes nothing
    expect(getQueueSnapshot().state.items[0].status).toBe("converting");

    gate.release();
    await processQueue();
    expect(getQueueSnapshot().state.items[0].status).toBe("converted"); // ran to completion, not cancelled
  });

  test("cancelAllPending cancels every 'queued' item and leaves a 'converting' item to finish naturally", async () => {
    const gate = pausable();
    const running = job({ destPath: join(dir, "running.csv") });
    const q1 = job({ destPath: join(dir, "q1.csv") });
    const q2 = job({ destPath: join(dir, "q2.csv") });
    for (const j of [running, q1, q2]) writeFileSync(j.sourcePath, JSON.stringify([{ a: 1 }]));
    const { executor } = makeExecutor({ [running.destPath]: gate.behavior, [q1.destPath]: instantSuccess(), [q2.destPath]: instantSuccess() });
    setConvertExecutorForTests(executor);
    setConcurrencyLimit(1);

    await enqueueConvertJobs([running, q1, q2]);
    await settleMicrotasks();

    const summary = cancelAllPending();
    expect(summary.queued).toBe(0);

    gate.release();
    await processQueue();
    const final = getQueueSnapshot();
    expect(final.state.items.find(i => i.destPath === running.destPath)?.status).toBe("converted");
    expect(final.state.items.find(i => i.destPath === q1.destPath)?.status).toBe("cancelled");
    expect(final.state.items.find(i => i.destPath === q2.destPath)?.status).toBe("cancelled");
    expect(final.summary.outcome).toBe("complete-partial");
  });
});

describe("a failed item beside successful ones never turns the batch green", () => {
  test("mixed success/failure reports honest per-item outcomes and 'complete-partial' overall", async () => {
    const good1 = job({ destPath: join(dir, "good1.csv") });
    const good2 = job({ destPath: join(dir, "good2.csv") });
    const bad = job({ destPath: join(dir, "bad.csv") });
    for (const j of [good1, good2, bad]) writeFileSync(j.sourcePath, JSON.stringify([{ a: 1 }]));
    const { executor } = makeExecutor({
      [good1.destPath]: instantSuccess(),
      [good2.destPath]: instantSuccess(),
      [bad.destPath]: instantFailure("the runtime refused to serialize this value"),
    });
    setConvertExecutorForTests(executor);
    setConcurrencyLimit(3);

    await enqueueConvertJobs([good1, good2, bad]);
    await processQueue();

    const { state, summary } = getQueueSnapshot();
    expect(summary.converted).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.outcome).toBe("complete-partial");
    expect(summary.outcome).not.toBe("complete-success");
    const failedItem = state.items.find(i => i.destPath === bad.destPath)!;
    expect(failedItem.status).toBe("failed");
    expect(failedItem.error).toContain("refused to serialize");
  });

  test("retrying a failed item resets it to queued and a later success turns only that item green", async () => {
    let attempt = 0;
    const j = job();
    writeFileSync(j.sourcePath, JSON.stringify([{ a: 1 }]));
    const executor = async (): Promise<StructuredConversionOutcome> => {
      attempt += 1;
      if (attempt === 1) return { ok: false, error: "first attempt failed" };
      return { ok: true, bytesWritten: 5, lossy: false };
    };
    setConvertExecutorForTests(executor);

    await enqueueConvertJobs([j]);
    await processQueue();
    let item = getQueueSnapshot().state.items[0];
    expect(item.status).toBe("failed");

    const retry = retryItem(item.id);
    expect(retry.ok).toBe(true);
    await processQueue();
    item = getQueueSnapshot().state.items[0];
    expect(item.status).toBe("converted");
    expect(item.error).toBeNull();
  });

  test("retrying a still-active item is refused", async () => {
    const gate = pausable();
    const j = job();
    writeFileSync(j.sourcePath, JSON.stringify([{ a: 1 }]));
    const { executor } = makeExecutor({ [j.destPath]: gate.behavior });
    setConvertExecutorForTests(executor);
    await enqueueConvertJobs([j]);
    await Promise.resolve();
    const item = getQueueSnapshot().state.items[0];
    expect(item.status).toBe("converting");
    const retry = retryItem(item.id);
    expect(retry.ok).toBe(false);
    gate.release();
    await processQueue();
  });

  test("retrying an unknown id is refused", () => {
    const result = retryItem("no-such-id");
    expect(result.ok).toBe(false);
  });
});

describe("resume after a restart", () => {
  test("an item still 'converting' when the process died is requeued and actually re-run — re-running a structured conversion is safe and idempotent", async () => {
    const j = job();
    writeFileSync(j.sourcePath, JSON.stringify([{ a: 1 }]));
    updateAndFlushQueueState(state => {
      state.items.push({
        id: "was-converting", kind: "structured",
        sourcePath: j.sourcePath, sourceFormat: "json", destPath: j.destPath, destFormat: "csv", acknowledgeLossy: true,
        status: "converting",
        requestedAt: 1, startedAt: 1, finishedAt: null,
        sourceBytes: 10, bytesWritten: null, lossy: null, notes: null, boundary: null, error: null,
      });
    });

    // Simulate a fresh process: module flags and the store's in-memory cache are gone, the file survives.
    resetConvertQueueEngineForTests();
    setConvertQueueStorePathForTests(join(dir, "convert-queue.json"));
    setConvertQueueDiskProbeForTests(async () => 10_000_000_000);
    const { executor, calls } = makeExecutor({ [j.destPath]: instantSuccess(7) });
    setConvertExecutorForTests(executor);

    const resumedState = ensureQueueResumed();
    const midItem = resumedState.items.find(i => i.id === "was-converting")!;
    expect(["queued", "converting"]).toContain(midItem.status); // requeued and possibly already re-claimed synchronously

    await processQueue();
    const final = getQueueSnapshot().state.items.find(i => i.id === "was-converting")!;
    expect(final.status).toBe("converted");
    expect(final.bytesWritten).toBe(7);
    expect(calls).toEqual([j.destPath]); // it really was re-run, not assumed complete
  });

  test("a plain 'queued' item left over from before a restart is picked up and completed on resume", async () => {
    const j = job({ destPath: join(dir, "was-queued.csv") });
    writeFileSync(j.sourcePath, JSON.stringify([{ a: 1 }]));
    updateAndFlushQueueState(state => {
      state.items.push({
        id: "was-queued", kind: "structured",
        sourcePath: j.sourcePath, sourceFormat: "json", destPath: j.destPath, destFormat: "csv", acknowledgeLossy: true,
        status: "queued",
        requestedAt: 1, startedAt: null, finishedAt: null,
        sourceBytes: 10, bytesWritten: null, lossy: null, notes: null, boundary: null, error: null,
      });
    });
    resetConvertQueueEngineForTests();
    setConvertQueueStorePathForTests(join(dir, "convert-queue.json"));
    setConvertQueueDiskProbeForTests(async () => 10_000_000_000);
    const { executor } = makeExecutor({ [j.destPath]: instantSuccess() });
    setConvertExecutorForTests(executor);

    ensureQueueResumed();
    await processQueue();
    expect(getQueueSnapshot().state.items.find(i => i.id === "was-queued")?.status).toBe("converted");
  });

  test("resume reconciles only once per process lifetime — a second ensureQueueResumed() call is a no-op", async () => {
    const laterDest = join(dir, "later.csv");
    const { executor, calls } = makeExecutor({ [laterDest]: instantSuccess() });

    updateAndFlushQueueState(state => {
      state.items.push({
        id: "solo", kind: "structured",
        sourcePath: join(dir, "solo.json"), sourceFormat: "json", destPath: join(dir, "solo.csv"), destFormat: "csv", acknowledgeLossy: true,
        status: "converted",
        requestedAt: 1, startedAt: 1, finishedAt: 1, sourceBytes: 10, bytesWritten: 5, lossy: false, notes: null, boundary: null, error: null,
      });
    });
    resetConvertQueueEngineForTests();
    setConvertQueueStorePathForTests(join(dir, "convert-queue.json"));
    setConvertQueueDiskProbeForTests(async () => 10_000_000_000);
    setConvertExecutorForTests(executor); // resetConvertQueueEngineForTests cleared it — set it again, after reset, like a real process would

    ensureQueueResumed();
    // Manually flip a fresh item to "converting" AFTER the first resume — a
    // second resume call must not touch it, proving the guard is real. If
    // the guard were disabled, the second call's reconcile loop would
    // requeue this item and `processQueue` would claim it, synchronously
    // invoking the executor before this function's own synchronous portion
    // even finishes — so an empty `calls` array is the actual proof, not
    // just the status string (which a broken guard can still coincidentally
    // leave reading "converting" after a fresh re-claim).
    updateAndFlushQueueState(state => {
      state.items.push({
        id: "added-after-first-resume", kind: "structured",
        sourcePath: join(dir, "later.json"), sourceFormat: "json", destPath: laterDest, destFormat: "csv", acknowledgeLossy: true,
        status: "converting",
        requestedAt: 2, startedAt: 2, finishedAt: null, sourceBytes: 10, bytesWritten: null, lossy: null, notes: null, boundary: null, error: null,
      });
    });
    ensureQueueResumed();
    expect(getQueueSnapshot().state.items.find(i => i.id === "added-after-first-resume")?.status).toBe("converting");
    expect(calls).toEqual([]); // never claimed, never executed — the second call truly did nothing
  });
});

describe("clearFinishedItems", () => {
  test("drops terminal items only, leaves active/queued items alone", async () => {
    const gate = pausable();
    const active = job({ destPath: join(dir, "active.csv") });
    const done = job({ destPath: join(dir, "done.csv") });
    writeFileSync(active.sourcePath, JSON.stringify([{ a: 1 }]));
    writeFileSync(done.sourcePath, JSON.stringify([{ a: 1 }]));
    const { executor } = makeExecutor({ [active.destPath]: gate.behavior, [done.destPath]: instantSuccess() });
    setConvertExecutorForTests(executor);
    setConcurrencyLimit(2);
    await enqueueConvertJobs([active, done]);
    await settleMicrotasks();

    // "active" is still gated ("converting"); clearing now must not touch it.
    const mid = clearFinishedItems();
    expect(mid.total).toBe(1);
    expect(getQueueSnapshot().state.items[0].destPath).toBe(active.destPath);

    gate.release();
    await processQueue();
    const after = clearFinishedItems();
    expect(after.total).toBe(0);
  });
});

describe("the real converter, wired end to end — no injected executor at all", () => {
  test("a real JSON source is really converted to a real CSV file on disk, once acknowledged", async () => {
    const src = join(dir, "real-in.json");
    const dest = join(dir, "real-out.csv");
    writeFileSync(src, JSON.stringify([{ name: "Ada", role: "engineer" }]));

    const result = await enqueueConvertJobs([{ sourcePath: src, sourceFormat: "json", destPath: dest, destFormat: "csv", acknowledgeLossy: true }]);
    expect(result.ok).toBe(true);
    await processQueue();

    const item = getQueueSnapshot().state.items[0];
    expect(item.status).toBe("converted");
    expect(item.lossy).toBe(true);
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest, "utf-8")).toContain("Ada,engineer");
  });

  test("the queue honors this task's OTHER fix too: a lossy job queued without acknowledgeLossy fails with boundary lossy-not-acknowledged, and writes nothing", async () => {
    const src = join(dir, "real-in-2.json");
    const dest = join(dir, "real-out-2.csv");
    writeFileSync(src, JSON.stringify([{ name: "Ada" }]));

    const result = await enqueueConvertJobs([{ sourcePath: src, sourceFormat: "json", destPath: dest, destFormat: "csv" }]); // acknowledgeLossy omitted
    expect(result.ok).toBe(true);
    await processQueue();

    const item = getQueueSnapshot().state.items[0];
    expect(item.status).toBe("failed");
    expect(item.boundary).toBe("lossy-not-acknowledged");
    expect(item.error).toContain("acknowledgeLossy: true");
    expect(existsSync(dest)).toBe(false);
  });
});

describe("enqueueConvertJobs — kind validation", () => {
  test("an unknown kind is refused before anything is admitted", async () => {
    const result = await enqueueConvertJobs([{ ...job(), kind: "not-a-real-kind" as never }]);
    expect(result.ok).toBe(false);
    expect(getQueueSnapshot().state.items).toHaveLength(0);
  });

  test("a structured job (kind omitted, the default) still requires sourceFormat and destFormat", async () => {
    const result = await enqueueConvertJobs([{ sourcePath: join(dir, "in.json"), destPath: join(dir, "out.csv") } as ConvertJobInput]);
    expect(result.ok).toBe(false);
    expect(getQueueSnapshot().state.items).toHaveLength(0);
  });

  test("a pdf-rotate job without a valid rotateDegrees is refused", async () => {
    const result = await enqueueConvertJobs([{
      kind: "pdf-rotate", sourcePath: join(dir, "in.pdf"), destPath: join(dir, "out.pdf"),
    } as ConvertJobInput]);
    expect(result.ok).toBe(false);
    expect(getQueueSnapshot().state.items).toHaveLength(0);
  });

  test("a zip-extract job needs neither sourceFormat/destFormat nor rotateDegrees", async () => {
    const { executor } = makeExecutor({});
    setConvertExecutorForTests(executor); // proves the structured path is never touched
    setZipExtractExecutorForTests(() => ({ ok: true, bytesWritten: 0, lossy: false, notes: ["extracted 0 entries"] }));
    const result = await enqueueConvertJobs([{
      kind: "zip-extract", sourcePath: join(dir, "in.zip"), destPath: join(dir, "out-dir"),
    } as ConvertJobInput]);
    expect(result.ok).toBe(true);
    await processQueue();
    expect(getQueueSnapshot().state.items[0].status).toBe("converted");
  });
});

describe("kind: zip-extract", () => {
  test("dispatches to the zip-extract executor, not the structured one, and carries kind/notes through", async () => {
    const structured = makeExecutor({});
    setConvertExecutorForTests(structured.executor);
    const zipCalls: Array<{ sourcePath: string; destPath: string }> = [];
    setZipExtractExecutorForTests((sourcePath, destPath) => {
      zipCalls.push({ sourcePath, destPath });
      return { ok: true, bytesWritten: 42, lossy: false, notes: ["extracted 3 entries"] };
    });

    const src = join(dir, "archive.zip");
    const destDir = join(dir, "extracted");
    writeFileSync(src, "not a real zip — the executor is stubbed, so its bytes are never read");
    const result = await enqueueConvertJobs([{ kind: "zip-extract", sourcePath: src, destPath: destDir } as ConvertJobInput]);
    expect(result.ok).toBe(true);
    await processQueue();

    expect(zipCalls).toEqual([{ sourcePath: src, destPath: destDir }]);
    expect(structured.calls).toEqual([]); // the wrong executor was never invoked
    const item = getQueueSnapshot().state.items[0];
    expect(item.kind).toBe("zip-extract");
    expect(item.status).toBe("converted");
    expect(item.bytesWritten).toBe(42);
    expect(item.notes).toEqual(["extracted 3 entries"]);
    expect(item.sourceFormat).toBeNull();
    expect(item.destFormat).toBeNull();
  });

  test("a failing zip-extract reports the real service's boundary/error and never turns the batch green", async () => {
    setZipExtractExecutorForTests(() => ({ ok: false, boundary: "bomb-suspected", error: "the archive expands far beyond its compressed size" }));
    const result = await enqueueConvertJobs([{
      kind: "zip-extract", sourcePath: join(dir, "bad.zip"), destPath: join(dir, "bad-out"),
    } as ConvertJobInput]);
    expect(result.ok).toBe(true);
    await processQueue();
    const item = getQueueSnapshot().state.items[0];
    expect(item.status).toBe("failed");
    expect(item.boundary).toBe("bomb-suspected");
    expect(getQueueSnapshot().summary.outcome).toBe("complete-partial");
  });

  test("a real ZIP is really extracted to real files on disk — no injected executor at all", async () => {
    const zipBytes = buildZip([
      { path: "hello.txt", data: new TextEncoder().encode("hello from the queue") },
      { path: "nested/inner.txt", data: new TextEncoder().encode("nested file") },
    ]);
    const src = join(dir, "real.zip");
    writeFileSync(src, zipBytes);
    const destDir = join(dir, "real-extracted");

    const result = await enqueueConvertJobs([{ kind: "zip-extract", sourcePath: src, destPath: destDir } as ConvertJobInput]);
    expect(result.ok).toBe(true);
    await processQueue();

    const item = getQueueSnapshot().state.items[0];
    expect(item.status).toBe("converted");
    expect(readFileSync(join(destDir, "hello.txt"), "utf-8")).toBe("hello from the queue");
    expect(readFileSync(join(destDir, "nested", "inner.txt"), "utf-8")).toBe("nested file");
  });
});

describe("kind: pdf-rotate", () => {
  test("dispatches to the pdf-rotate executor with the item's own rotateDegrees and acknowledgeLossy (as acknowledgeSigned)", async () => {
    const structured = makeExecutor({});
    setConvertExecutorForTests(structured.executor);
    const rotateCalls: Array<{ sourcePath: string; destPath: string; degrees: number; ack: boolean | undefined }> = [];
    setPdfRotateExecutorForTests((sourcePath, destPath, degrees, ack) => {
      rotateCalls.push({ sourcePath, destPath, degrees, ack });
      return { ok: true, bytesWritten: 99, lossy: false, notes: ["rotated every page (2) by 90 degree(s)"] };
    });

    const src = join(dir, "doc.pdf");
    const dest = join(dir, "doc-rotated.pdf");
    writeFileSync(src, "not real pdf bytes — the executor is stubbed");
    const result = await enqueueConvertJobs([{
      kind: "pdf-rotate", sourcePath: src, destPath: dest, rotateDegrees: 90, acknowledgeLossy: true,
    } as ConvertJobInput]);
    expect(result.ok).toBe(true);
    await processQueue();

    expect(rotateCalls).toEqual([{ sourcePath: src, destPath: dest, degrees: 90, ack: true }]);
    expect(structured.calls).toEqual([]);
    const item = getQueueSnapshot().state.items[0];
    expect(item.kind).toBe("pdf-rotate");
    expect(item.rotateDegrees).toBe(90);
    expect(item.status).toBe("converted");
    expect(item.bytesWritten).toBe(99);
  });

  test("a failing pdf-rotate (e.g. a signed source refused without acknowledgement) reports the real boundary/error", async () => {
    setPdfRotateExecutorForTests(() => ({ ok: false, error: "the source carries a digital signature; this edit will invalidate it — retry with acknowledgeSigned: true once you have shown the user that disclosure" }));
    const result = await enqueueConvertJobs([{
      kind: "pdf-rotate", sourcePath: join(dir, "signed.pdf"), destPath: join(dir, "signed-out.pdf"), rotateDegrees: 180,
    } as ConvertJobInput]);
    expect(result.ok).toBe(true);
    await processQueue();
    const item = getQueueSnapshot().state.items[0];
    expect(item.status).toBe("failed");
    expect(item.error).toContain("acknowledgeSigned: true");
  });

  test("a real PDF has every page really rotated on disk — no injected executor at all, and the page count is learned by inspecting, never guessed", async () => {
    const src = join(dir, "real.pdf");
    const dest = join(dir, "real-rotated.pdf");
    writeFileSync(src, await makePdf([[150, 200], [150, 200], [150, 200]])); // 3 pages, all rotation 0

    const result = await enqueueConvertJobs([{
      kind: "pdf-rotate", sourcePath: src, destPath: dest, rotateDegrees: 90,
    } as ConvertJobInput]);
    expect(result.ok).toBe(true);
    await processQueue();

    const item = getQueueSnapshot().state.items[0];
    expect(item.status).toBe("converted");
    expect(item.notes?.[0]).toContain("every page (3)");

    const written = await PDFDocument.load(readFileSync(dest));
    expect(written.getPageCount()).toBe(3);
    for (const page of written.getPages()) expect(page.getRotation().angle).toBe(90);
  });
});
