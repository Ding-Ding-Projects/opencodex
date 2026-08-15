import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { pullOllamaModel } from "../src/lib/model-runtime/pull-client";

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
      // Split into a couple of chunks so the reader's own buffering is exercised, not just a single read().
      const bytes = encoder.encode(body);
      const mid = Math.floor(bytes.length / 2);
      controller.enqueue(bytes.slice(0, mid));
      controller.enqueue(bytes.slice(mid));
      controller.close();
    },
  });
  return new Response(stream, { status: opts.status ?? 200 });
}

describe("pullOllamaModel", () => {
  test("streams progress lines in order and resolves ok on an explicit success line", async () => {
    const seen: unknown[] = [];
    globalThis.fetch = (async () => ndjsonResponse([
      { status: "pulling manifest" },
      { status: "downloading sha256:abc", digest: "sha256:abc", total: 1000, completed: 400 },
      { status: "downloading sha256:abc", digest: "sha256:abc", total: 1000, completed: 1000 },
      { status: "verifying sha256 digest" },
      { status: "success" },
    ])) as typeof fetch;

    const outcome = await pullOllamaModel("http://127.0.0.1:11434", "llama3.1:8b", {
      onLine: line => seen.push(line.status),
    });
    expect(outcome.ok).toBe(true);
    expect(seen).toEqual([
      "pulling manifest",
      "downloading sha256:abc",
      "downloading sha256:abc",
      "verifying sha256 digest",
      "success",
    ]);
  });

  test("a reported {\"error\":...} line fails the pull with that exact message", async () => {
    globalThis.fetch = (async () => ndjsonResponse([
      { status: "pulling manifest" },
      { error: "model \"ghost:1b\" not found, try pulling it first" },
    ])) as typeof fetch;
    const outcome = await pullOllamaModel("http://127.0.0.1:11434", "ghost:1b");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("reported-error");
    if (outcome.failure.kind !== "reported-error") return;
    expect(outcome.failure.error).toContain("not found");
  });

  test("a stream that ends with neither success nor error is a failure, never assumed successful", async () => {
    globalThis.fetch = (async () => ndjsonResponse([{ status: "pulling manifest" }, { status: "downloading" }])) as typeof fetch;
    const outcome = await pullOllamaModel("http://127.0.0.1:11434", "llama3.1:8b");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("stream-error");
  });

  test("a non-2xx HTTP response fails without reading a body as a stream", async () => {
    globalThis.fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;
    const outcome = await pullOllamaModel("http://127.0.0.1:11434", "ghost:1b");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("http");
  });

  test("a redirect is refused rather than followed", async () => {
    globalThis.fetch = (async () => new Response(null, { status: 302, headers: { Location: "http://169.254.169.254/" } })) as typeof fetch;
    const outcome = await pullOllamaModel("http://127.0.0.1:11434", "llama3.1:8b");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("http");
  });

  test("connection refused is reported distinctly", async () => {
    globalThis.fetch = (async () => { throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }); }) as typeof fetch;
    const outcome = await pullOllamaModel("http://127.0.0.1:11434", "llama3.1:8b");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("refused");
  });

  test("aborting the caller's own signal is reported as 'aborted', not a generic network failure", async () => {
    globalThis.fetch = (async (_input, init) => {
      const signal = (init as RequestInit | undefined)?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" })));
      });
    }) as typeof fetch;

    const controller = new AbortController();
    const outcomePromise = pullOllamaModel("http://127.0.0.1:11434", "llama3.1:8b", { signal: controller.signal });
    controller.abort();
    const outcome = await outcomePromise;
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("aborted");
  });

  test("one malformed line does not abandon an otherwise-good stream", async () => {
    const encoder = new TextEncoder();
    const raw = 'not json at all\n' + JSON.stringify({ status: "success" }) + "\n";
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode(raw)); controller.close(); },
    });
    globalThis.fetch = (async () => new Response(stream, { status: 200 })) as typeof fetch;
    const outcome = await pullOllamaModel("http://127.0.0.1:11434", "llama3.1:8b");
    expect(outcome.ok).toBe(true);
  });

  test("an oversized single status line fails the pull rather than buffering it whole", async () => {
    const encoder = new TextEncoder();
    const huge = JSON.stringify({ status: "x".repeat(200_000) }) + "\n";
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode(huge)); controller.close(); },
    });
    globalThis.fetch = (async () => new Response(stream, { status: 200 })) as typeof fetch;
    const outcome = await pullOllamaModel("http://127.0.0.1:11434", "llama3.1:8b");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("stream-error");
  });

  test("a response with no body at all fails cleanly", async () => {
    globalThis.fetch = (async () => ndjsonResponse([], { noBody: true })) as typeof fetch;
    const outcome = await pullOllamaModel("http://127.0.0.1:11434", "llama3.1:8b");
    expect(outcome.ok).toBe(false);
  });
});
