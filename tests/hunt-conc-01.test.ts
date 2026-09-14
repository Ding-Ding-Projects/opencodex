/**
 * hunt-conc-01: an aborted storage-cleanup-policy run's delayed cleanup can release a
 * LATER run's shared storage-mutation slot while that later run is still actively working.
 *
 * `policy-job.ts` tracks the codexHome whose mutation slot the CURRENT job holds in one
 * module-level `heldMutationHome` variable, and releases it unconditionally in
 * `executeJob`'s `finally` block. `state` mutations are correctly guarded by a
 * `runGeneration` compare-and-skip so a disowned run cannot clobber a newer run's status,
 * but `releaseHeldMutationSlot()` has no equivalent per-run ownership token and sits
 * OUTSIDE that generation check (in `finally`, which always runs even after an early
 * `return`). So: abort a running job (exactly what `abortStorageCleanupPolicyJob` does on
 * process shutdown, or a test/reset call, without waiting for the worker to actually
 * exit), start a new run before the aborted worker's termination promise settles, and the
 * aborted run's belated `finally` releases the NEW run's slot while its worker is still
 * touching the archive directory / SQLite DB -- defeating the single-flight guarantee
 * `storage-mutation-coordinator.ts` exists to provide, and letting a wholly unrelated
 * mutation (manual cleanup, restore) start concurrently with it.
 *
 * Invariant under test: while a policy job reports status "running", the shared
 * storage-mutation slot it holds must stay held, continuously, for its own lifetime. This
 * is RED at tip and is expected to go GREEN once `heldMutationHome` release is scoped to
 * the run that actually still owns it (e.g. a per-run token compared before release, the
 * same defence `proxy-start-lock.ts` already uses for its own owner file).
 *
 * A real `Worker` cannot be driven with fake timers, and terminating a worker that is
 * mid-synchronous-sleep does not appear to interrupt that sleep (observed empirically:
 * teardown of a cancelled worker takes roughly its remaining `holdAfterLoadMs`, not a few
 * milliseconds), so this test waits out real wall-clock time with small, short holds and
 * always drains to a finished worker before returning, even on assertion failure.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";
import { removeTempDir } from "./helpers/temp-dir";
import {
  abortStorageCleanupPolicyJob,
  getStorageCleanupPolicyJobState,
  requestStorageCleanupPolicyRun,
  resetStorageCleanupPolicyJobForTestsAsync,
  setStorageCleanupPolicyJobTestHooks,
} from "../src/storage/policy-job";
import {
  endStorageMutation,
  getActiveStorageMutation,
  resetStorageMutationCoordinatorForTests,
  tryBeginStorageMutation,
} from "../src/storage/storage-mutation-coordinator";

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

function baseConfig(): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        authMode: "forward",
      },
    },
  } as OcxConfig;
}

async function waitUntilIdle(deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (getStorageCleanupPolicyJobState().status === "running" && Date.now() < deadline) {
    await Bun.sleep(25);
  }
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-hunt-conc-01-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-hunt-conc-01-"));
  process.env.OPENCODEX_HOME = testDir;
  saveConfig(baseConfig());
  resetStorageMutationCoordinatorForTests();
});

afterEach(async () => {
  await resetStorageCleanupPolicyJobForTestsAsync();
  setStorageCleanupPolicyJobTestHooks(null);
  resetStorageMutationCoordinatorForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) removeTempDir(testDir);
  testDir = "";
}, 20_000);

describe("storage cleanup policy job abort race (hunt-conc-01)", () => {
  test("a running job's mutation slot must stay held for its own lifetime, not be freed by an aborted earlier run", async () => {
    const blockMs = 700;
    setStorageCleanupPolicyJobTestHooks({ blockMs });

    let slotWentMissingWhileRunning = false;
    let intruderAcquiredWhileRunning = false;
    let stillRunningAtSampleTime = false;

    try {
      // Run A: acquires the shared "policy" mutation slot and dispatches to a real Worker
      // that will hold (via holdAfterLoadMs) for blockMs.
      const first = requestStorageCleanupPolicyRun({ reason: "manual" });
      expect(first.accepted).toBe(true);
      expect(getActiveStorageMutation()?.kind).toBe("policy");

      // Disown/cancel the in-flight run WITHOUT waiting for its worker to actually exit --
      // exactly what process shutdown (drainAndShutdown -> abortStorageCleanupPolicyJob)
      // does, and what a test/reset call can do too.
      abortStorageCleanupPolicyJob();
      expect(getStorageCleanupPolicyJobState().status).toBe("idle");

      // Run B starts immediately, before run A's cancelled worker has actually terminated,
      // and freshly reacquires the slot for its own, independent, still-in-flight work.
      const second = requestStorageCleanupPolicyRun({ reason: "manual" });
      expect(second.accepted).toBe(true);
      expect(getStorageCleanupPolicyJobState().status).toBe("running");
      expect(getActiveStorageMutation()?.kind).toBe("policy");

      // Sample continuously while run B is "running". The violation, once it happens,
      // persists until run B's own completion (nothing re-acquires the slot in between),
      // so any sampled null during the running window proves it -- no precise timing needed.
      const sampleDeadline = Date.now() + blockMs * 4;
      while (Date.now() < sampleDeadline) {
        const running = getStorageCleanupPolicyJobState().status === "running";
        if (!running) break;
        stillRunningAtSampleTime = true;
        if (getActiveStorageMutation() === null) {
          slotWentMissingWhileRunning = true;
          // Impact: with the slot wrongly free, a wholly different mutation (e.g. manual
          // cleanup) can start concurrently with run B's still-in-flight worker -- the
          // exact hazard the single-flight gate exists to prevent.
          const intruder = tryBeginStorageMutation("cleanup");
          if (intruder.acquired) {
            intruderAcquiredWhileRunning = true;
            endStorageMutation();
          }
          break;
        }
        await Bun.sleep(10);
      }
    } finally {
      // Always let the worker finish naturally before the test returns -- a cancelled
      // Bun Worker mid-synchronous-sleep is not observed to be interruptible, so racing
      // teardown against it just relocates the wait into afterEach.
      await waitUntilIdle(blockMs * 6 + 5_000);
    }

    expect(stillRunningAtSampleTime).toBe(true);
    // THE DEFECT: run B's slot must never go missing while run B itself is still running,
    // and nothing else must be able to acquire the shared slot while it is running either.
    expect(slotWentMissingWhileRunning).toBe(false);
    expect(intruderAcquiredWhileRunning).toBe(false);
    expect(getStorageCleanupPolicyJobState().status).toBe("idle");
  }, { timeout: 30_000 });
});
