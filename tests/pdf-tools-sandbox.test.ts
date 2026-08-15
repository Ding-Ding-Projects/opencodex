import { describe, expect, test } from "bun:test";
import { runPdfOperationSandboxed } from "../src/lib/pdf-tools/sandbox";
import { makePdf } from "./helpers/pdf-fixtures";

// Real `node:worker_threads` round-trips, deliberately kept few and slower
// than the rest of the suite — `pdf-tools-operations.test.ts` and
// `pdf-tools-service.test.ts` already exercise every operation's logic
// in-process via the same `runPdfOperation` dispatch the worker calls. What
// only these tests can prove is the sandbox mechanics themselves: a real
// operation surviving structured clone through a worker, a timeout actually
// terminating it, and cancellation actually cancelling it.
describe("pdf-tools sandbox (real worker_threads)", () => {
  test("runs a real operation inside the worker and returns its result", async () => {
    const bytes = await makePdf([[200, 300], [100, 150]], { title: "sandboxed" });
    const result = await runPdfOperationSandboxed({ op: "inspect", source: bytes });
    expect(result.ok).toBe(true);
    if (result.ok && result.op === "inspect") {
      expect(result.result.capabilities.pageCount).toBe(2);
      expect(result.result.metadata?.title).toBe("sandboxed");
    }
  }, 15_000);

  test("a boundary from inside the worker still reaches the caller", async () => {
    const result = await runPdfOperationSandboxed({
      op: "extract",
      source: await makePdf([[1, 1]]),
      pages: [5],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/out of range/);
  }, 15_000);

  test("an unreasonably short timeout terminates the worker rather than hanging", async () => {
    const result = await runPdfOperationSandboxed(
      { op: "inspect", source: await makePdf([[1, 1]]) },
      { timeoutMs: 1 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/time budget/);
  }, 15_000);

  test("aborting the signal cancels the in-flight worker", async () => {
    const controller = new AbortController();
    const promise = runPdfOperationSandboxed(
      { op: "inspect", source: await makePdf([[1, 1]]) },
      { signal: controller.signal },
    );
    controller.abort();
    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/cancelled/);
  }, 15_000);
});
