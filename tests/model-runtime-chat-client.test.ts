import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chatParametersToApiOptions, streamOllamaChat } from "../src/lib/model-runtime/chat-client";
import { DEFAULT_CHAT_PARAMETERS } from "../src/lib/model-runtime/chat-types";

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function ndjsonResponse(lines: unknown[], opts: { status?: number; noBody?: boolean } = {}): Response {
  if (opts.noBody) return new Response(null, { status: opts.status ?? 200 });
  const encoder = new TextEncoder();
  const body = lines.map(l => JSON.stringify(l)).join("\n") + "\n";
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const bytes = encoder.encode(body);
      const mid = Math.floor(bytes.length / 2);
      controller.enqueue(bytes.slice(0, mid));
      controller.enqueue(bytes.slice(mid));
      controller.close();
    },
  });
  return new Response(stream, { status: opts.status ?? 200 });
}

const OPTIONS = chatParametersToApiOptions(DEFAULT_CHAT_PARAMETERS);

describe("chatParametersToApiOptions", () => {
  test("maps camelCase fields to Ollama's documented snake_case options", () => {
    const options = chatParametersToApiOptions({ temperature: 0.5, topP: 0.8, topK: 20, numCtx: 8192, repeatPenalty: 1.2, seed: 42 });
    expect(options).toEqual({ temperature: 0.5, top_p: 0.8, top_k: 20, num_ctx: 8192, repeat_penalty: 1.2, seed: 42 });
  });

  test("a null seed is omitted entirely rather than sent as null", () => {
    const options = chatParametersToApiOptions({ ...DEFAULT_CHAT_PARAMETERS, seed: null });
    expect("seed" in options).toBe(false);
  });
});

describe("streamOllamaChat", () => {
  test("streams content deltas in order and resolves ok on an explicit done:true line", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async () => ndjsonResponse([
      { message: { role: "assistant", content: "Hel" }, done: false },
      { message: { role: "assistant", content: "lo" }, done: false },
      { message: { role: "assistant", content: "" }, done: true, total_duration: 2_000_000, eval_count: 10, eval_duration: 1_000_000_000, done_reason: "stop" },
    ])) as typeof fetch;

    const outcome = await streamOllamaChat("http://127.0.0.1:11434", "llama3.2:3b", [{ role: "user", content: "hi" }], OPTIONS, {
      onToken: line => seen.push(line.content),
    });
    expect(outcome.ok).toBe(true);
    expect(seen.join("")).toBe("Hello");
    if (!outcome.ok) return;
    expect(outcome.stats?.doneReason).toBe("stop");
    expect(outcome.stats?.totalDurationMs).toBe(2); // 2_000_000 ns -> 2 ms
    expect(outcome.stats?.evalCount).toBe(10);
  });

  test("a reported {\"error\":...} line fails the turn with that exact message", async () => {
    globalThis.fetch = (async () => ndjsonResponse([{ error: "model \"ghost\" not found" }])) as typeof fetch;
    const outcome = await streamOllamaChat("http://127.0.0.1:11434", "ghost", [], OPTIONS);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("reported-error");
  });

  test("a stream that ends with no done:true line is a failure, never assumed successful", async () => {
    globalThis.fetch = (async () => ndjsonResponse([{ message: { role: "assistant", content: "partial" }, done: false }])) as typeof fetch;
    const outcome = await streamOllamaChat("http://127.0.0.1:11434", "llama3.2:3b", [], OPTIONS);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("stream-error");
  });

  test("a non-2xx HTTP response fails without reading a body as a stream", async () => {
    globalThis.fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;
    const outcome = await streamOllamaChat("http://127.0.0.1:11434", "ghost", [], OPTIONS);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("http");
  });

  test("a redirect is refused rather than followed", async () => {
    globalThis.fetch = (async () => new Response(null, { status: 302, headers: { Location: "http://169.254.169.254/" } })) as typeof fetch;
    const outcome = await streamOllamaChat("http://127.0.0.1:11434", "llama3.2:3b", [], OPTIONS);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("http");
  });

  test("connection refused is reported distinctly", async () => {
    globalThis.fetch = (async () => { throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }); }) as typeof fetch;
    const outcome = await streamOllamaChat("http://127.0.0.1:11434", "llama3.2:3b", [], OPTIONS);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("refused");
  });

  test("aborting the caller's own signal is reported as 'aborted' — the documented stop action", async () => {
    globalThis.fetch = (async (_input, init) => {
      const signal = (init as RequestInit | undefined)?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" })));
      });
    }) as typeof fetch;

    const controller = new AbortController();
    const outcomePromise = streamOllamaChat("http://127.0.0.1:11434", "llama3.2:3b", [], OPTIONS, { signal: controller.signal });
    controller.abort();
    const outcome = await outcomePromise;
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("aborted");
  });

  test("one malformed line does not abandon an otherwise-good stream", async () => {
    const encoder = new TextEncoder();
    const raw = 'not json at all\n' + JSON.stringify({ message: { role: "assistant", content: "" }, done: true }) + "\n";
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(raw)); controller.close(); } });
    globalThis.fetch = (async () => new Response(stream, { status: 200 })) as typeof fetch;
    const outcome = await streamOllamaChat("http://127.0.0.1:11434", "llama3.2:3b", [], OPTIONS);
    expect(outcome.ok).toBe(true);
  });

  test("an oversized single line fails the turn rather than buffering it whole", async () => {
    const encoder = new TextEncoder();
    const huge = JSON.stringify({ message: { role: "assistant", content: "x".repeat(400_000) }, done: false }) + "\n";
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(huge)); controller.close(); } });
    globalThis.fetch = (async () => new Response(stream, { status: 200 })) as typeof fetch;
    const outcome = await streamOllamaChat("http://127.0.0.1:11434", "llama3.2:3b", [], OPTIONS);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("stream-error");
  });

  test("a response with no body at all fails cleanly", async () => {
    globalThis.fetch = (async () => ndjsonResponse([], { noBody: true })) as typeof fetch;
    const outcome = await streamOllamaChat("http://127.0.0.1:11434", "llama3.2:3b", [], OPTIONS);
    expect(outcome.ok).toBe(false);
  });
});
