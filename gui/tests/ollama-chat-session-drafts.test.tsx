/**
 * Regression test for confirmed finding L6-01: switching the active Ollama
 * chat session had no dirty-state guard at all. `OllamaChat.tsx`'s sidebar
 * session buttons (`onClick={() => setActiveSessionId(s.id)}`, no `disabled`,
 * no confirm) let the user leave the Settings tab mid-edit; the effect that
 * reacts to `activeSessionId` then calls `loadSession(nextId)`, which
 * unconditionally did:
 *
 *   setActiveSession(result.data.session);
 *   setModelDraft(result.data.session.model);
 *   setSystemPromptDraft(result.data.session.systemPrompt);
 *   setParametersDraft(result.data.session.parameters);
 *
 * with no comparison against the current (possibly edited, unsaved) draft
 * state and no `window.confirm`/dialog anywhere in the file. This is the same
 * defect shape HANDOFF.md already recorded as fixed once in this codebase
 * (`Subagents.tsx`'s `persisted.current` captured and never diffed) — this
 * file showed it was not fixed here.
 *
 * This test types an edit into session A's system prompt, switches to
 * session B without saving, switches back to A, and asserts the edit is
 * still there. That is the weakest, fix-agnostic form of "not silently
 * lost": it holds whether a real fix preserves an in-memory per-session
 * draft, or instead blocks/confirms the switch until the user saves or
 * explicitly discards.
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

const PARAMS = { temperature: 0.8, topP: 0.9, topK: 40, numCtx: 4096, repeatPenalty: 1.1, seed: null };

function session(id: string, title: string, systemPrompt: string) {
  return {
    id, title, model: "llama3", systemPrompt, parameters: PARAMS,
    messages: [], createdAt: 0, updatedAt: 0, streamingMessageId: null,
  };
}
function summary(id: string, title: string) {
  return { id, title, model: "llama3", messageCount: 0, createdAt: 0, updatedAt: 0, streaming: false, lastMessagePreview: null };
}

const SESSIONS: Record<string, ReturnType<typeof session>> = {
  "session-a": session("session-a", "Chat A", "Original A prompt"),
  "session-b": session("session-b", "Chat B", "Original B prompt"),
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
  const m = /\/api\/model-runtime\/chat\/sessions\/([^/]+)$/.exec(url);
  if (m && method === "GET") {
    const s = SESSIONS[m[1]!];
    if (!s) throw new Error(`hunt-ollamachat: unknown session ${m[1]}`);
    return jsonResponse({ ok: true, session: s });
  }
  throw new Error(`hunt-ollamachat: unexpected request ${method} ${url}`);
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

  container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(container as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
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

/** The active session's own title, rendered as the main pane's Card heading
 *  (`<h2 className="m3-card-title">{activeSession.title}</h2>`) — the LAST
 *  such heading in document order, after the page-header Card ("Ollama
 *  chat") and the sidebar's Card ("Sessions"). */
function mainPaneTitle(): string {
  const all = [...container.querySelectorAll("h2.m3-card-title")];
  return (all[all.length - 1]?.textContent ?? "").trim();
}

async function click(el: Element): Promise<void> {
  await act(async () => { el.dispatchEvent(new testWindow.Event("click", { bubbles: true })); });
  await act(async () => { await new Promise(r => setTimeout(r, 30)); });
}

test("an unsaved system-prompt edit survives switching to another session and back", async () => {
  await mount();

  await click(sessionButton("Chat A"));
  await act(async () => { await new Promise(r => setTimeout(r, 20)); });
  expect(mainPaneTitle()).toBe("Chat A");

  // Into the Settings tab, where the system prompt lives.
  const settingsTab = [...container.querySelectorAll('button[role="tab"]')].find(b => (b.textContent ?? "").trim() === "Settings");
  if (!settingsTab) throw new Error("no Settings tab");
  await click(settingsTab);

  const promptBox = container.querySelector("#ollama-chat-system-prompt") as HTMLTextAreaElement | null;
  if (!promptBox) throw new Error("no system-prompt textarea");
  expect(promptBox.value).toBe("Original A prompt");

  // Type an edit. Never click Save.
  await setInputValue(testWindow, promptBox, "MY UNSAVED EDIT FOR SESSION A");
  expect((container.querySelector("#ollama-chat-system-prompt") as HTMLTextAreaElement).value)
    .toBe("MY UNSAVED EDIT FOR SESSION A");

  // Switch to a different session. Nothing should discard the edit silently:
  // per HANDOFF.md's own recorded rule for this exact defect shape, a
  // capability (the user's typed draft) must not be dropped with nothing
  // erroring to say so.
  await click(sessionButton("Chat B"));
  await act(async () => { await new Promise(r => setTimeout(r, 20)); });
  expect(mainPaneTitle()).toBe("Chat B");

  // The edit must not have leaked into session B's own settings either.
  expect(container.textContent ?? "").not.toContain("MY UNSAVED EDIT FOR SESSION A");

  // Switch back to A.
  await click(sessionButton("Chat A"));
  await act(async () => { await new Promise(r => setTimeout(r, 20)); });
  expect(mainPaneTitle()).toBe("Chat A");

  const promptBoxAgain = container.querySelector("#ollama-chat-system-prompt") as HTMLTextAreaElement | null;
  if (!promptBoxAgain) throw new Error("no system-prompt textarea after switching back");

  // RED before the fix: this reads "Original A prompt" — `loadSession("session-a")`
  // overwrote `systemPromptDraft` unconditionally and the typed edit is gone
  // with no warning ever shown. GREEN after the fix: the edit the user typed
  // (never saved) is still here.
  expect(promptBoxAgain.value).toBe("MY UNSAVED EDIT FOR SESSION A");
});
