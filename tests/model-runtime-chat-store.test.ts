import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  flushChatState,
  getChatState,
  resetChatStoreForTests,
  setChatStorePathForTests,
  updateAndFlushChatState,
} from "../src/lib/model-runtime/chat-store";
import { DEFAULT_CHAT_PARAMETERS, type ChatMessage, type ChatSession } from "../src/lib/model-runtime/chat-types";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ocx-chat-store-test-"));
  path = join(dir, "chat-sessions.json");
  setChatStorePathForTests(path);
  resetChatStoreForTests();
});

afterEach(() => {
  setChatStorePathForTests(null);
  resetChatStoreForTests();
  rmSync(dir, { recursive: true, force: true });
});

function makeSession(over: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "s1",
    title: "Test session",
    model: "llama3.2:3b",
    systemPrompt: "",
    parameters: DEFAULT_CHAT_PARAMETERS,
    messages: [],
    createdAt: 1,
    updatedAt: 1,
    streamingMessageId: null,
    ...over,
  };
}

describe("getChatState / flushChatState", () => {
  test("no file yet reads as an empty state, not an error", () => {
    expect(getChatState()).toEqual({ version: 1, sessions: [] });
  });

  test("a flush writes atomically and a fresh read sees exactly what was written", () => {
    updateAndFlushChatState(s => { s.sessions.push(makeSession()); });
    resetChatStoreForTests(); // simulate a fresh process
    const state = getChatState();
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0].id).toBe("s1");
  });

  test("a corrupt file fails closed to an empty state rather than throwing", () => {
    require("node:fs").mkdirSync(dir, { recursive: true });
    require("node:fs").writeFileSync(path, "{ not json", "utf8");
    resetChatStoreForTests();
    expect(getChatState()).toEqual({ version: 1, sessions: [] });
  });

  test("an unsupported version fails closed to an empty state", () => {
    require("node:fs").mkdirSync(dir, { recursive: true });
    require("node:fs").writeFileSync(path, JSON.stringify({ version: 2, sessions: [makeSession()] }), "utf8");
    resetChatStoreForTests();
    expect(getChatState()).toEqual({ version: 1, sessions: [] });
  });

  test("a malformed individual session is dropped, not the whole file", () => {
    require("node:fs").mkdirSync(dir, { recursive: true });
    require("node:fs").writeFileSync(path, JSON.stringify({ version: 1, sessions: [makeSession({ id: "good" }), { garbage: true }, { id: "no-model-field" }] }), "utf8");
    resetChatStoreForTests();
    const state = getChatState();
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0].id).toBe("good");
  });
});

describe("streaming never survives a restart", () => {
  test("a session/message found on disk claiming 'streaming' is reconciled to 'stopped' the moment it is first read", () => {
    const streamingMessage: ChatMessage = {
      id: "m1", role: "assistant", content: "partial reply", attachments: null,
      createdAt: 1, state: "streaming", error: null, stats: null,
    };
    const session = makeSession({ messages: [streamingMessage], streamingMessageId: "m1" });
    updateAndFlushChatState(s => { s.sessions.push(session); });

    resetChatStoreForTests(); // simulate a fresh process reading the file back
    const state = getChatState();
    expect(state.sessions[0].streamingMessageId).toBeNull();
    expect(state.sessions[0].messages[0].state).toBe("stopped");
    expect(state.sessions[0].messages[0].error).toContain("restart");
    // The partial content already generated is kept, never discarded.
    expect(state.sessions[0].messages[0].content).toBe("partial reply");
  });

  test("a session already in a terminal state survives a restart completely unchanged", () => {
    const doneMessage: ChatMessage = {
      id: "m1", role: "assistant", content: "done reply", attachments: null,
      createdAt: 1, state: "done", error: null, stats: null,
    };
    updateAndFlushChatState(s => { s.sessions.push(makeSession({ messages: [doneMessage] })); });
    resetChatStoreForTests();
    const state = getChatState();
    expect(state.sessions[0].messages[0].state).toBe("done");
    expect(state.sessions[0].messages[0].content).toBe("done reply");
  });
});

describe("bounds enforced on read", () => {
  test("out-of-range parameters are clamped back into range on load", () => {
    require("node:fs").mkdirSync(dir, { recursive: true });
    require("node:fs").writeFileSync(path, JSON.stringify({
      version: 1,
      sessions: [makeSession({ parameters: { temperature: 99, topP: 0.9, topK: 40, numCtx: 4096, repeatPenalty: 1.1, seed: null } })],
    }), "utf8");
    resetChatStoreForTests();
    expect(getChatState().sessions[0].parameters.temperature).toBeLessThanOrEqual(2);
  });
});

describe("atomic write", () => {
  test("the file on disk round-trips through JSON exactly as the cache holds it", () => {
    updateAndFlushChatState(s => { s.sessions.push(makeSession({ title: "Round trip" })); });
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.sessions[0].title).toBe("Round trip");
  });

  test("flushChatState is a no-op-safe repeat call", () => {
    updateAndFlushChatState(s => { s.sessions.push(makeSession()); });
    expect(() => flushChatState()).not.toThrow();
  });
});
