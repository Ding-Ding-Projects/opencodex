/**
 * Regression test for confirmed finding L6-02: `OllamaChat.tsx`'s `runStream`
 * applied a chat send's result with no check that the user was still looking
 * at the session the send was for.
 *
 *   async function runStream(url, init, seed, sessionId) {
 *     ...
 *     res = await fetch(url, { ...init, signal: controller.signal });
 *     ...
 *     seed(assistantId, userId);              // setActiveSession(prev => ...) — no id check
 *     ...
 *     setSending(false);
 *     abortRef.current = null;
 *     void loadSession(sessionId);            // unconditional — no id check either
 *   }
 *
 * `sessionId` is the id captured by `handleSend` at the moment Send was
 * clicked. Nothing aborts this in-flight request when the user switches to a
 * different session in the sidebar (`onClick={() => setActiveSessionId(s.id)}`
 * carries no `disabled` and no guard), and nothing in `loadSession` checked
 * whether `activeSessionId` still equalled the id it was called with. So a
 * send that was still in flight when the user navigated away completed into
 * whichever session happened to be on screen when the response landed, then
 * silently snapped the view back to the session the send was actually for —
 * the same "capability applied with no request-identity check" shape as the
 * stale-fetch-overwrites-newer-response defect class this hunt targets.
 *
 * This test gates the POST /messages fetch so it resolves only after the
 * user has already switched to a second, unrelated session, then releases it
 * and shows the visible session must not silently revert.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import OllamaChat from "../src/pages/OllamaChat";
import { TestProviders } from "./helpers/providers";
import { setInputValue } from "./helpers/dom-interact";

const globals = ["document", "window", "navigator", "localStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;
let releasePost: (() => void) | null = null;
let postGate: Promise<void> | null = null;

const PARAMS = { temperature: 0.8, topP: 0.9, topK: 40, numCtx: 4096, repeatPenalty: 1.1, seed: null };

function session(id: string, title: string) {
  return {
    id, title, model: "llama3", systemPrompt: "", parameters: PARAMS,
    messages: [], createdAt: 0, updatedAt: 0, streamingMessageId: null,
  };
}
function summary(id: string, title: string) {
  return { id, title, model: "llama3", messageCount: 0, createdAt: 0, updatedAt: 0, streaming: false, lastMessagePreview: null };
}

const SESSIONS: Record<string, ReturnType<typeof session>> = {
  "session-a": session("session-a", "Chat A"),
  "session-b": session("session-b", "Chat B"),
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function serve(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();

  if (url.includes("/api/model-runtime/catalog")) {
    return jsonResponse({ health: { state: "healthy", detail: "ok" }, catalog: { entries: [{ name: "llama3", family: null, capabilities: null, showOk: true }] } });
  }
  if (url.endsWith("/api/model-runtime/chat/sessions") && method === "GET") {
    return jsonResponse({ ok: true, sessions: [summary("session-a", "Chat A"), summary("session-b", "Chat B")] });
  }
  if (/\/api\/model-runtime\/chat\/sessions\/session-a\/messages$/.test(url) && method === "POST") {
    await postGate;
    // Headers only: `runStream` calls `seed()` the instant it has these, before
    // ever touching `res.body` — a real server would keep the body open and
    // stream NDJSON, but that is irrelevant to the two effects under test here.
    return new Response(null, {
      status: 200,
      headers: { "X-Chat-Assistant-Message-Id": "asst-1", "X-Chat-User-Message-Id": "user-1" },
    });
  }
  const m = /\/api\/model-runtime\/chat\/sessions\/([^/]+)$/.exec(url);
  if (m && method === "GET") {
    const s = SESSIONS[m[1]!];
    if (!s) throw new Error(`hunt-ollamachat-stale-send: unknown session ${m[1]}`);
    return jsonResponse({ ok: true, session: s });
  }
  throw new Error(`hunt-ollamachat-stale-send: unexpected request ${method} ${url}`);
}

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(k => [k, Reflect.get(globalThis, k)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    fetch: { configurable: true, value: serve },
  });
  Object.defineProperty(testWindow, "fetch", { configurable: true, value: serve });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  postGate = new Promise<void>(resolve => { releasePost = resolve; });
  container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(container as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  releasePost?.();
  releasePost = null;
  postGate = null;
  testWindow.close();
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
});

async function mount(): Promise<void> {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(container);
    root.render(<TestProviders><OllamaChat apiBase="" /></TestProviders>);
  });
  await act(async () => { await new Promise(r => setTimeout(r, 50)); });
}

function sessionButton(title: string): HTMLButtonElement {
  const strong = [...container.querySelectorAll("strong")].find(s => (s.textContent ?? "").trim() === title);
  if (!strong) throw new Error(`no session row titled "${title}"`);
  const btn = strong.closest("button");
  if (!btn) throw new Error(`session row "${title}" has no enclosing button`);
  return btn as HTMLButtonElement;
}

function mainPaneTitle(): string {
  const all = [...container.querySelectorAll("h2.m3-card-title")];
  return (all[all.length - 1]?.textContent ?? "").trim();
}

function buttonWithText(text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(b => (b.textContent ?? "").trim() === text);
  if (!found) throw new Error(`no button with exact text "${text}"`);
  return found;
}

async function click(el: Element): Promise<void> {
  await act(async () => { el.dispatchEvent(new testWindow.Event("click", { bubbles: true })); });
  await act(async () => { await new Promise(r => setTimeout(r, 30)); });
}

test("switching sessions during an in-flight send does not snap the view back once that send completes", async () => {
  await mount();

  await click(sessionButton("Chat A"));
  await act(async () => { await new Promise(r => setTimeout(r, 20)); });
  expect(mainPaneTitle()).toBe("Chat A");

  const composer = container.querySelector("#ollama-chat-composer") as HTMLTextAreaElement;
  await setInputValue(testWindow, composer, "hello from A");

  // Fire the send. It hangs on `postGate` — the user is still looking at the
  // "Sending…" state for session A.
  await click(buttonWithText("Send"));
  expect(container.textContent ?? "").toContain("Sending");

  // Nothing stops navigating away from an in-flight send: switch to B.
  await click(sessionButton("Chat B"));
  await act(async () => { await new Promise(r => setTimeout(r, 20)); });
  expect(mainPaneTitle()).toBe("Chat B");

  // Now let session A's send resolve, well after the user moved on.
  await act(async () => {
    releasePost?.();
    releasePost = null;
    await new Promise(r => setTimeout(r, 60));
  });

  // RED before the fix: the view silently snapped back to "Chat A" here,
  // because `runStream`'s trailing `void loadSession(sessionId)` (sessionId
  // == "session-a", captured when Send was clicked) unconditionally called
  // `setActiveSession(...)` with session A's data, with no check that the
  // user was still looking at A. GREEN after the fix: the user explicitly
  // navigated to "Chat B" and nothing they did afterward asked to leave it,
  // so the visible session stays "Chat B".
  expect(mainPaneTitle()).toBe("Chat B");
});
