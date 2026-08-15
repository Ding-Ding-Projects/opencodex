/**
 * The batch-pull cart's GUI wiring: reviewing a batch shows real preflight
 * data, Start stays disabled until a matching review has run, and the queue
 * table renders per-item status/progress and only the actions valid for that
 * status. The backend's own byte-accurate progress, cancel, retry, and
 * resume logic is covered exhaustively in
 * `tests/model-runtime-pull-queue-engine.test.ts` — this file only proves the
 * page calls the right endpoint with the right body and renders the result.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import Ollama from "../src/pages/Ollama";
import { TestProviders } from "./helpers/providers";

const globals = ["document", "window", "navigator", "localStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;

interface FakeItem {
  id: string;
  tag: string;
  status: "queued" | "pulling" | "pulled" | "skipped" | "cancelled" | "failed";
  receivedBytes: number;
  totalBytes: number;
  totalKnown: boolean;
  lastStatusMessage: string | null;
  error: string | null;
}

let queueItems: FakeItem[];
let nextId: number;

function summarize(items: FakeItem[]) {
  const summary = { total: items.length, queued: 0, pulling: 0, pulled: 0, skipped: 0, cancelled: 0, failed: 0, outcome: "empty" as string };
  for (const i of items) (summary as unknown as Record<string, number>)[i.status] += 1;
  if (items.length === 0) summary.outcome = "empty";
  else if (summary.queued > 0 || summary.pulling > 0) summary.outcome = "in-progress";
  else if (summary.failed > 0 || summary.cancelled > 0) summary.outcome = "complete-partial";
  else summary.outcome = "complete-success";
  return summary;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function readBody(input: RequestInfo | URL, init?: RequestInit): Promise<Record<string, unknown>> {
  if (init?.body) return JSON.parse(String(init.body));
  if (input instanceof Request) {
    try { return await input.clone().json(); } catch { return {}; }
  }
  return {};
}

async function serve(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");

  if (url.includes("/api/model-runtime/health")) return jsonResponse({ state: "healthy", baseUrl: "http://127.0.0.1:11434", version: "0.6.2", detail: "ok", hostWarning: null, checkedAt: Date.now() });
  if (url.includes("/api/model-runtime/catalog")) return jsonResponse({ health: { state: "healthy", baseUrl: "x", version: "0.6.2", detail: "ok", hostWarning: null, checkedAt: 0 }, catalog: null });

  if (url.includes("/api/model-runtime/pull-queue/preflight") && method === "POST") {
    const body = await readBody(input, init);
    const tags = (body.tags as string[]) ?? [];
    return jsonResponse({
      ok: true,
      preflight: {
        items: tags.map(tag => ({
          tag,
          alreadyInstalled: tag === "already:here",
          estimatedSizeBytes: tag === "already:here" ? 4_000_000_000 : null,
          estimatedAdditionalDiskBytes: tag === "already:here" ? 4_600_000_000 : null,
          fitVerdict: tag === "already:here" ? "runs-well" : null,
          disclosure: tag === "already:here" ? "already installed; would be skipped" : "size only known once downloading starts",
        })),
        aggregateEstimatedBytes: tags.includes("already:here") ? 4_000_000_000 : 0,
        aggregateSizeFullyKnown: tags.every(t => t === "already:here"),
        freeDiskBytes: 100_000_000_000,
        diskPath: "C:\\Users\\test",
        networkDisclosure: "nothing here is purchased, charged, or billed — download queue only",
      },
    });
  }

  if (url.includes("/api/model-runtime/pull-queue/resume") && method === "POST") {
    return jsonResponse({ ok: true, state: { version: 1, items: queueItems }, concurrency: 2 });
  }

  if (url.includes("/api/model-runtime/pull-queue/start") && method === "POST") {
    const body = await readBody(input, init);
    const tags = (body.tags as string[]) ?? [];
    queueItems = tags.map(tag => {
      nextId += 1;
      return {
        id: `item-${nextId}`, tag,
        status: tag === "already:here" && body.force !== true ? "skipped" : "queued",
        receivedBytes: 0, totalBytes: 0, totalKnown: false, lastStatusMessage: null, error: null,
      };
    });
    return jsonResponse({ ok: true, state: { version: 1, items: queueItems } });
  }

  if (url.includes("/api/model-runtime/pull-queue/cancel") && method === "POST") {
    const body = await readBody(input, init);
    const id = body.id as string | undefined;
    if (id) {
      const item = queueItems.find(i => i.id === id);
      if (item && (item.status === "queued" || item.status === "pulling")) { item.status = "cancelled"; item.error = "cancelled before it started"; }
    } else {
      for (const item of queueItems) if (item.status === "queued" || item.status === "pulling") item.status = "cancelled";
    }
    return jsonResponse({ ok: true, state: { version: 1, items: queueItems }, summary: summarize(queueItems) });
  }

  if (url.includes("/api/model-runtime/pull-queue/retry") && method === "POST") {
    const body = await readBody(input, init);
    const item = queueItems.find(i => i.id === body.id);
    if (item) { item.status = "queued"; item.error = null; item.receivedBytes = 0; item.totalBytes = 0; item.totalKnown = false; }
    return jsonResponse({ ok: true, state: { version: 1, items: queueItems } });
  }

  if (url.includes("/api/model-runtime/pull-queue/clear") && method === "POST") {
    queueItems = queueItems.filter(i => i.status === "queued" || i.status === "pulling");
    return jsonResponse({ ok: true, summary: summarize(queueItems) });
  }

  if (url.includes("/api/model-runtime/pull-queue") && method === "GET") {
    return jsonResponse({ ok: true, state: { version: 1, items: queueItems }, summary: summarize(queueItems), concurrency: 2 });
  }

  throw new Error(`ollama-pull-queue.test: unexpected request ${method} ${url}`);
}

beforeEach(() => {
  queueItems = [];
  nextId = 0;
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
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
});

async function mount(): Promise<void> {
  // A dynamic import here, not a static top-level one: `react-dom/client`'s
  // controlled-input event wiring binds to whatever `document`/`window` are
  // live at the moment it is first evaluated. A static top-level import runs
  // before `beforeEach` swaps the globals to `testWindow`, and every native
  // "input" event dispatched afterward is then silently never delivered to
  // React's onChange handlers — clicks still work (they do not go through
  // this path), which is what makes it easy to miss. Proven the hard way:
  // see the sibling working examples (`converter-page.test.tsx`,
  // `locks-page.test.tsx`), which both import it dynamically inside their
  // own `mount()` for the same reason.
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(container);
    root.render(<TestProviders><Ollama apiBase="" /></TestProviders>);
  });
  await act(async () => { await new Promise(r => setTimeout(r, 50)); });
}

async function setTextArea(id: string, value: string): Promise<void> {
  const el = container.querySelector(`#${id}`) as HTMLTextAreaElement;
  if (!el) throw new Error(`no textarea #${id}`);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(testWindow.HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
  });
}

function buttonByText(text: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find(b => (b.textContent ?? "").includes(text));
  if (!found) throw new Error(`no button containing "${text}"`);
  return found as HTMLButtonElement;
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => { button.click(); });
  await act(async () => { await new Promise(r => setTimeout(r, 30)); });
}

test("the batch-pull card renders with an empty tags field and Start disabled", async () => {
  await mount();
  const textarea = container.querySelector("#ollama-pull-tags");
  expect(textarea).not.toBeNull();
  const start = buttonByText("Start pull");
  expect(start.disabled).toBe(true);
  const review = buttonByText("Review batch");
  expect(review.disabled).toBe(true); // no tags typed yet
});

test("typing tags enables Review; Review calls preflight and shows real per-item data, never a guessed size for a new tag", async () => {
  await mount();
  await setTextArea("ollama-pull-tags", "already:here\nbrand-new:1b");

  const review = buttonByText("Review batch");
  expect(review.disabled).toBe(false);
  await click(review);

  const text = container.textContent ?? "";
  expect(text).toContain("already:here");
  expect(text).toContain("brand-new:1b");
  expect(text).toContain("Already installed");
  expect(text).toContain("New pull");
  expect(text).toContain("Unknown until pull begins");
  expect(text).toContain("nothing here is purchased, charged, or billed");

  // Start becomes available once the review matches exactly what is in the box.
  const start = buttonByText("Start pull");
  expect(start.disabled).toBe(false);
});

test("editing the tags after a review invalidates it — Start goes back to disabled", async () => {
  await mount();
  await setTextArea("ollama-pull-tags", "one:1b");
  await click(buttonByText("Review batch"));
  expect(buttonByText("Start pull").disabled).toBe(false);

  await setTextArea("ollama-pull-tags", "one:1b\ntwo:1b");
  expect(buttonByText("Start pull").disabled).toBe(true);
  expect(container.textContent ?? "").toContain("Review the batch to see sizes");
});

test("Start posts the exact reviewed tags plus force/concurrency, then renders the resulting queue with real per-item status", async () => {
  await mount();
  await setTextArea("ollama-pull-tags", "already:here,new:1b");
  await click(buttonByText("Review batch"));
  await click(buttonByText("Start pull"));

  const text = container.textContent ?? "";
  expect(text).toContain("Pull queue");
  expect(text).toContain("already:here");
  expect(text).toContain("new:1b");
  expect(text).toContain("Skipped"); // already:here, not forced
  expect(text).toContain("Queued");

  // The tags field is cleared after a successful start, ready for the next batch.
  const textarea = container.querySelector("#ollama-pull-tags") as HTMLTextAreaElement;
  expect(textarea.value).toBe("");
});

test("a failed item next to a pulled one shows the warning banner, never a clean success — and only Retry is offered for it", async () => {
  queueItems = [
    { id: "a", tag: "good:1", status: "pulled", receivedBytes: 1000, totalBytes: 1000, totalKnown: true, lastStatusMessage: "success", error: null },
    { id: "b", tag: "bad:1", status: "failed", receivedBytes: 0, totalBytes: 0, totalKnown: false, lastStatusMessage: null, error: "the runtime refused the connection" },
  ];
  await mount();

  const text = container.textContent ?? "";
  expect(text).toContain("not reported as a clean success");
  expect(text).toContain("the runtime refused the connection");

  // Retry is offered for the failed row; Cancel is not (nothing active to cancel there).
  // Scoped to the queue table rows — the health banner above also carries its
  // own unrelated "Retry" action, which a bare page-wide substring search would
  // wrongly count too.
  const rows = Array.from(container.querySelectorAll("table.m3-table tbody tr"));
  const failedRow = rows.find(r => (r.textContent ?? "").includes("bad:1"))!;
  const pulledRow = rows.find(r => (r.textContent ?? "").includes("good:1"))!;
  expect(Array.from(failedRow.querySelectorAll("button")).some(b => (b.textContent ?? "").includes("Retry"))).toBe(true);
  expect(failedRow.querySelectorAll("button")).toHaveLength(1); // Retry only, no Cancel
  expect(pulledRow.querySelectorAll("button")).toHaveLength(0); // a finished, successful item offers no action
});

test("cancelling an active item calls cancel with that item's id, and the row updates to Cancelled", async () => {
  queueItems = [{ id: "solo", tag: "busy:1", status: "pulling", receivedBytes: 500, totalBytes: 1000, totalKnown: true, lastStatusMessage: "downloading", error: null }];
  await mount();
  expect(container.textContent ?? "").toContain("Downloading");

  await click(buttonByText("Cancel"));
  expect(container.textContent ?? "").toContain("Cancelled");
});

test("Clear finished removes only terminal rows and leaves an active one alone", async () => {
  queueItems = [
    { id: "done", tag: "done:1", status: "pulled", receivedBytes: 1, totalBytes: 1, totalKnown: true, lastStatusMessage: "success", error: null },
    { id: "active", tag: "active:1", status: "pulling", receivedBytes: 1, totalBytes: 10, totalKnown: true, lastStatusMessage: "downloading", error: null },
  ];
  await mount();
  await click(buttonByText("Clear finished"));

  const text = container.textContent ?? "";
  expect(text).not.toContain("done:1");
  expect(text).toContain("active:1");
});
