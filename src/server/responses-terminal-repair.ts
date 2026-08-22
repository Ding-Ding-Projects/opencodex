import type { ResponsesTerminalRepairPolicy } from "../types";
import { nextSseBlock, sseDataPayload } from "./sse-payload-rewrite";

export interface ResponsesTerminalRepairScheduler {
  nowMs(): number;
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

const DEFAULT_SCHEDULER: ResponsesTerminalRepairScheduler = {
  nowMs: () => Date.now(),
  schedule(callback, delayMs) {
    const handle = setTimeout(callback, delayMs);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  cancel(handle) { clearTimeout(handle as ReturnType<typeof setTimeout>); },
};

const MAX_RETAINED_ITEMS = 128;
const MAX_RETAINED_BYTES = 512 * 1024;
const MAX_BUFFER_BYTES = 1_048_576;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function outputIndex(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function completeItem(item: Record<string, unknown>): boolean {
  if (item.status !== "completed" || typeof item.id !== "string" || item.id.length === 0) return false;
  if (item.type === "message") {
    return item.role === "assistant" && Array.isArray(item.content)
      && item.content.every(part => isRecord(part) && part.type === "output_text" && typeof part.text === "string");
  }
  if (item.type === "reasoning") {
    return Array.isArray(item.content)
      && item.content.every(part => isRecord(part) && part.type === "reasoning_text" && typeof part.text === "string");
  }
  if (item.type !== "function_call") return false;
  if (typeof item.call_id !== "string" || !item.call_id || typeof item.name !== "string" || !item.name) return false;
  if (typeof item.arguments !== "string") return false;
  try { return isRecord(JSON.parse(item.arguments)); } catch { return false; }
}

/**
 * Repair only a complete Responses output graph whose terminal event is missing. The wrapper
 * preserves every upstream block, treats a real terminal as authoritative, and emits only an
 * incomplete terminal when the graph is partial, malformed, cancelled, or over budget.
 */
export function relayResponsesSseWithTerminalRepair(
  body: ReadableStream<Uint8Array>,
  upstream: AbortController,
  policy: ResponsesTerminalRepairPolicy,
  scheduler: ResponsesTerminalRepairScheduler = DEFAULT_SCHEDULER,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const added = new Map<number, { type: unknown; id: unknown }>();
  const completed = new Map<number, Record<string, unknown>>();
  let created: Record<string, unknown> | null = null;
  let buffer = "";
  let terminalSeen = false;
  let tainted = false;
  let maxSequence = -1;
  let timer: unknown;
  let generation = 0;
  let disposed = false;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  let activeRead: Promise<void> | null = null;

  const cancelTimer = (): void => {
    generation += 1;
    if (timer !== undefined) scheduler.cancel(timer);
    timer = undefined;
  };
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    cancelTimer();
    added.clear();
    completed.clear();
    created = null;
    buffer = "";
    upstream.signal.removeEventListener("abort", onAbort);
  };
  const onAbort = (): void => {
    if (disposed) return;
    dispose();
    reader.cancel(upstream.signal.reason).catch(() => {});
    try { controllerRef?.close(); } catch { /* already closed */ }
  };

  const candidateComplete = (): boolean => {
    if (terminalSeen || tainted || !created || added.size === 0 || added.size !== completed.size) return false;
    for (const [index, opening] of added) {
      const item = completed.get(index);
      if (!item || opening.type !== item.type || opening.id !== item.id || !completeItem(item)) return false;
    }
    return true;
  };
  const synthetic = (kind: "completed" | "incomplete"): Uint8Array => {
    const output = [...completed.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
    const response = {
      ...(created ?? { id: `ocx_repair_${scheduler.nowMs()}`, object: "response" }),
      status: kind,
      completed_at: Math.floor(scheduler.nowMs() / 1000),
      output,
      ...(kind === "incomplete" ? { incomplete_details: { reason: "missing_terminal_event" } } : {}),
    };
    const type = `response.${kind}`;
    return encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ type, response, sequence_number: maxSequence + 1 })}\n\n`);
  };
  const emitSynthetic = (kind: "completed" | "incomplete"): void => {
    if (disposed || terminalSeen || !controllerRef) return;
    terminalSeen = true;
    cancelTimer();
    controllerRef.enqueue(synthetic(kind));
    if (!upstream.signal.aborted) upstream.abort("Responses terminal repaired");
    reader.cancel("Responses terminal repaired").catch(() => {});
    try { controllerRef.close(); } catch { /* already closed */ }
    dispose();
  };
  const arm = (): void => {
    if (!candidateComplete() || timer !== undefined) return;
    const armedGeneration = generation;
    timer = scheduler.schedule(() => {
      if (disposed || terminalSeen || armedGeneration !== generation || !candidateComplete()) return;
      emitSynthetic("completed");
    }, policy.graceMs ?? 5_000);
  };
  const inspect = (payload: string | null): "done" | "ordinary" => {
    if (payload === "[DONE]") return "done";
    if (!payload || terminalSeen) return "ordinary";
    let parsed: unknown;
    try { parsed = JSON.parse(payload); } catch { tainted = true; return "ordinary"; }
    if (!isRecord(parsed)) { tainted = true; return "ordinary"; }
    if (typeof parsed.sequence_number === "number" && Number.isInteger(parsed.sequence_number)) {
      maxSequence = Math.max(maxSequence, parsed.sequence_number);
    }
    const type = parsed.type;
    if (type === "response.completed" || type === "response.failed" || type === "response.incomplete") {
      terminalSeen = true;
      cancelTimer();
      return "ordinary";
    }
    cancelTimer();
    if (type === "response.created" && isRecord(parsed.response)) {
      const bytes = encoder.encode(JSON.stringify(parsed.response)).byteLength;
      if (bytes > MAX_RETAINED_BYTES) tainted = true;
      else created = parsed.response;
    } else if (type === "response.output_item.added") {
      const index = outputIndex(parsed.output_index);
      if (index === null || !isRecord(parsed.item) || added.has(index) || added.size >= MAX_RETAINED_ITEMS) tainted = true;
      else added.set(index, { type: parsed.item.type, id: parsed.item.id });
    } else if (type === "response.output_item.done") {
      const index = outputIndex(parsed.output_index);
      if (index === null || !isRecord(parsed.item) || !added.has(index) || completed.has(index)) tainted = true;
      else {
        const bytes = encoder.encode(JSON.stringify(parsed.item)).byteLength;
        const total = [...completed.values()].reduce((sum, item) => sum + encoder.encode(JSON.stringify(item)).byteLength, 0) + bytes;
        if (total > MAX_RETAINED_BYTES) tainted = true;
        else completed.set(index, parsed.item);
      }
    }
    arm();
    return "ordinary";
  };
  const emitBlocks = (controller: ReadableStreamDefaultController<Uint8Array>): boolean => {
    let next: ReturnType<typeof nextSseBlock>;
    while ((next = nextSseBlock(buffer))) {
      buffer = next.rest;
      const kind = inspect(sseDataPayload(next.block));
      controller.enqueue(encoder.encode(next.block + next.delimiter));
      if (kind === "done") {
        if (!terminalSeen) emitSynthetic(candidateComplete() ? "completed" : "incomplete");
        if (!disposed) { dispose(); try { controller.close(); } catch { /* already closed */ } }
        return true;
      }
    }
    return false;
  };
  const read = async (controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (disposed) return;
        if (done) {
          buffer += decoder.decode();
          if (buffer) { tainted = true; controller.enqueue(encoder.encode(buffer)); }
          if (!terminalSeen) emitSynthetic(candidateComplete() ? "completed" : "incomplete");
          if (!disposed) { dispose(); try { controller.close(); } catch { /* already closed */ } }
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        if (encoder.encode(buffer).byteLength > MAX_BUFFER_BYTES) {
          tainted = true;
          controller.enqueue(encoder.encode(buffer));
          buffer = "";
        }
        if (emitBlocks(controller)) return;
      }
    } catch (error) {
      if (!disposed) { dispose(); controller.error(error); }
    }
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      if (upstream.signal.aborted) onAbort();
      else upstream.signal.addEventListener("abort", onAbort, { once: true });
    },
    pull(controller) {
      if (disposed) return;
      if (!activeRead) activeRead = read(controller).finally(() => { activeRead = null; });
      return activeRead;
    },
    cancel(reason) { dispose(); upstream.abort(reason); return reader.cancel(reason); },
  });
}
