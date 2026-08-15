/**
 * The Downloading page: a distinct surface (not a background table row),
 * grouping active transfers apart from finished history, with the same
 * anchored regex-wired search every list in this app carries.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import Downloads from "../src/pages/Downloads";
import { TestProviders } from "./helpers/providers";

const globals = ["document", "window", "navigator", "localStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

let records: unknown[] = [];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function serve(input: RequestInfo | URL): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes("/api/downloads")) return Promise.resolve(jsonResponse({ records }));
  return Promise.resolve(jsonResponse({}));
}

function boot(): void {
  previousGlobals = Object.fromEntries(globals.map(k => [k, Reflect.get(globalThis, k)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#/downloads" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    fetch: { configurable: true, value: serve },
  });
  Object.defineProperty(testWindow, "fetch", { configurable: true, value: serve });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}

beforeEach(() => { records = []; });

afterEach(() => {
  testWindow?.close();
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
});

async function mount(): Promise<{ container: HTMLElement; root: Root }> {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <TestProviders>
        <Downloads apiBase="http://x" />
      </TestProviders>,
    );
  });
  // The page defers its first load with a real `setTimeout(…, 0)` (matching
  // every other polling page in this codebase — see Ollama.tsx), so a
  // microtask-only flush is not enough to reach it: wait one real macrotask
  // tick first, then flush the fetch promise chain it kicks off.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  return { container, root };
}

function record(overrides: Record<string, unknown> = {}) {
  return {
    id: "r1", url: "https://example.test/report.pdf", suggestedFilename: "report.pdf",
    pageUrl: null, mimeType: null, source: "extension", state: "downloading",
    destinationPath: null, bytesReceived: 512, bytesTotal: 1024,
    rateBytesPerSec: 256, etaSeconds: 2, resumable: true,
    createdAt: Date.now(), startedAt: Date.now(), updatedAt: Date.now(), completedAt: null, error: null,
    ...overrides,
  };
}

test("an empty download list shows the honest empty state, not a blank card", async () => {
  boot();
  const { container, root } = await mount();
  expect(container.textContent).toContain("No downloads yet");
  await act(async () => { root.unmount(); });
});

test("an active transfer and a finished one land in their own sections", async () => {
  boot();
  records = [
    record({ id: "active-1", state: "downloading", suggestedFilename: "active.bin" }),
    record({ id: "done-1", state: "completed", suggestedFilename: "done.bin", destinationPath: "/tmp/done.bin", bytesReceived: 1024, bytesTotal: 1024 }),
  ];
  const { container, root } = await mount();

  const text = container.textContent ?? "";
  expect(text).toContain("active.bin");
  expect(text).toContain("done.bin");
  expect(text).toContain("Active");
  expect(text).toContain("History");
  await act(async () => { root.unmount(); });
});

test("the search field carries its own anchored regex builder, exactly one", async () => {
  boot();
  records = [record()];
  const { container, root } = await mount();

  const builders = container.querySelectorAll('button[aria-label="Open regex builder"]');
  expect(builders).toHaveLength(1);
  expect(container.querySelector("#downloads-search")).not.toBeNull();
  await act(async () => { root.unmount(); });
});

test("the search field actually narrows the list", async () => {
  boot();
  records = [
    record({ id: "a", suggestedFilename: "alpha.zip", url: "https://example.test/alpha.zip" }),
    record({ id: "b", suggestedFilename: "beta.zip", url: "https://example.test/beta.zip" }),
  ];
  const { container, root } = await mount();

  const input = container.querySelector("#downloads-search") as HTMLInputElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, "alpha");
    input.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
  });

  const text = container.textContent ?? "";
  expect(text).toContain("alpha.zip");
  expect(text).not.toContain("beta.zip");
  await act(async () => { root.unmount(); });
});

test("a queued download offers Cancel but not Pause/Resume — it has not started yet", async () => {
  boot();
  records = [record({ id: "q", state: "queued", suggestedFilename: "queued.bin" })];
  const { container, root } = await mount();

  expect(container.querySelector('button[aria-label="Cancel"]')).not.toBeNull();
  expect(container.querySelector('button[aria-label="Pause"]')).toBeNull();
  expect(container.querySelector('button[aria-label="Resume"]')).toBeNull();
  await act(async () => { root.unmount(); });
});

test("a completed download offers Remove but no transfer controls", async () => {
  boot();
  records = [record({ id: "c", state: "completed", suggestedFilename: "done.bin", destinationPath: "/tmp/done.bin", bytesReceived: 1024, bytesTotal: 1024 })];
  const { container, root } = await mount();

  expect(container.querySelector('button[aria-label="Remove from history"]')).not.toBeNull();
  expect(container.querySelector('button[aria-label="Cancel"]')).toBeNull();
  expect(container.querySelector('button[aria-label="Pause"]')).toBeNull();
  await act(async () => { root.unmount(); });
});
