/**
 * Single-flight controller for storage cleanup policy runs.
 *
 * Manual, startup, and scheduled evaluations share one in-flight slot. Heavy
 * work (archive scan, FS cleanup, SQLite reconcile) runs in a Bun Worker so the
 * proxy event loop stays responsive.
 */
import type { CleanupMode, CleanupResult } from "./cleanup";
import { resolveCodexHomeDir } from "../codex/home";
import {
  endStorageMutation,
  tryBeginStorageMutation,
} from "./storage-mutation-coordinator";
import {
  isPolicyDue,
  readStorageCleanupPolicyFromConfig,
  type PolicyRunReason,
  type PolicyRunResult,
  type PolicySkipReason,
} from "./policy";
import {
  drainStorageWorkers,
  registerStorageWorker,
  terminateStorageWorker,
} from "./worker-lifecycle";

export type PolicyJobStatus = "idle" | "running";

export interface PolicyJobOutcome {
  ok: boolean;
  skipped?: PolicySkipReason;
  deferred?: "codex_busy";
  error?: CleanupResult["error"] | "evaluation_failed" | "worker_failed" | "storage_mutation_busy";
  mode?: CleanupMode;
  freedBytes?: number;
  removed?: number;
  trashDir?: string;
}

export interface PolicyJobState {
  status: PolicyJobStatus;
  reason?: PolicyRunReason;
  startedAt?: number;
  finishedAt?: number;
  lastError?: string;
  lastOutcome?: PolicyJobOutcome;
}

export interface RequestPolicyRunOptions {
  reason: PolicyRunReason;
  force?: boolean;
  codexHome?: string;
  busyTimeoutMs?: number;
}

export interface PolicyJobTestHooks {
  /**
   * Block the worker (or in-process run) this many ms after the start-of-job
   * policy load, so concurrent PUTs can race completion metadata writes.
   */
  blockMs?: number;
  /**
   * When true, run on the main thread via `queueMicrotask` + optional sleep.
   * Used only for unit tests that cannot spawn workers; responsiveness tests
   * must leave this unset so work stays in a Worker.
   */
  runInProcess?: boolean;
  /** Expose GET /api/storage/cleanup-policy/test-stream for responsiveness tests. */
  enableTestStream?: boolean;
}

const WORKER_TIMEOUT_MS = 10 * 60 * 1000;

let state: PolicyJobState = { status: "idle" };
let inflight: Promise<void> | null = null;
let activeWorker: Worker | null = null;
let testHooks: PolicyJobTestHooks | null = null;
/** Optional mirror so completed worker runs refresh the live server config. */
let livePolicyApply: ((policy: PolicyRunResult["policy"]) => void) | undefined;
/** Settles the active `runInWorker` promise (clears watchdog) before hard terminate. */
let cancelActiveRun: (() => void) | null = null;
/** Bumped on abort/reset so a late worker completion cannot clobber newer job state. */
let runGeneration = 0;
/** CODEX_HOME whose mutation slot this job holds (parent thread only). */
let heldMutationHome: string | undefined;
/**
 * Ownership token for the slot recorded above, minted fresh for every run.
 *
 * `abortStorageCleanupPolicyJob` disowns a run without waiting for its worker to
 * exit, so a newer run can legitimately reacquire the slot for its own work
 * before the aborted run's `finally` ever gets to execute. That belated release
 * would then free a slot it no longer owns while the newer worker is still
 * touching the archive directory and the SQLite database, which is exactly what
 * the coordinator's single-flight gate exists to prevent. Comparing this token
 * before releasing makes a disowned run's cleanup a no-op, the same ownership
 * check `proxy-start-lock.ts` performs before unlinking its own owner file. A
 * symbol suffices because ownership never leaves this module.
 */
let heldMutationToken: symbol | undefined;

function acquireMutationSlotOwnership(codexHome: string): symbol {
  const token = Symbol("storage-cleanup-policy-mutation-slot");
  heldMutationHome = codexHome;
  heldMutationToken = token;
  return token;
}

/**
 * Unconditional release, for the paths that deliberately disown whatever run is
 * in flight (process shutdown abort, test reset). These must free the slot even
 * though the terminated worker has not settled yet, so a following run can start.
 */
function releaseHeldMutationSlot(): void {
  if (heldMutationHome === undefined) return;
  endStorageMutation(heldMutationHome);
  heldMutationHome = undefined;
  heldMutationToken = undefined;
}

/** Release only while `token` still owns the slot; see `heldMutationToken`. */
function releaseMutationSlotIfOwner(token: symbol): void {
  if (heldMutationToken !== token) return;
  releaseHeldMutationSlot();
}

export function setStorageCleanupPolicyJobLiveApply(
  apply: ((policy: PolicyRunResult["policy"]) => void) | null,
): void {
  livePolicyApply = apply ?? undefined;
}

export function getStorageCleanupPolicyJobState(): PolicyJobState {
  return { ...state, ...(state.lastOutcome ? { lastOutcome: { ...state.lastOutcome } } : {}) };
}

/** Test-only SSE/text stream served from the proxy while a worker is blocked. */
export function getStorageCleanupPolicyTestStreamResponse(): Response | null {
  if (!testHooks?.enableTestStream) return null;
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      async start(controller) {
        for (let i = 0; i < 8; i++) {
          controller.enqueue(encoder.encode(`chunk-${i}\n`));
          await Bun.sleep(50);
        }
        controller.close();
      },
    }),
    { headers: { "content-type": "text/plain; charset=utf-8" } },
  );
}

export function setStorageCleanupPolicyJobTestHooks(hooks: PolicyJobTestHooks | null): void {
  testHooks = hooks;
}

function disownActiveRun(): void {
  runGeneration += 1;
  const cancel = cancelActiveRun;
  cancelActiveRun = null;
  cancel?.();
}

export function resetStorageCleanupPolicyJobForTests(): void {
  disownActiveRun();
  if (activeWorker) {
    void terminateStorageWorker(activeWorker);
    activeWorker = null;
  }
  inflight = null;
  testHooks = null;
  releaseHeldMutationSlot();
  state = { status: "idle" };
}

/**
 * Await-able sibling of the reset above, for test teardown.
 *
 * `bun test --isolate` reclaims a file's realm at the file boundary. A storage
 * worker still exiting at that moment trips a Bun-internal assertion on Windows
 * and takes the whole run down, so a suite that spawns workers must be able to
 * wait for them rather than fire-and-forget.
 */
export async function resetStorageCleanupPolicyJobForTestsAsync(): Promise<void> {
  resetStorageCleanupPolicyJobForTests();
  await drainStorageWorkers();
}

/** Terminate an in-flight worker during process shutdown. */
export function abortStorageCleanupPolicyJob(): void {
  disownActiveRun();
  if (activeWorker) {
    void terminateStorageWorker(activeWorker);
    activeWorker = null;
  }
  releaseHeldMutationSlot();
  if (state.status === "running") {
    state = {
      ...state,
      status: "idle",
      finishedAt: Date.now(),
      lastError: "aborted",
      lastOutcome: {
        ok: false,
        error: "evaluation_failed",
      },
    };
  }
  inflight = null;
}

function outcomeFromResult(result: PolicyRunResult): PolicyJobOutcome {
  return {
    ok: result.ok,
    ...(result.skipped ? { skipped: result.skipped } : {}),
    ...(result.deferred ? { deferred: result.deferred } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(result.mode ? { mode: result.mode } : {}),
    ...(result.freedBytes !== undefined ? { freedBytes: result.freedBytes } : {}),
    ...(result.removed !== undefined ? { removed: result.removed } : {}),
    ...(result.trashDir ? { trashDir: result.trashDir } : {}),
  };
}

function applyFinished(result: PolicyRunResult): void {
  // Prefer the latest persisted policy over `result.policy`. The worker (or
  // in-process run) already merged run metadata into disk; a concurrent PUT
  // may also have landed after that write. Re-reading avoids applying a stale
  // start-of-job snapshot when the run skipped without saving.
  try {
    livePolicyApply?.(readStorageCleanupPolicyFromConfig());
  } catch {
    livePolicyApply?.(result.policy);
  }
  state = {
    status: "idle",
    reason: state.reason,
    startedAt: state.startedAt,
    finishedAt: Date.now(),
    lastOutcome: outcomeFromResult(result),
  };
}

function applyFailed(message: string): void {
  state = {
    status: "idle",
    reason: state.reason,
    startedAt: state.startedAt,
    finishedAt: Date.now(),
    lastError: message,
    lastOutcome: { ok: false, error: "worker_failed" },
  };
}

function applyMutationBusy(): void {
  state = {
    status: "idle",
    reason: state.reason,
    startedAt: state.startedAt,
    finishedAt: Date.now(),
    lastError: "storage_mutation_busy",
    lastOutcome: { ok: false, error: "storage_mutation_busy" },
  };
}

function runInWorker(opts: RequestPolicyRunOptions & { blockMs?: number }): Promise<PolicyRunResult> {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    let settled = false;
    const worker = new Worker(new URL("./policy-worker.ts", import.meta.url).href);
    registerStorageWorker(worker);
    activeWorker = worker;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cancelActiveRun = null;
      void terminateStorageWorker(worker);
      if (activeWorker === worker) activeWorker = null;
      reject(new Error("storage_cleanup_worker_timeout"));
    }, WORKER_TIMEOUT_MS);

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cancelActiveRun = null;
      clearTimeout(timer);
      if (activeWorker === worker) activeWorker = null;
      // Settle the caller only after the thread is actually gone, so a suite
      // that awaits its request cannot reach the next test file with a worker
      // still exiting behind it.
      void terminateStorageWorker(worker).then(fn, fn);
    };

    cancelActiveRun = () => {
      finish(() => reject(new Error("aborted")));
    };

    worker.onmessage = (event: MessageEvent<unknown>) => {
      const data = event.data;
      if (!data || typeof data !== "object") return;
      const msg = data as Record<string, unknown>;
      if (msg.requestId !== requestId) return;
      if (msg.type === "done" && msg.result && typeof msg.result === "object") {
        finish(() => resolve(msg.result as PolicyRunResult));
        return;
      }
      if (msg.type === "error") {
        const message = typeof msg.message === "string" ? msg.message : "worker_failed";
        finish(() => reject(new Error(message)));
      }
    };

    worker.onerror = (err: ErrorEvent) => {
      finish(() => reject(err.error instanceof Error ? err.error : new Error(err.message || "worker_failed")));
    };

    worker.postMessage({
      type: "run",
      requestId,
      reason: opts.reason,
      force: opts.force === true,
      ...(opts.codexHome ? { codexHome: opts.codexHome } : {}),
      ...(opts.busyTimeoutMs !== undefined ? { busyTimeoutMs: opts.busyTimeoutMs } : {}),
      ...(opts.blockMs !== undefined ? { blockMs: opts.blockMs } : {}),
      env: {
        ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}),
        ...(process.env.OPENCODEX_HOME ? { OPENCODEX_HOME: process.env.OPENCODEX_HOME } : {}),
      },
    });
  });
}

async function executeJob(opts: RequestPolicyRunOptions): Promise<void> {
  const generation = ++runGeneration;
  const codexHome = opts.codexHome ?? resolveCodexHomeDir();
  const gate = tryBeginStorageMutation("policy", codexHome);
  if (!gate.acquired) {
    if (generation === runGeneration) {
      applyMutationBusy();
    }
    return;
  }
  const ownership = acquireMutationSlotOwnership(codexHome);
  try {
    const blockMs = testHooks?.blockMs;
    let result: PolicyRunResult;

    if (testHooks?.runInProcess) {
      // Dynamic import keeps the sync engine out of the hot path for the default Worker mode.
      const { runStorageCleanupPolicy } = await import("./policy");
      result = runStorageCleanupPolicy({
        reason: opts.reason,
        force: opts.force === true,
        codexHome,
        ...(opts.busyTimeoutMs !== undefined ? { busyTimeoutMs: opts.busyTimeoutMs } : {}),
        ...(typeof blockMs === "number" && blockMs > 0 ? { holdAfterLoadMs: blockMs } : {}),
      });
    } else {
      result = await runInWorker({
        ...opts,
        codexHome,
        ...(typeof blockMs === "number" && blockMs > 0 ? { blockMs } : {}),
      });
    }

    if (generation !== runGeneration) return;
    applyFinished(result);
  } catch (err) {
    if (generation !== runGeneration) return;
    applyFailed(err instanceof Error ? err.message : "worker_failed");
  } finally {
    // Scoped to this run on purpose: `finally` also runs after the generation
    // early-returns above, by which point an abort plus a newer accepted run may
    // already hold the slot for still-in-flight work of their own.
    releaseMutationSlotIfOwner(ownership);
  }
}

/**
 * Start a cleanup evaluation if idle. Returns immediately; poll GET for outcome.
 */
export function requestStorageCleanupPolicyRun(
  opts: RequestPolicyRunOptions,
): { accepted: true; state: PolicyJobState } | { accepted: false; error: "already_running"; state: PolicyJobState } {
  if (inflight || state.status === "running") {
    return { accepted: false, error: "already_running", state: getStorageCleanupPolicyJobState() };
  }

  state = {
    status: "running",
    reason: opts.reason,
    startedAt: Date.now(),
    lastError: undefined,
    ...(state.lastOutcome ? { lastOutcome: state.lastOutcome } : {}),
  };

  const job = executeJob(opts);
  inflight = job;
  void job.finally(() => {
    if (inflight === job) inflight = null;
  });
  return { accepted: true, state: getStorageCleanupPolicyJobState() };
}

/**
 * Fire-and-forget entry for startup / schedule ticks.
 * Skips the single-flight slot when disabled or not due so manual runs stay free.
 */
export function maybeRequestStorageCleanupPolicyRun(
  reason: PolicyRunReason,
  opts?: Omit<RequestPolicyRunOptions, "reason">,
): void {
  try {
    const policy = readStorageCleanupPolicyFromConfig();
    if (!policy.enabled) return;
    if (!isPolicyDue(policy, Date.now(), reason)) return;
    requestStorageCleanupPolicyRun({ ...opts, reason });
  } catch {
    // Keep scheduler/startup non-throwing.
  }
}
