import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import Logs from "../src/pages/Logs";

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "IS_REACT_ACT_ENVIRONMENT", "ResizeObserver"] as const;
const SEARCH_HANDOFF_KEY = "ocx-m3:search-handoff";
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const originalFetch = globalThis.fetch;

const baseLog = {
  timestamp: 1_700_000_000_000,
  durationMs: 42,
  usageStatus: "reported" as const,
  displayMetrics: {
    tokPerSecond: { kind: "unavailable", reason: "invalid_duration" },
    cost: { kind: "unavailable", reason: "price_unmatched" },
  },
};

const logs = [
  {
    ...baseLog,
    requestId: "req-alpha",
    model: "gpt-one",
    provider: "openai",
    status: 200,
    usage: { inputTokens: 1200, outputTokens: 340 },
  },
  {
    ...baseLog,
    requestId: "req-beta",
    model: "sonnet-two",
    provider: "anthropic",
    status: 503,
    errorCode: "upstream_unavailable",
    usage: { inputTokens: 90, outputTokens: 12 },
  },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function installLayoutStubs(win: Window): void {
  const proto = win.HTMLElement.prototype as unknown as HTMLElement;
  Object.defineProperty(proto, "clientHeight", { configurable: true, get() { return 800; } });
  Object.defineProperty(proto, "clientWidth", { configurable: true, get() { return 1200; } });
  Object.defineProperty(proto, "offsetHeight", { configurable: true, get() { return 800; } });
  Object.defineProperty(proto, "offsetWidth", { configurable: true, get() { return 1200; } });
  Object.defineProperty(proto, "scrollHeight", { configurable: true, get() { return 800; } });
  Object.defineProperty(proto, "getBoundingClientRect", {
    configurable: true,
    value() {
      return {
        x: 0, y: 0, top: 0, left: 0, bottom: 800, right: 1200, width: 1200, height: 800,
        toJSON() { return this; },
      };
    },
  });

  class ResizeObserverStub {
    #cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) { this.#cb = cb; }
    observe(target: Element) {
      this.#cb(
        [{
          target,
          contentRect: {
            x: 0, y: 0, top: 0, left: 0, bottom: 800, right: 1200, width: 1200, height: 800,
            toJSON() { return this; },
          },
          borderBoxSize: [],
          contentBoxSize: [],
          devicePixelContentBoxSize: [],
        } as unknown as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    }
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: ResizeObserverStub });
  Object.defineProperty(win, "ResizeObserver", { configurable: true, value: ResizeObserverStub });
}

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#logs" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  installLayoutStubs(testWindow);
  jest.useFakeTimers({ now: 1_700_000_000_000 });
  globalThis.fetch = (async (input) => {
    if (!String(input).includes("/api/logs")) return new Response(null, { status: 404 });
    return jsonResponse(logs);
  }) as typeof fetch;
});

afterEach(() => {
  jest.useRealTimers();
  globalThis.fetch = originalFetch;
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function mountLogs(): Promise<{ root: Root; container: HTMLElement }> {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <Logs apiBase="http://localhost" />
      </LanguageProvider>,
    );
  });
  await act(async () => {
    jest.advanceTimersByTime(0);
    await Promise.resolve();
    await Promise.resolve();
  });
  return { root, container };
}

/**
 * React shadows `value` with an instance property so it can tell a real edit from
 * a programmatic assignment. Writing through the prototype setter bypasses that
 * tracker, which is what makes the dispatched `input` event look like typing.
 */
async function typeInto(el: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const proto = Object.getPrototypeOf(el) as HTMLInputElement;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
    el.dispatchEvent(new testWindow.Event("input", { bubbles: true }) as never);
  });
  await act(async () => {
    jest.advanceTimersByTime(0);
    await Promise.resolve();
  });
}

function searchInput(container: HTMLElement): HTMLInputElement {
  const el = container.querySelector<HTMLInputElement>('input[aria-label="Search logs"]');
  expect(el).not.toBeNull();
  return el!;
}

function requestIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".log-reqid")].map(node => node.textContent ?? "");
}

test("Logs: the primary search bar filters on request id, model, provider and status", async () => {
  const { root, container } = await mountLogs();

  expect(requestIds(container).sort()).toEqual(["req-alpha", "req-beta"]);

  await typeInto(searchInput(container), "anthropic");
  expect(requestIds(container)).toEqual(["req-beta"]);

  await typeInto(searchInput(container), "gpt-one");
  expect(requestIds(container)).toEqual(["req-alpha"]);

  await typeInto(searchInput(container), "503");
  expect(requestIds(container)).toEqual(["req-beta"]);

  await typeInto(searchInput(container), "req-ALPHA");
  expect(requestIds(container)).toEqual(["req-alpha"]);

  await typeInto(searchInput(container), "");
  expect(requestIds(container)).toHaveLength(2);

  await act(async () => { root.unmount(); });
});

test("Logs: plain text is the default and `.*` opts the same field into regex", async () => {
  const { root, container } = await mountLogs();

  // `gpt-one|sonnet` is a literal in plain-text mode, so it matches nothing.
  await typeInto(searchInput(container), "gpt-one|sonnet-two");
  expect(requestIds(container)).toHaveLength(0);
  expect(container.textContent).toContain("No requests match your search.");

  const regexChip = [...container.querySelectorAll<HTMLButtonElement>("button.m3-chip")]
    .find(btn => btn.textContent?.trim() === ".*");
  expect(regexChip).toBeTruthy();
  expect(regexChip!.getAttribute("aria-pressed")).toBe("false");

  await act(async () => { regexChip!.click(); });
  await act(async () => { jest.advanceTimersByTime(0); await Promise.resolve(); });

  expect(regexChip!.getAttribute("aria-pressed")).toBe("true");
  expect(requestIds(container).sort()).toEqual(["req-alpha", "req-beta"]);

  await act(async () => { root.unmount(); });
});

test("Logs: an invalid pattern reports itself instead of silently matching everything", async () => {
  const { root, container } = await mountLogs();

  const regexChip = [...container.querySelectorAll<HTMLButtonElement>("button.m3-chip")]
    .find(btn => btn.textContent?.trim() === ".*");
  await act(async () => { regexChip!.click(); });

  await typeInto(searchInput(container), "gpt-(one");

  const errorLine = container.querySelector("#logs-regex-error");
  expect(errorLine?.getAttribute("role")).toBe("alert");
  expect(errorLine?.textContent).toContain("Invalid pattern");
  expect(searchInput(container).getAttribute("aria-invalid")).toBe("true");
  // A pattern that cannot compile must not fall back to matching every row.
  expect(requestIds(container)).toHaveLength(0);

  await act(async () => { root.unmount(); });
});

test("Logs: an empty table distinguishes a narrowed search from a quiet server", async () => {
  const { root, container } = await mountLogs();

  // Requests exist, the search hid them: say so rather than claiming none arrived.
  await typeInto(searchInput(container), "no-such-request");
  expect(requestIds(container)).toHaveLength(0);
  expect(container.textContent).toContain("No requests match your search.");
  expect(container.textContent).not.toContain("No requests yet.");

  // A surface chip narrows the table just as a typed query does.
  await typeInto(searchInput(container), "");
  const surfaces = container.querySelector<HTMLElement>('[role="group"][aria-label="Surface"]');
  const claude = [...surfaces!.querySelectorAll<HTMLButtonElement>("button.m3-chip")][2];
  await act(async () => { claude.click(); });
  await act(async () => { jest.advanceTimersByTime(0); await Promise.resolve(); });
  expect(container.textContent).toContain("No requests match your search.");

  await act(async () => { root.unmount(); });
});

test("Logs: with nothing logged at all the empty state stays the quiet-server one", async () => {
  globalThis.fetch = (async (input) => {
    if (!String(input).includes("/api/logs")) return new Response(null, { status: 404 });
    return jsonResponse([]);
  }) as typeof fetch;
  const { root, container } = await mountLogs();

  await typeInto(searchInput(container), "anything");
  expect(container.textContent).toContain("No requests yet.");
  expect(container.textContent).not.toContain("No requests match your search.");

  await act(async () => { root.unmount(); });
});

test("Logs: the search row claims a pattern handed over by the regex builder", async () => {
  sessionStorage.setItem(SEARCH_HANDOFF_KEY, JSON.stringify({
    page: "logs", pattern: "gpt-one|sonnet-two", flags: "g", regex: true,
  }));

  const { root, container } = await mountLogs();

  expect(searchInput(container).value).toBe("gpt-one|sonnet-two");
  const regexChip = [...container.querySelectorAll<HTMLButtonElement>("button.m3-chip")]
    .find(btn => btn.textContent?.trim() === ".*");
  expect(regexChip!.getAttribute("aria-pressed")).toBe("true");
  // The alternation only matches both rows when it is read as a pattern.
  expect(requestIds(container).sort()).toEqual(["req-alpha", "req-beta"]);
  // One-shot: a claimed pattern must not re-filter the table on the next visit.
  expect(sessionStorage.getItem(SEARCH_HANDOFF_KEY)).toBeNull();

  await act(async () => { root.unmount(); });
});

test("Logs: a hand-off addressed to another screen is left alone", async () => {
  sessionStorage.setItem(SEARCH_HANDOFF_KEY, JSON.stringify({
    page: "notifications", pattern: "req-alpha", regex: true,
  }));

  const { root, container } = await mountLogs();

  expect(searchInput(container).value).toBe("");
  expect(requestIds(container)).toHaveLength(2);
  // Logs must not eat a pattern meant for another search bar on its way past.
  expect(sessionStorage.getItem(SEARCH_HANDOFF_KEY)).not.toBeNull();

  await act(async () => { root.unmount(); });
});

test("Logs: the search bar carries a regex-builder shortcut", async () => {
  const { root, container } = await mountLogs();

  const builder = container.querySelector<HTMLAnchorElement>('a[href="#regex"]');
  expect(builder).not.toBeNull();
  expect(builder!.getAttribute("aria-label")).toBe("Open regex builder");

  await act(async () => { root.unmount(); });
});

test("Logs: the surface filter is a named group of filter chips", async () => {
  const { root, container } = await mountLogs();

  const group = container.querySelector<HTMLElement>('[role="group"][aria-label="Surface"]');
  expect(group).not.toBeNull();
  const chips = [...group!.querySelectorAll<HTMLButtonElement>("button.m3-chip")];
  expect(chips.map(c => c.textContent)).toEqual(["All", "Codex", "Claude", "Grok"]);
  expect(chips[0].getAttribute("aria-pressed")).toBe("true");

  // req-alpha and req-beta both carry no `surface`, so they are Codex requests.
  await act(async () => { chips[2].click(); });
  await act(async () => { jest.advanceTimersByTime(0); await Promise.resolve(); });
  expect(chips[2].getAttribute("aria-pressed")).toBe("true");
  expect(chips[0].getAttribute("aria-pressed")).toBe("false");
  expect(requestIds(container)).toHaveLength(0);

  await act(async () => { chips[1].click(); });
  await act(async () => { jest.advanceTimersByTime(0); await Promise.resolve(); });
  expect(requestIds(container)).toHaveLength(2);

  await act(async () => { root.unmount(); });
});

test("Logs: the Tokens column reads as an input/output split with a cache line", async () => {
  const { root, container } = await mountLogs();

  // Rows render newest-first, so address the cell by its row's request id.
  const cells = new Map([...container.querySelectorAll<HTMLTableRowElement>("tbody tr")]
    .filter(row => row.querySelector(".log-reqid"))
    .map(row => [
      row.querySelector(".log-reqid")?.textContent ?? "",
      row.querySelector<HTMLElement>("td.log-col-tokens")?.textContent ?? "",
    ]));

  expect(cells.get("req-alpha")).toContain("1200 in");
  expect(cells.get("req-alpha")).toContain("340 out");
  expect(cells.get("req-alpha")).toContain("no cache data");
  expect(cells.get("req-beta")).toContain("90 in");
  expect(cells.get("req-beta")).toContain("12 out");

  await act(async () => { root.unmount(); });
});
