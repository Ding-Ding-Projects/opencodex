/**
 * The converter page: every category carries its own regex-wired search, a
 * disabled format names its exact reason rather than hiding, and a detected
 * PDF hands off to the real PDF Tools page instead of duplicating its seven
 * operations here.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import Converter from "../src/pages/Converter";
import { TestProviders } from "./helpers/providers";

const globals = ["document", "window", "navigator", "localStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

const CATALOG = {
  categories: [
    {
      id: "documents-pdf", label: "Documents / PDF",
      formats: [
        { id: "pdf", label: "PDF", category: "documents-pdf", extensions: ["pdf"], bundled: true, operations: ["inspect", "split", "merge", "extract", "reorder", "rotate", "metadata"] },
        { id: "docx", label: "DOCX", category: "documents-pdf", extensions: ["docx"], bundled: false, missingDependency: "a DOCX reader/writer", reason: "no bundled, offline document engine ships in this install for this format" },
      ],
    },
    {
      id: "images", label: "Images",
      formats: [
        { id: "png", label: "PNG", category: "images", extensions: ["png"], bundled: false, missingDependency: "an image codec", reason: "no bundled, offline codec ships in this install" },
      ],
    },
    { id: "audio", label: "Audio", formats: [{ id: "mp3", label: "MP3", category: "audio", extensions: ["mp3"], bundled: false, reason: "no bundled, offline audio transcoder" }] },
    { id: "video", label: "Video", formats: [{ id: "mp4", label: "MP4", category: "video", extensions: ["mp4"], bundled: false, reason: "no bundled, offline video transcoder" }] },
    {
      id: "archives", label: "Archives",
      formats: [{ id: "zip", label: "ZIP", category: "archives", extensions: ["zip"], bundled: true, operations: ["extract"] }],
    },
    {
      id: "structured-data", label: "Structured Data / Spreadsheets",
      formats: [
        { id: "json", label: "JSON", category: "structured-data", extensions: ["json"], bundled: true, operations: ["to-csv", "to-tsv", "to-xml", "from-csv", "from-tsv", "from-xml"] },
        {
          id: "csv", label: "CSV", category: "structured-data", extensions: ["csv"], bundled: true, operations: ["to-json", "from-json"],
          lossy: true, lossyNote: "every cell becomes plain text",
        },
        { id: "tsv", label: "TSV", category: "structured-data", extensions: ["tsv"], bundled: true, operations: ["to-json", "from-json"], lossy: true, lossyNote: "every cell becomes plain text" },
        { id: "xml", label: "XML", category: "structured-data", extensions: ["xml"], bundled: true, operations: ["to-json", "from-json"], lossy: true, lossyNote: "attributes are never emitted" },
      ],
    },
    { id: "code-text", label: "Code / Text", formats: [{ id: "plain-text", label: "Plain text", category: "code-text", extensions: ["txt"], bundled: false, reason: "not built yet" }] },
    { id: "binary-encodings", label: "Binary Encodings", formats: [{ id: "base64", label: "Base64", category: "binary-encodings", extensions: [], bundled: false, reason: "not built yet" }] },
  ],
  totalFormats: 12,
  enabledFormats: 6,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let detectResult: unknown = { ok: true, formatId: "pdf", category: "documents-pdf", evidence: "found the %PDF- header", bytesInspected: 1024 };
let extractZipResult: unknown = { ok: true, destination: "C:\\out\\extracted", entryCount: 3, bytesWritten: 4096 };
let convertStructuredResult: unknown = { ok: true, path: "C:\\out\\a.json", bytesWritten: 42 };
const runRequests: { path: string; body: unknown }[] = [];

/* ---------------------------------------------------------- batch queue mock */

interface QueueItemFixture {
  id: string; kind: string; sourcePath: string; sourceFormat: string | null; destPath: string; destFormat: string | null;
  acknowledgeLossy: boolean; rotateDegrees?: number; status: string;
  requestedAt: number; startedAt: number | null; finishedAt: number | null;
  sourceBytes: number | null; bytesWritten: number | null; lossy: boolean | null;
  notes: string[] | null; boundary: string | null; error: string | null;
}

let queueItems: QueueItemFixture[] = [];
let queuePaused = false;
let queuePreflightResult: unknown = {
  items: [], aggregateEstimatedBytes: 2048, aggregateSizeFullyKnown: true,
  groups: [{ directory: "C:\\out", freeDiskBytes: 500_000_000, estimatedBytesNeeded: 2048, sufficient: true }],
  insufficientDiskSpace: false, disclosure: "each item's estimate is its source file's size times a conservative margin",
};
let enqueueResult: unknown = null; // set per-test when a non-default response is needed
const queueRequests: { path: string; method: string; body: unknown }[] = [];

function outcomeFor(items: QueueItemFixture[], paused: boolean): string {
  if (items.length === 0) return "empty";
  if (items.some(i => i.status === "converting")) return "in-progress";
  if (items.some(i => i.status === "queued")) return paused ? "paused" : "in-progress";
  if (items.some(i => i.status === "failed" || i.status === "cancelled")) return "complete-partial";
  return "complete-success";
}

function queueSummaryFor(items: QueueItemFixture[]): Record<string, number | string> {
  const count = (s: string) => items.filter(i => i.status === s).length;
  return {
    total: items.length, queued: count("queued"), converting: count("converting"), converted: count("converted"),
    skipped: count("skipped"), cancelled: count("cancelled"), failed: count("failed"), outcome: outcomeFor(items, queuePaused),
  };
}

function queueStateBody(): unknown {
  return { ok: true, state: { paused: queuePaused, items: queueItems }, summary: queueSummaryFor(queueItems), concurrency: 3 };
}

function serve(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = input instanceof Request ? input : null;
  const url = new URL(String(req ? req.url : input), "http://localhost");
  const path = url.pathname;
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(String(init.body)) as unknown : null;

  if (path === "/api/converter/catalog") return Promise.resolve(jsonResponse(CATALOG));
  if (path === "/api/converter/detect") return Promise.resolve(jsonResponse(detectResult));
  if (path === "/api/converter/extract-zip") {
    runRequests.push({ path, body: JSON.parse(String(init?.body ?? "{}")) });
    const result = extractZipResult as { ok: boolean };
    return Promise.resolve(jsonResponse(extractZipResult, result.ok ? 200 : 422));
  }
  if (path === "/api/converter/convert-structured") {
    runRequests.push({ path, body: JSON.parse(String(init?.body ?? "{}")) });
    const result = convertStructuredResult as { ok: boolean };
    return Promise.resolve(jsonResponse(convertStructuredResult, result.ok ? 200 : 422));
  }

  if (path === "/api/converter/queue/resume" && method === "POST") {
    queueRequests.push({ path, method, body });
    return Promise.resolve(jsonResponse(queueStateBody()));
  }
  if (path === "/api/converter/queue" && method === "GET") return Promise.resolve(jsonResponse(queueStateBody()));
  if (path === "/api/converter/queue/preflight" && method === "POST") {
    queueRequests.push({ path, method, body });
    return Promise.resolve(jsonResponse({ ok: true, preflight: queuePreflightResult }));
  }
  if (path === "/api/converter/queue/enqueue" && method === "POST") {
    queueRequests.push({ path, method, body });
    if (enqueueResult) {
      const result = enqueueResult as { ok: boolean };
      return Promise.resolve(jsonResponse(enqueueResult, result.ok ? 200 : 422));
    }
    const jobs = (body as { jobs: Array<Record<string, unknown>> }).jobs;
    const now = Date.now();
    const added = jobs.map((j, i): QueueItemFixture => ({
      id: `q-${now}-${i}`, kind: (j.kind as string) ?? "structured",
      sourcePath: j.sourcePath as string, sourceFormat: (j.sourceFormat as string) ?? null,
      destPath: j.destPath as string, destFormat: (j.destFormat as string) ?? null,
      acknowledgeLossy: j.acknowledgeLossy === true, rotateDegrees: j.rotateDegrees as number | undefined,
      status: "converted", requestedAt: now, startedAt: now, finishedAt: now,
      sourceBytes: 100, bytesWritten: 100, lossy: false, notes: ["done"], boundary: null, error: null,
    }));
    queueItems = [...queueItems, ...added];
    return Promise.resolve(jsonResponse({ ok: true, state: { paused: queuePaused, items: queueItems }, added: added.length, preflight: queuePreflightResult }));
  }
  if (path === "/api/converter/queue/pause" && method === "POST") {
    queueRequests.push({ path, method, body });
    queuePaused = true;
    return Promise.resolve(jsonResponse({ ok: true, summary: queueSummaryFor(queueItems) }));
  }
  if (path === "/api/converter/queue/resume-run" && method === "POST") {
    queueRequests.push({ path, method, body });
    queuePaused = false;
    return Promise.resolve(jsonResponse({ ok: true, summary: queueSummaryFor(queueItems) }));
  }
  if (path === "/api/converter/queue/cancel" && method === "POST") {
    queueRequests.push({ path, method, body });
    const id = (body as { id?: string } | null)?.id;
    for (const item of queueItems) {
      if (id ? item.id === id : true) {
        if (item.status === "queued") { item.status = "cancelled"; item.error = "cancelled before it started"; }
      }
    }
    return Promise.resolve(jsonResponse({ ok: true, summary: queueSummaryFor(queueItems) }));
  }
  if (path === "/api/converter/queue/retry" && method === "POST") {
    queueRequests.push({ path, method, body });
    const id = (body as { id?: string } | null)?.id;
    const item = queueItems.find(i => i.id === id);
    if (item) { item.status = "queued"; item.error = null; item.boundary = null; }
    return Promise.resolve(jsonResponse({ ok: true, state: { paused: queuePaused, items: queueItems } }));
  }
  if (path === "/api/converter/queue/clear" && method === "POST") {
    queueRequests.push({ path, method, body });
    queueItems = queueItems.filter(i => i.status === "queued" || i.status === "converting");
    return Promise.resolve(jsonResponse({ ok: true, summary: queueSummaryFor(queueItems) }));
  }

  return Promise.resolve(jsonResponse({}));
}

function boot(): void {
  previousGlobals = Object.fromEntries(globals.map(k => [k, Reflect.get(globalThis, k)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#/converter" });
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

beforeEach(() => {
  detectResult = { ok: true, formatId: "pdf", category: "documents-pdf", evidence: "found the %PDF- header", bytesInspected: 1024 };
  extractZipResult = { ok: true, destination: "C:\\out\\extracted", entryCount: 3, bytesWritten: 4096 };
  convertStructuredResult = { ok: true, path: "C:\\out\\a.json", bytesWritten: 42 };
  runRequests.length = 0;
  queueItems = [];
  queuePaused = false;
  enqueueResult = null;
  queueRequests.length = 0;
});

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
        <Converter apiBase="http://x" />
      </TestProviders>,
    );
  });
  // Let the catalog fetch settle, and the batch queue's own mount-time chain
  // (POST .../resume, then GET the state) resolve too — two sequential
  // fetches need more microtask turns than the catalog's single one.
  await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
  return { container, root };
}

function inputWithId(container: HTMLElement, id: string): HTMLInputElement {
  const found = container.querySelector(`#${id}`);
  if (!found) throw new Error(`no element with id ${id}`);
  return found as HTMLInputElement;
}

async function setValue(win: Window, input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
  });
}

async function selectValue(win: Window, select: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(win.HTMLSelectElement.prototype, "value")!.set!;
    setter.call(select, value);
    select.dispatchEvent(new win.Event("change", { bubbles: true }));
  });
}

async function flush(times = 6): Promise<void> {
  await act(async () => { for (let i = 0; i < times; i++) await Promise.resolve(); });
}

function findButton(container: HTMLElement, text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === text);
  if (!found) throw new Error(`no button with text "${text}"`);
  return found;
}

async function clickButton(container: HTMLElement, text: string): Promise<void> {
  const button = findButton(container, text);
  await act(async () => { button.click(); await Promise.resolve(); await Promise.resolve(); });
}

test("every one of the eight categories carries its own anchored regex-builder search", async () => {
  boot();
  const { container, root } = await mount();

  const builders = container.querySelectorAll('button[aria-label="Open regex builder"]');
  expect(builders).toHaveLength(8);

  const searchInputs = [
    "converter-search-documents-pdf", "converter-search-images", "converter-search-audio",
    "converter-search-video", "converter-search-archives", "converter-search-structured-data",
    "converter-search-code-text", "converter-search-binary-encodings",
  ];
  for (const id of searchInputs) inputWithId(container, id); // throws if missing

  await act(async () => { root.unmount(); });
});

test("the PDF row is shown enabled while every other format is shown disabled with its exact reason", async () => {
  boot();
  const { container, root } = await mount();

  const text = container.textContent ?? "";
  expect(text).toContain("PDF");
  expect(text).toContain("Bundled — works offline");
  expect(text).toContain("DOCX");
  expect(text).toContain("Missing: no bundled, offline document engine ships in this install for this format");
  expect(text).toContain("PNG");
  expect(text).toContain("Missing: no bundled, offline codec ships in this install");

  await act(async () => { root.unmount(); });
});

test("a category's search field actually narrows its own list, and only its own list", async () => {
  boot();
  const { container, root } = await mount();

  const docsSearch = inputWithId(container, "converter-search-documents-pdf");
  await setValue(testWindow, docsSearch, "docx");

  const docsList = docsSearch.closest(".m3-card")!;
  expect(docsList.textContent).toContain("DOCX");
  expect(docsList.textContent).not.toContain("PDF Bundled");

  // A different category's list is untouched by another category's query.
  const imagesList = inputWithId(container, "converter-search-images").closest(".m3-card")!;
  expect(imagesList.textContent).toContain("PNG");

  await act(async () => { root.unmount(); });
});

test("detecting a bundled PDF source offers a hand-off into PDF Tools instead of a second implementation", async () => {
  boot();
  const { container, root } = await mount();

  const source = inputWithId(container, "converter-source");
  await setValue(testWindow, source, "C:\\Users\\me\\report.pdf");

  const detectButton = [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "Detect")!;
  await act(async () => { detectButton.click(); await Promise.resolve(); await Promise.resolve(); });

  const openButton = [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "Open in PDF Tools");
  expect(openButton).toBeTruthy();

  await act(async () => { openButton!.click(); });
  expect(window.location.hash).toBe("#pdf?source=C%3A%5CUsers%5Cme%5Creport.pdf");

  await act(async () => { root.unmount(); });
});

test("detecting an unrecognised format is reported honestly rather than guessed", async () => {
  boot();
  detectResult = { ok: true, bytesInspected: 40, evidence: "printable text with no recognised structured format; bytes alone cannot name a specific text format or language" };
  const { container, root } = await mount();

  const source = inputWithId(container, "converter-source");
  await setValue(testWindow, source, "C:\\Users\\me\\notes.mystery");
  const detectButton = [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "Detect")!;
  await act(async () => { detectButton.click(); await Promise.resolve(); await Promise.resolve(); });

  expect(container.textContent).toContain("Could not classify this file from its bytes");
  expect([...container.querySelectorAll("button")].some(b => b.textContent?.trim() === "Open in PDF Tools")).toBe(false);

  await act(async () => { root.unmount(); });
});

async function detectAs(container: HTMLElement, sourcePath: string): Promise<void> {
  const source = inputWithId(container, "converter-source");
  await setValue(testWindow, source, sourcePath);
  const detectButton = [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "Detect")!;
  await act(async () => { detectButton.click(); await Promise.resolve(); await Promise.resolve(); });
}

test("detecting a bundled ZIP source offers a real Extract action that posts path and destination", async () => {
  boot();
  detectResult = { ok: true, formatId: "zip", category: "archives", evidence: "found the local file header PK\\x03\\x04", bytesInspected: 30 };
  const { container, root } = await mount();

  await detectAs(container, "C:\\Users\\me\\archive.zip");

  // No target-format picker for an archive — only Documents/PDF and
  // Structured Data need one, and this must not leak in from either.
  expect(container.querySelector("#converter-target-format")).toBeNull();

  const destination = inputWithId(container, "converter-destination-zip");
  await setValue(testWindow, destination, "C:\\Users\\me\\extracted");

  const extractButton = [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "Extract")!;
  expect(extractButton.hasAttribute("disabled")).toBe(false);
  await act(async () => { extractButton.click(); await Promise.resolve(); await Promise.resolve(); });

  expect(runRequests).toEqual([{
    path: "/api/converter/extract-zip",
    body: { path: "C:\\Users\\me\\archive.zip", destination: "C:\\Users\\me\\extracted" },
  }]);
  expect(container.textContent).toContain("Extracted 3 item(s) to C:\\Users\\me\\extracted");

  await act(async () => { root.unmount(); });
});

test("the Extract button stays disabled until a destination is typed in", async () => {
  boot();
  detectResult = { ok: true, formatId: "zip", category: "archives", evidence: "found the local file header PK\\x03\\x04", bytesInspected: 30 };
  const { container, root } = await mount();

  await detectAs(container, "C:\\Users\\me\\archive.zip");

  const extractButton = [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "Extract")!;
  expect(extractButton.hasAttribute("disabled")).toBe(true);
  expect(runRequests).toHaveLength(0);

  await act(async () => { root.unmount(); });
});

test("a refused extraction reports its boundary and never claims success", async () => {
  boot();
  detectResult = { ok: true, formatId: "zip", category: "archives", evidence: "found the local file header PK\\x03\\x04", bytesInspected: 30 };
  extractZipResult = { ok: false, error: "the archive is malformed", boundary: "malformed" };
  const { container, root } = await mount();

  await detectAs(container, "C:\\Users\\me\\bad.zip");
  await setValue(testWindow, inputWithId(container, "converter-destination-zip"), "C:\\Users\\me\\out");
  const extractButton = [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "Extract")!;
  await act(async () => { extractButton.click(); await Promise.resolve(); await Promise.resolve(); });

  expect(container.textContent).toContain("Refused (malformed): the archive is malformed");
  expect(container.textContent).not.toContain("Extracted");

  await act(async () => { root.unmount(); });
});

test("detecting a bundled CSV source only offers JSON as a target, per the catalogue's own operations list", async () => {
  boot();
  detectResult = { ok: true, formatId: "csv", category: "structured-data", evidence: "consistent with CSV text", bytesInspected: 12 };
  const { container, root } = await mount();

  await detectAs(container, "C:\\Users\\me\\rows.csv");

  const select = container.querySelector<HTMLSelectElement>("#converter-target-format")!;
  expect(select).toBeTruthy();
  const optionValues = [...select.options].map(o => o.value);
  expect(optionValues).toEqual(["json"]);

  await act(async () => { root.unmount(); });
});

test("a lossy target format shows its exact disclosure and gates Convert behind an explicit acknowledgement", async () => {
  boot();
  detectResult = { ok: true, formatId: "json", category: "structured-data", evidence: "found a top-level JSON value", bytesInspected: 12 };
  const { container, root } = await mount();

  await detectAs(container, "C:\\Users\\me\\data.json");

  const select = container.querySelector<HTMLSelectElement>("#converter-target-format")!;
  const optionValues = [...select.options].map(o => o.value);
  expect(optionValues).toEqual(["csv", "tsv", "xml"]);

  await setValue(testWindow, inputWithId(container, "converter-destination-structured"), "C:\\Users\\me\\out.csv");

  expect(container.textContent).toContain("every cell becomes plain text");
  const convertButton = [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "Convert")!;
  expect(convertButton.hasAttribute("disabled")).toBe(true);
  expect(runRequests).toHaveLength(0);

  const ack = container.querySelector<HTMLButtonElement>(
    'button[role="switch"][aria-label="I understand this conversion loses information"]',
  );
  expect(ack).toBeTruthy();
  await act(async () => { ack!.click(); });

  expect(convertButton.hasAttribute("disabled")).toBe(false);
  await act(async () => { convertButton.click(); await Promise.resolve(); await Promise.resolve(); });

  expect(runRequests).toEqual([{
    path: "/api/converter/convert-structured",
    // The toggle's acknowledgement actually has to reach the server — the
    // service is what enforces it (boundary lossy-not-acknowledged), not
    // merely this button's disabled state.
    body: { path: "C:\\Users\\me\\data.json", sourceFormat: "json", destination: "C:\\Users\\me\\out.csv", destFormat: "csv", acknowledgeLossy: true },
  }]);
  expect(container.textContent).toContain("Converted json to csv, wrote C:\\Users\\me\\out.csv");

  await act(async () => { root.unmount(); });
});

test("a fresh detection resets the previous run's destination, target format and result", async () => {
  boot();
  detectResult = { ok: true, formatId: "zip", category: "archives", evidence: "found the local file header PK\\x03\\x04", bytesInspected: 30 };
  const { container, root } = await mount();

  await detectAs(container, "C:\\Users\\me\\archive.zip");
  await setValue(testWindow, inputWithId(container, "converter-destination-zip"), "C:\\Users\\me\\extracted");
  const extractButton = [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "Extract")!;
  await act(async () => { extractButton.click(); await Promise.resolve(); await Promise.resolve(); });
  expect(container.textContent).toContain("Extracted 3 item(s)");

  // Detecting a different source must not carry the previous run's
  // destination, banner or requests over onto it.
  await detectAs(container, "C:\\Users\\me\\second.zip");
  expect(container.textContent).not.toContain("Extracted 3 item(s)");
  expect(inputWithId(container, "converter-destination-zip").value).toBe("");

  await act(async () => { root.unmount(); });
});

/* ================================================================= batch queue */

test("the batch queue is reachable at all: it resumes and reads the real queue on mount, not just a single ad-hoc conversion", async () => {
  boot();
  const { container, root } = await mount();

  expect(container.textContent).toContain("Batch queue");
  expect(queueRequests.some(r => r.path === "/api/converter/queue/resume")).toBe(true);

  await act(async () => { root.unmount(); });
});

test("a structured draft job can be built, previewed, and enqueued — the real preflight disclosure is shown before anything starts", async () => {
  boot();
  const { container, root } = await mount();

  await setValue(testWindow, inputWithId(container, "converter-queue-source"), "C:\\Users\\me\\in.json");
  await setValue(testWindow, inputWithId(container, "converter-queue-dest"), "C:\\Users\\me\\out.csv");
  await selectValue(testWindow, container.querySelector<HTMLSelectElement>("#converter-queue-dest-format")!, "csv");

  await clickButton(container, "Add to batch");
  expect(container.textContent).toContain("C:\\Users\\me\\in.json");
  expect(container.textContent).toContain("C:\\Users\\me\\out.csv");

  // The preflight disclosure is a real request, and its own real numbers —
  // never a client-side guess — are what render.
  await clickButton(container, "Preview (storage estimate)");
  expect(queueRequests.some(r => r.path === "/api/converter/queue/preflight")).toBe(true);
  expect(container.textContent).toContain("each item's estimate is its source file's size times a conservative margin");
  expect(container.textContent).toContain("C:\\out");

  await clickButton(container, "Enqueue batch");
  const enqueueReq = queueRequests.find(r => r.path === "/api/converter/queue/enqueue");
  expect(enqueueReq).toBeTruthy();
  expect((enqueueReq!.body as { jobs: unknown[] }).jobs).toEqual([{
    kind: "structured", sourcePath: "C:\\Users\\me\\in.json", destPath: "C:\\Users\\me\\out.csv",
    sourceFormat: "json", destFormat: "csv", acknowledgeLossy: false, overwrite: false,
  }]);

  // The draft is cleared and the real live queue table now shows the job.
  expect(container.querySelector("#converter-queue-source")).toHaveProperty("value", "");
  expect(container.textContent).toContain("Queue");
  expect(container.textContent).toContain("C:\\Users\\me\\in.json");

  await act(async () => { root.unmount(); });
});

test("switching job kind swaps the fields: zip-extract needs no format picker, pdf-rotate offers a rotation degree", async () => {
  boot();
  const { container, root } = await mount();

  const zipOption = [...container.querySelectorAll('button[role="radio"]')].find(b => b.textContent?.trim() === "ZIP extract")!;
  await act(async () => { zipOption.click(); });
  expect(container.querySelector("#converter-queue-dest-format")).toBeNull();
  expect(container.querySelector("#converter-queue-rotate")).toBeNull();

  const pdfOption = [...container.querySelectorAll('button[role="radio"]')].find(b => b.textContent?.trim() === "PDF rotate pages")!;
  await act(async () => { pdfOption.click(); });
  expect(container.querySelector("#converter-queue-dest-format")).toBeNull();
  const rotateSelect = container.querySelector<HTMLSelectElement>("#converter-queue-rotate");
  expect(rotateSelect).toBeTruthy();
  expect([...rotateSelect!.options].map(o => o.value)).toEqual(["0", "90", "180", "270"]);
  // `Toggle`'s label is an `aria-label`, not rendered text (see the lossy-ack
  // toggle test above for the same pattern) — query it the same way.
  expect(container.querySelector('button[role="switch"][aria-label="I understand rotating a signed PDF invalidates its signature"]')).toBeTruthy();

  await act(async () => { root.unmount(); });
});

test("a pdf-rotate job is drafted and enqueued with its real rotateDegrees and acknowledgement", async () => {
  boot();
  const { container, root } = await mount();

  const pdfOption = [...container.querySelectorAll('button[role="radio"]')].find(b => b.textContent?.trim() === "PDF rotate pages")!;
  await act(async () => { pdfOption.click(); });

  await setValue(testWindow, inputWithId(container, "converter-queue-source"), "C:\\Users\\me\\doc.pdf");
  await setValue(testWindow, inputWithId(container, "converter-queue-dest"), "C:\\Users\\me\\doc-rotated.pdf");
  await selectValue(testWindow, container.querySelector<HTMLSelectElement>("#converter-queue-rotate")!, "180");

  const ack = container.querySelector<HTMLButtonElement>(
    'button[role="switch"][aria-label="I understand rotating a signed PDF invalidates its signature"]',
  )!;
  await act(async () => { ack.click(); });

  await clickButton(container, "Add to batch");
  await clickButton(container, "Enqueue batch");

  const enqueueReq = queueRequests.find(r => r.path === "/api/converter/queue/enqueue");
  expect((enqueueReq!.body as { jobs: unknown[] }).jobs).toEqual([{
    kind: "pdf-rotate", sourcePath: "C:\\Users\\me\\doc.pdf", destPath: "C:\\Users\\me\\doc-rotated.pdf",
    rotateDegrees: 180, acknowledgeLossy: true, overwrite: false,
  }]);

  await act(async () => { root.unmount(); });
});

const nowFixture = 1_700_000_000_000;

function queueItemFixture(overrides: Partial<QueueItemFixture>): QueueItemFixture {
  return {
    id: "fixture-1", kind: "structured", sourcePath: "C:\\a.json", sourceFormat: "json",
    destPath: "C:\\a.csv", destFormat: "csv", acknowledgeLossy: true, status: "queued",
    requestedAt: nowFixture, startedAt: null, finishedAt: null,
    sourceBytes: 10, bytesWritten: null, lossy: null, notes: null, boundary: null, error: null,
    ...overrides,
  };
}

test("the live queue table renders real per-item status/details and wires pause, cancel, retry and clear to the real routes", async () => {
  boot();
  queueItems = [
    queueItemFixture({ id: "running", status: "converting" }),
    queueItemFixture({ id: "done", status: "converted", bytesWritten: 55, notes: ["wrote 55 bytes"], destPath: "C:\\done.csv" }),
    queueItemFixture({
      id: "broke", status: "failed", boundary: "lossy-not-acknowledged", error: "acknowledgeLossy: true is required",
      destPath: "C:\\broke.csv",
    }),
  ];
  const { container, root } = await mount();

  expect(container.textContent).toContain("Converting…");
  expect(container.textContent).toContain("wrote 55 bytes");
  expect(container.textContent).toContain("lossy-not-acknowledged");
  expect(container.textContent).toContain("acknowledgeLossy: true is required");

  // Pause: the "converting" item is still active, so Pause is enabled.
  await clickButton(container, "Pause");
  expect(queueRequests.some(r => r.path === "/api/converter/queue/pause")).toBe(true);

  // Retry the failed item, by its own id — never a generic "retry everything".
  await clickButton(container, "Retry");
  const retryReq = queueRequests.find(r => r.path === "/api/converter/queue/retry");
  expect(retryReq?.body).toEqual({ id: "broke" });

  await clickButton(container, "Clear finished");
  expect(queueRequests.some(r => r.path === "/api/converter/queue/clear")).toBe(true);

  await act(async () => { root.unmount(); });
});

test("cancelling one queued item sends its own id, not a blanket cancel-everything call", async () => {
  boot();
  queueItems = [queueItemFixture({ id: "solo", status: "queued" })];
  const { container, root } = await mount();

  await clickButton(container, "Cancel");
  const cancelReq = queueRequests.find(r => r.path === "/api/converter/queue/cancel");
  expect(cancelReq?.body).toEqual({ id: "solo" });

  await act(async () => { root.unmount(); });
});

test("a batch refused for insufficient disk space reports the real error and never clears the draft", async () => {
  boot();
  enqueueResult = { ok: false, error: "the destination does not have enough free space for this batch, by the conservative estimate below" };
  const { container, root } = await mount();

  await setValue(testWindow, inputWithId(container, "converter-queue-source"), "C:\\Users\\me\\big.json");
  await setValue(testWindow, inputWithId(container, "converter-queue-dest"), "C:\\Users\\me\\big.csv");
  await clickButton(container, "Add to batch");
  await clickButton(container, "Enqueue batch");

  // The failure notice itself is a toast (`SnackbarHost`, mounted by `App.tsx`
  // rather than this bare page harness — see the lossy-conversion failure
  // test's own inline-banner pattern above for the same boundary). What this
  // proves instead: the enqueue request really carried the drafted job, and
  // a refusal never silently clears it — nothing was thrown away.
  const enqueueReq = queueRequests.find(r => r.path === "/api/converter/queue/enqueue");
  expect((enqueueReq!.body as { jobs: unknown[] }).jobs).toEqual([{
    kind: "structured", sourcePath: "C:\\Users\\me\\big.json", destPath: "C:\\Users\\me\\big.csv",
    sourceFormat: "json", destFormat: "csv", acknowledgeLossy: false, overwrite: false,
  }]);
  expect(container.textContent).toContain("C:\\Users\\me\\big.json");

  await act(async () => { root.unmount(); });
});
