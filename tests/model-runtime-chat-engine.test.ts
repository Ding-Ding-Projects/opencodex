import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OllamaChatOutcome, StreamOllamaChatOptions } from "../src/lib/model-runtime/chat-client";
import {
  createChatSession,
  deleteChatSession,
  getChatSession,
  listChatSessions,
  regenerateLastTurn,
  resetChatEngineForTests,
  setChatExecutorForTests,
  setChatShowFetcherForTests,
  startChatTurn,
  stopChatTurn,
  updateChatSession,
} from "../src/lib/model-runtime/chat-engine";
import { setChatStorePathForTests } from "../src/lib/model-runtime/chat-store";
import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_ATTACHMENT_BYTES, MAX_CONCURRENT_CHAT_TURNS, MAX_USER_MESSAGE_BYTES } from "../src/lib/model-runtime/chat-types";
import type { OllamaShowInfo } from "../src/lib/model-runtime/types";

let dir: string;
const BASE_URL = "http://127.0.0.1:11434";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ocx-chat-engine-test-"));
  setChatStorePathForTests(join(dir, "chat-sessions.json"));
  resetChatEngineForTests();
});

afterEach(() => {
  setChatStorePathForTests(null);
  resetChatEngineForTests();
  rmSync(dir, { recursive: true, force: true });
});

function showOk(capabilities: string[] | null): OllamaShowInfo {
  return { ok: true, error: null, capabilities, parameterCount: null, contextLength: null, quantizationLevel: null, family: null, families: null, license: null };
}

/** Drives a fake `streamOllamaChat` that emits a fixed sequence of content chunks, then resolves `done:true`. */
function fakeStreamer(chunks: string[], finalOutcome: OllamaChatOutcome = { ok: true, stats: null }) {
  return async (_baseUrl: string, _model: string, _messages: unknown, _options: unknown, opts: StreamOllamaChatOptions = {}) => {
    for (const chunk of chunks) {
      if (opts.signal?.aborted) return { ok: false, failure: { kind: "aborted" } } as OllamaChatOutcome;
      opts.onToken?.({ content: chunk, done: false, stats: null });
    }
    opts.onToken?.({ content: "", done: true, stats: null });
    return finalOutcome;
  };
}

async function drainStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

describe("session CRUD", () => {
  test("createChatSession requires a model", () => {
    const result = createChatSession({ model: "" });
    expect(result.ok).toBe(false);
  });

  test("a created session is immediately listed and retrievable", () => {
    const created = createChatSession({ model: "llama3.2:3b", title: "My chat" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const listed = listChatSessions();
    expect(listed.map(s => s.id)).toContain(created.session.id);
    expect(getChatSession(created.session.id)?.title).toBe("My chat");
  });

  test("updateChatSession changes title/model/systemPrompt/parameters and clamps out-of-range values", () => {
    const created = createChatSession({ model: "llama3.2:3b" });
    if (!created.ok) throw new Error("setup failed");
    const updated = updateChatSession(created.session.id, { title: "New title", systemPrompt: "Be terse.", parameters: { temperature: 99 } });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.session.title).toBe("New title");
    expect(updated.session.systemPrompt).toBe("Be terse.");
    expect(updated.session.parameters.temperature).toBeLessThanOrEqual(2);
  });

  test("updateChatSession on an unknown id fails honestly", () => {
    expect(updateChatSession("no-such-id", { title: "x" }).ok).toBe(false);
  });

  test("deleteChatSession removes it, and it is gone from both getChatSession and the list", () => {
    const created = createChatSession({ model: "llama3.2:3b" });
    if (!created.ok) throw new Error("setup failed");
    const deleted = deleteChatSession(created.session.id);
    expect(deleted.ok).toBe(true);
    expect(getChatSession(created.session.id)).toBeNull();
    expect(listChatSessions().map(s => s.id)).not.toContain(created.session.id);
  });

  test("deleteChatSession on an unknown id fails honestly rather than pretending success", () => {
    expect(deleteChatSession("ghost").ok).toBe(false);
  });
});

describe("startChatTurn — real, token-by-token streaming", () => {
  test("streams every token to the returned ReadableStream and persists the accumulated content", async () => {
    setChatExecutorForTests(fakeStreamer(["Hel", "lo", "!"]));
    const created = createChatSession({ model: "llama3.2:3b" });
    if (!created.ok) throw new Error("setup failed");

    const result = await startChatTurn(BASE_URL, created.session.id, { content: "hi" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const streamed = await drainStream(result.stream);
    const lines = streamed.trim().split("\n").map(l => JSON.parse(l) as { content: string; done: boolean; state?: string });
    expect(lines.filter(l => !l.done).map(l => l.content).join("")).toBe("Hello!");
    expect(lines[lines.length - 1].done).toBe(true);
    expect(lines[lines.length - 1].state).toBe("done");

    const session = getChatSession(created.session.id);
    expect(session?.messages).toHaveLength(2);
    expect(session?.messages[0].role).toBe("user");
    expect(session?.messages[0].content).toBe("hi");
    expect(session?.messages[1].role).toBe("assistant");
    expect(session?.messages[1].content).toBe("Hello!");
    expect(session?.messages[1].state).toBe("done");
    expect(session?.streamingMessageId).toBeNull();
  });

  test("rejects empty content", async () => {
    const created = createChatSession({ model: "llama3.2:3b" });
    if (!created.ok) throw new Error("setup failed");
    const result = await startChatTurn(BASE_URL, created.session.id, { content: "   " });
    expect(result.ok).toBe(false);
  });

  test("rejects a message over the byte limit", async () => {
    const created = createChatSession({ model: "llama3.2:3b" });
    if (!created.ok) throw new Error("setup failed");
    const result = await startChatTurn(BASE_URL, created.session.id, { content: "x".repeat(MAX_USER_MESSAGE_BYTES + 1) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
  });

  test("refuses a second turn while one is already streaming for the same session", async () => {
    let releaseFirst: (() => void) | null = null;
    setChatExecutorForTests(async (_b, _m, _msgs, _o, opts) => {
      await new Promise<void>(resolve => { releaseFirst = resolve; });
      opts.onToken?.({ content: "", done: true, stats: null });
      return { ok: true, stats: null };
    });
    const created = createChatSession({ model: "llama3.2:3b" });
    if (!created.ok) throw new Error("setup failed");

    const first = startChatTurn(BASE_URL, created.session.id, { content: "one" });
    // Give the stream's start() a tick to register the session as streaming.
    await new Promise(r => setTimeout(r, 10));
    const second = await startChatTurn(BASE_URL, created.session.id, { content: "two" });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.status).toBe(409);

    releaseFirst?.();
    const firstResult = await first;
    if (firstResult.ok) await drainStream(firstResult.stream);
  });

  test("unknown session id is a 404", async () => {
    const result = await startChatTurn(BASE_URL, "ghost", { content: "hi" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(404);
  });
});

describe("attachments — capability-gated, fails closed", () => {
  test("attachments to a model whose capabilities are unknown are refused, never silently sent", async () => {
    setChatShowFetcherForTests(async () => ({ ok: false, error: "boom", capabilities: null, parameterCount: null, contextLength: null, quantizationLevel: null, family: null, families: null, license: null }));
    const created = createChatSession({ model: "some-model" });
    if (!created.ok) throw new Error("setup failed");
    const result = await startChatTurn(BASE_URL, created.session.id, {
      content: "look at this",
      attachments: [{ name: "a.png", mimeType: "image/png", dataBase64: "AAAA" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("does not support image attachments");
  });

  test("attachments to a verified non-vision model are refused", async () => {
    setChatShowFetcherForTests(async () => showOk(["completion"]));
    const created = createChatSession({ model: "text-only" });
    if (!created.ok) throw new Error("setup failed");
    const result = await startChatTurn(BASE_URL, created.session.id, {
      content: "look at this",
      attachments: [{ name: "a.png", mimeType: "image/png", dataBase64: "AAAA" }],
    });
    expect(result.ok).toBe(false);
  });

  test("attachments to a verified vision-capable model are accepted", async () => {
    setChatShowFetcherForTests(async () => showOk(["completion", "vision"]));
    setChatExecutorForTests(fakeStreamer(["ok"]));
    const created = createChatSession({ model: "vision-model" });
    if (!created.ok) throw new Error("setup failed");
    const result = await startChatTurn(BASE_URL, created.session.id, {
      content: "look at this",
      attachments: [{ name: "a.png", mimeType: "image/png", dataBase64: "AAAA" }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) await drainStream(result.stream);
    expect(getChatSession(created.session.id)?.messages[0].attachments).toHaveLength(1);
  });

  test("an unsupported mime type is refused", async () => {
    const created = createChatSession({ model: "vision-model" });
    if (!created.ok) throw new Error("setup failed");
    const result = await startChatTurn(BASE_URL, created.session.id, {
      content: "hi",
      attachments: [{ name: "a.svg", mimeType: "image/svg+xml", dataBase64: "AAAA" }],
    });
    expect(result.ok).toBe(false);
  });

  test("more than the per-message attachment limit is refused", async () => {
    const created = createChatSession({ model: "vision-model" });
    if (!created.ok) throw new Error("setup failed");
    const attachments = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 1 }, (_, i) => ({ name: `a${i}.png`, mimeType: "image/png", dataBase64: "AAAA" }));
    const result = await startChatTurn(BASE_URL, created.session.id, { content: "hi", attachments });
    expect(result.ok).toBe(false);
  });

  test("an attachment over the per-file byte limit is refused", async () => {
    const created = createChatSession({ model: "vision-model" });
    if (!created.ok) throw new Error("setup failed");
    // base64 length ~4/3 of decoded bytes; comfortably over the limit.
    const huge = "A".repeat(Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + 100);
    const result = await startChatTurn(BASE_URL, created.session.id, { content: "hi", attachments: [{ name: "big.png", mimeType: "image/png", dataBase64: huge }] });
    expect(result.ok).toBe(false);
  });
});

describe("stop — the documented cancel action actually aborts the request", () => {
  test("stopChatTurn aborts the in-flight generation, and the partial content already streamed is kept", async () => {
    let sawAbort = false;
    setChatExecutorForTests(async (_b, _m, _msgs, _o, opts) => {
      opts.onToken?.({ content: "partial", done: false, stats: null });
      await new Promise<void>(resolve => {
        opts.signal?.addEventListener("abort", () => { sawAbort = true; resolve(); });
      });
      return { ok: false, failure: { kind: "aborted" } };
    });
    const created = createChatSession({ model: "llama3.2:3b" });
    if (!created.ok) throw new Error("setup failed");

    const result = await startChatTurn(BASE_URL, created.session.id, { content: "hi" });
    if (!result.ok) throw new Error("start failed");
    const drainPromise = drainStream(result.stream);
    await new Promise(r => setTimeout(r, 10));

    const stopped = stopChatTurn(created.session.id);
    expect(stopped.ok).toBe(true);
    await drainPromise;

    expect(sawAbort).toBe(true);
    const session = getChatSession(created.session.id);
    expect(session?.messages[1].content).toBe("partial");
    expect(session?.messages[1].state).toBe("stopped");
    expect(session?.streamingMessageId).toBeNull();
  });

  test("stopping a session with nothing streaming is a harmless no-op, not an error", () => {
    const created = createChatSession({ model: "llama3.2:3b" });
    if (!created.ok) throw new Error("setup failed");
    expect(stopChatTurn(created.session.id).ok).toBe(true);
  });

  test("stopping an unknown session id fails honestly", () => {
    expect(stopChatTurn("ghost").ok).toBe(false);
  });
});

describe("regenerate — replaces the last reply, never appends a second one", () => {
  test("drops the last finished assistant message and streams a fresh one in its place", async () => {
    setChatExecutorForTests(fakeStreamer(["first answer"]));
    const created = createChatSession({ model: "llama3.2:3b" });
    if (!created.ok) throw new Error("setup failed");
    const first = await startChatTurn(BASE_URL, created.session.id, { content: "hi" });
    if (!first.ok) throw new Error("first turn failed");
    await drainStream(first.stream);

    expect(getChatSession(created.session.id)?.messages).toHaveLength(2);

    setChatExecutorForTests(fakeStreamer(["second answer"]));
    const regen = regenerateLastTurn(BASE_URL, created.session.id);
    expect(regen.ok).toBe(true);
    if (!regen.ok) return;
    await drainStream(regen.stream);

    const session = getChatSession(created.session.id);
    expect(session?.messages).toHaveLength(2); // still one user + one assistant, not three
    expect(session?.messages[1].content).toBe("second answer");
  });

  test("refuses to regenerate when the last message is not a finished assistant reply", () => {
    const created = createChatSession({ model: "llama3.2:3b" });
    if (!created.ok) throw new Error("setup failed");
    const result = regenerateLastTurn(BASE_URL, created.session.id);
    expect(result.ok).toBe(false); // no messages at all yet
  });
});

describe("concurrency bound", () => {
  test("at most MAX_CONCURRENT_CHAT_TURNS sessions may stream at once", async () => {
    let releases: (() => void)[] = [];
    setChatExecutorForTests(async (_b, _m, _msgs, _o, opts) => {
      await new Promise<void>(resolve => { releases.push(resolve); });
      opts.onToken?.({ content: "", done: true, stats: null });
      return { ok: true, stats: null };
    });

    const sessions = await Promise.all(
      Array.from({ length: MAX_CONCURRENT_CHAT_TURNS + 1 }, () => createChatSession({ model: "llama3.2:3b" })),
    );

    const started = [];
    for (const s of sessions) {
      if (!s.ok) throw new Error("setup failed");
      started.push(await startChatTurn(BASE_URL, s.session.id, { content: "hi" }));
      await new Promise(r => setTimeout(r, 5));
    }

    const failures = started.filter(r => !r.ok);
    expect(failures.length).toBeGreaterThanOrEqual(1);
    for (const f of failures) if (!f.ok) expect(f.status).toBe(429);

    for (const release of releases) release();
    for (const r of started) if (r.ok) await drainStream(r.stream);
  });
});
