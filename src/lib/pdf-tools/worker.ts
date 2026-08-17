/**
 * Worker-thread entry point for PDF operations.
 *
 * Mirrors `src/storage/policy-worker.ts`: a `postMessage`/`onmessage` protocol
 * keyed by `requestId`, dispatching into the same pure function
 * (`runPdfOperation`) that the in-process test path calls directly. This file
 * carries none of the actual PDF logic — it only marshals messages — so there
 * is nothing here to drift out of sync with what the tests exercise.
 */
import { runPdfOperation } from "./operations";
import type { PdfOperationRequest } from "./types";

interface RunMessage {
  type: "run";
  requestId: string;
  request: PdfOperationRequest;
}

function isRunMessage(data: unknown): data is RunMessage {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const o = data as Record<string, unknown>;
  return o.type === "run" && typeof o.requestId === "string" && !!o.request && typeof o.request === "object";
}

declare const self: Worker;

self.onmessage = async (event: MessageEvent<unknown>) => {
  if (!isRunMessage(event.data)) return;
  const { requestId, request } = event.data;
  try {
    const result = await runPdfOperation(request);
    self.postMessage({ type: "done", requestId, result });
  } catch (err) {
    // runPdfOperation catches its own errors into a { ok: false } result, so
    // reaching here means something outside that contract broke (an OOM close
    // to the resource ceiling, a structured-clone failure). Report it rather
    // than letting the caller's timeout be the only signal.
    self.postMessage({
      type: "error",
      requestId,
      message: err instanceof Error ? err.message : "the worker failed",
    });
  }
};
