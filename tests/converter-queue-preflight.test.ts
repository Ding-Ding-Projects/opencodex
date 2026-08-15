/**
 * `src/lib/converter/queue-preflight.ts` — the storage-capacity estimate the
 * queue's `enqueueConvertJobs` refuses a batch on before admitting it. The
 * disk probe itself is injected here (a fake, deterministic function) so
 * these tests never touch the real filesystem's free space — see
 * `converter-queue-engine.test.ts` for the engine wiring this into a real
 * enqueue refusal.
 */
import { describe, expect, test } from "bun:test";
import { buildConvertQueuePreflight, ESTIMATED_OUTPUT_HEADROOM_FACTOR } from "../src/lib/converter/queue-preflight";

describe("buildConvertQueuePreflight", () => {
  test("estimates each item's output as sourceBytes × the documented headroom factor", async () => {
    const preflight = await buildConvertQueuePreflight(
      [{ destPath: "C:\\out\\a.csv", sourceBytes: 1000 }],
      async () => 1_000_000_000,
    );
    expect(preflight.items[0].estimatedOutputBytes).toBe(1000 * ESTIMATED_OUTPUT_HEADROOM_FACTOR);
    expect(preflight.aggregateEstimatedBytes).toBe(1000 * ESTIMATED_OUTPUT_HEADROOM_FACTOR);
    expect(preflight.aggregateSizeFullyKnown).toBe(true);
  });

  test("an item with an unknown source size contributes null and marks the aggregate partial", async () => {
    const preflight = await buildConvertQueuePreflight(
      [{ destPath: "C:\\out\\a.csv", sourceBytes: 1000 }, { destPath: "C:\\out\\b.csv", sourceBytes: null }],
      async () => 1_000_000_000,
    );
    expect(preflight.items[1].estimatedOutputBytes).toBeNull();
    expect(preflight.aggregateSizeFullyKnown).toBe(false);
    // The unknown item contributes 0, never a guess, to the aggregate.
    expect(preflight.aggregateEstimatedBytes).toBe(1000 * ESTIMATED_OUTPUT_HEADROOM_FACTOR);
  });

  test("groups items by destination directory and probes each directory once", async () => {
    const probed: string[] = [];
    const preflight = await buildConvertQueuePreflight(
      [
        { destPath: "C:\\out\\a.csv", sourceBytes: 100 },
        { destPath: "C:\\out\\b.csv", sourceBytes: 200 },
        { destPath: "C:\\elsewhere\\c.csv", sourceBytes: 300 },
      ],
      async path => { probed.push(path); return 1_000_000_000; },
    );
    expect(probed.sort()).toEqual(["C:\\elsewhere", "C:\\out"]);
    const outGroup = preflight.groups.find(g => g.directory === "C:\\out")!;
    expect(outGroup.estimatedBytesNeeded).toBe((100 + 200) * ESTIMATED_OUTPUT_HEADROOM_FACTOR);
  });

  test("a definite reading below the estimate marks the group insufficient and the whole preflight insufficient", async () => {
    const preflight = await buildConvertQueuePreflight(
      [{ destPath: "C:\\out\\a.csv", sourceBytes: 1_000_000 }],
      async () => 1, // basically no free space
    );
    expect(preflight.groups[0].sufficient).toBe(false);
    expect(preflight.insufficientDiskSpace).toBe(true);
  });

  test("a definite reading at or above the estimate marks the group sufficient", async () => {
    const preflight = await buildConvertQueuePreflight(
      [{ destPath: "C:\\out\\a.csv", sourceBytes: 100 }],
      async () => 100 * ESTIMATED_OUTPUT_HEADROOM_FACTOR, // exactly enough
    );
    expect(preflight.groups[0].sufficient).toBe(true);
    expect(preflight.insufficientDiskSpace).toBe(false);
  });

  test("an unknown (null) disk reading is never treated as insufficient — an unknown fact never fails a preflight closed", async () => {
    const preflight = await buildConvertQueuePreflight(
      [{ destPath: "C:\\out\\a.csv", sourceBytes: 1_000_000_000 }],
      async () => null,
    );
    expect(preflight.groups[0].sufficient).toBeNull();
    expect(preflight.insufficientDiskSpace).toBe(false);
  });

  test("a probe that throws degrades to an unknown reading rather than crashing the preflight", async () => {
    const preflight = await buildConvertQueuePreflight(
      [{ destPath: "C:\\out\\a.csv", sourceBytes: 100 }],
      async () => { throw new Error("boom"); },
    );
    expect(preflight.groups[0].freeDiskBytes).toBeNull();
    expect(preflight.groups[0].sufficient).toBeNull();
    expect(preflight.insufficientDiskSpace).toBe(false);
  });

  test("the disclosure names the exact headroom factor", async () => {
    const preflight = await buildConvertQueuePreflight([{ destPath: "C:\\out\\a.csv", sourceBytes: 1 }], async () => 1000);
    expect(preflight.disclosure).toContain(`× ${ESTIMATED_OUTPUT_HEADROOM_FACTOR}`);
  });
});
