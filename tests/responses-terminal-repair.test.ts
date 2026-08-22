import { describe, expect, test } from "bun:test";
import { relayResponsesSseWithTerminalRepair, type ResponsesTerminalRepairScheduler } from "../src/server/responses-terminal-repair";

class Scheduler implements ResponsesTerminalRepairScheduler {
  now = 0;
  jobs: Array<{ at: number; callback: () => void }> = [];
  nowMs(): number { return this.now; }
  schedule(callback: () => void, delayMs: number): unknown {
    const job = { at: this.now + delayMs, callback };
    this.jobs.push(job);
    return job;
  }
  cancel(handle: unknown): void { this.jobs = this.jobs.filter(job => job !== handle); }
  advance(ms: number): void {
    this.now += ms;
    const due = this.jobs.filter(job => job.at <= this.now);
    this.jobs = this.jobs.filter(job => job.at > this.now);
    for (const job of due) job.callback();
  }
}

function frame(event: Record<string, unknown>): string {
  return `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`;
}

function controlled(): { stream: ReadableStream<Uint8Array>; push(value: string): void; close(): void } {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  return {
    stream: new ReadableStream<Uint8Array>({ start(next) { controller = next; } }),
    push(value) { controller?.enqueue(new TextEncoder().encode(value)); },
    close() { try { controller?.close(); } catch { /* already closed */ } },
  };
}

async function readAll(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const result = await reader.read();
    if (result.done) return out;
    out += decoder.decode(result.value, { stream: true });
  }
}

describe("custom Responses terminal repair", () => {
  test("repairs a complete graph but preserves the real function call", async () => {
    const source = controlled();
    const upstream = new AbortController();
    const scheduler = new Scheduler();
    const repaired = relayResponsesSseWithTerminalRepair(source.stream, upstream, { graceMs: 10 }, scheduler);
    const reader = repaired.getReader();
    source.push([
      frame({ type: "response.created", response: { id: "resp_1", object: "response", status: "in_progress", output: [] }, sequence_number: 0 }),
      frame({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "probe", status: "in_progress", arguments: "" }, sequence_number: 1 }),
      frame({ type: "response.function_call_arguments.done", output_index: 0, item_id: "fc_1", arguments: "{\"ok\":true}", sequence_number: 2 }),
      frame({ type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "probe", status: "completed", arguments: "{\"ok\":true}" }, sequence_number: 3 }),
    ].join(""));
    await Bun.sleep(0);
    scheduler.advance(10);
    const text = await readAll(reader);
    expect(text).toContain("response.completed");
    expect(text).toContain('"call_id":"call_1"');
    expect(text).not.toContain("response.incomplete");
    expect(upstream.signal.aborted).toBe(true);
  });

  test("fails closed on a partial/open tool graph", async () => {
    const source = controlled();
    const upstream = new AbortController();
    const repaired = relayResponsesSseWithTerminalRepair(source.stream, upstream, { graceMs: 1 }, new Scheduler());
    const reader = repaired.getReader();
    source.push([
      frame({ type: "response.created", response: { id: "resp_2", object: "response", status: "in_progress", output: [] }, sequence_number: 0 }),
      frame({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_2", call_id: "call_2", name: "probe", status: "in_progress", arguments: "" }, sequence_number: 1 }),
      frame({ type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_2", delta: "{", sequence_number: 2 }),
    ].join(""));
    source.close();
    const text = await readAll(reader);
    expect(text).toContain("response.incomplete");
    expect(text).not.toContain("response.completed");
  });

  test("does not duplicate a real terminal", async () => {
    const source = controlled();
    const upstream = new AbortController();
    const repaired = relayResponsesSseWithTerminalRepair(source.stream, upstream, { graceMs: 1 }, new Scheduler());
    const reader = repaired.getReader();
    source.push(frame({ type: "response.completed", response: { id: "resp_3", status: "completed", output: [] }, sequence_number: 0 }));
    source.close();
    const text = await readAll(reader);
    expect(text.match(/event: response\.completed/g)?.length).toBe(1);
    expect(text).not.toContain("response.incomplete");
  });

  test("cancellation aborts upstream and clears an armed timer", async () => {
    const source = controlled();
    const upstream = new AbortController();
    const scheduler = new Scheduler();
    const repaired = relayResponsesSseWithTerminalRepair(source.stream, upstream, { graceMs: 10_000 }, scheduler);
    const reader = repaired.getReader();
    source.push([
      frame({ type: "response.created", response: { id: "resp_cancel", status: "in_progress", output: [] }, sequence_number: 0 }),
      frame({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_cancel", role: "assistant", status: "in_progress", content: [] }, sequence_number: 1 }),
      frame({ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_cancel", role: "assistant", status: "completed", content: [{ type: "output_text", text: "hello" }] }, sequence_number: 2 }),
    ].join(""));
    await Bun.sleep(0);
    expect(scheduler.jobs).toHaveLength(1);
    await reader.cancel("caller cancelled");
    expect(upstream.signal.aborted).toBe(true);
    expect(scheduler.jobs).toHaveLength(0);
  });

  test.each(["response.failed", "response.incomplete"] as const)("passes through a real %s and cancels the repair timer", async (terminalType) => {
    const source = controlled();
    const upstream = new AbortController();
    const scheduler = new Scheduler();
    const repaired = relayResponsesSseWithTerminalRepair(source.stream, upstream, { graceMs: 10_000 }, scheduler);
    const reader = repaired.getReader();
    source.push([
      frame({ type: "response.created", response: { id: `resp_${terminalType}`, status: "in_progress", output: [] }, sequence_number: 0 }),
      frame({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_real", role: "assistant", status: "in_progress", content: [] }, sequence_number: 1 }),
      frame({ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_real", role: "assistant", status: "completed", content: [{ type: "output_text", text: "hello" }] }, sequence_number: 2 }),
      frame({ type: terminalType, response: { id: `resp_${terminalType}`, status: terminalType.slice("response.".length), output: [] }, sequence_number: 3 }),
    ].join(""));
    source.close();
    const text = await readAll(reader);
    expect(text.match(new RegExp(`event: ${terminalType}`, "g"))?.length).toBe(1);
    expect(text).not.toContain("response.completed");
    expect(scheduler.jobs).toHaveLength(0);
  });

  test.each([
    "malformed-json",
    "duplicate-added",
    "unknown-output-index",
    "oversized-frame",
  ] as const)("fails closed for bounded %s graph corruption", async (kind) => {
    const source = controlled();
    const upstream = new AbortController();
    const scheduler = new Scheduler();
    const repaired = relayResponsesSseWithTerminalRepair(source.stream, upstream, { graceMs: 1 }, scheduler);
    const reader = repaired.getReader();
    const base = [
      frame({ type: "response.created", response: { id: `resp_${kind}`, status: "in_progress", output: [] }, sequence_number: 0 }),
      frame({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_bad", role: "assistant", status: "in_progress", content: [] }, sequence_number: 1 }),
    ].join("");
    source.push(base);
    if (kind === "malformed-json") source.push("event: response.output_item.done\ndata: {not-json}\n\n");
    else if (kind === "duplicate-added") source.push(frame({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_bad", role: "assistant", status: "in_progress", content: [] }, sequence_number: 2 }));
    else if (kind === "unknown-output-index") source.push(frame({ type: "response.output_item.done", output_index: 9, item: { type: "message", id: "msg_bad", role: "assistant", status: "completed", content: [] }, sequence_number: 2 }));
    else source.push(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", output_index: 0, delta: "x".repeat(1_100_000) })}\n\n`);
    source.close();
    const text = await readAll(reader);
    expect(text).toContain("response.incomplete");
    expect(text).not.toContain("response.completed");
    expect(scheduler.jobs).toHaveLength(0);
  });
});
