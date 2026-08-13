/**
 * Storage screen structure, against the Material 3 prototype.
 *
 * Three things the prototype has and a refactor loses quietly: the Archived stat
 * card with its file-count hint, the live cleanup estimate that follows the
 * slider (so the user knows what a percentage costs before previewing), and the
 * settings-search row over the auto-cleanup policy — which must actually filter
 * *this* card and report a hit that lives on the Archived cleanup card instead
 * of pretending nothing matched.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import Storage from "../src/pages/Storage";
import { TestLanguageProvider } from "./helpers/providers";
import { NotificationsProvider } from "../src/shell/notifications";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const originalFetch = globalThis.fetch;

const GiB = 1024 ** 3;

const REPORT = {
  codexHome: "/tmp/codex-home",
  generatedAt: 1,
  total: { bytes: 8 * 1024 * 1024, fileCount: 60 },
  buckets: [
    { key: "sessions", label: "Active sessions", bytes: 4 * 1024 * 1024, fileCount: 20 },
    { key: "archived_sessions", label: "Archived sessions", bytes: 4 * 1024 * 1024, fileCount: 40 },
  ],
};

const POLICY = {
  enabled: false,
  trigger: { archivedBytesOver: 5 * GiB },
  target: { removeOldestPercent: 25 },
  schedule: "manual",
  mode: "quarantine",
};

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/storage/trash")) return Response.json({ entries: [] });
    if (url.includes("/api/storage/cleanup-policy")) return Response.json(POLICY);
    if (url.includes("/api/storage")) return Response.json(REPORT);
    return new Response(null, { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

/**
 * React shadows `value` with an instance property so it can tell a real edit from
 * a programmatic assignment. Writing through the prototype setter bypasses that
 * tracker, which is what makes the dispatched event look like typing.
 */
function typeInto(el: HTMLInputElement, value: string): void {
  const proto = Object.getPrototypeOf(el) as HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  el.dispatchEvent(new testWindow.Event("input", { bubbles: true }) as never);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise<void>(resolve => testWindow.setTimeout(resolve, 0));
    });
  }
}

async function mount(): Promise<{ container: HTMLElement; root: Root }> {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <TestLanguageProvider>
        <NotificationsProvider>
          <Storage apiBase="http://api" />
        </NotificationsProvider>
      </TestLanguageProvider>,
    );
  });
  await settle();
  return { container, root };
}

test("the Archived stat card carries its size and file-count hint", async () => {
  const { container, root } = await mount();
  try {
    const text = container.textContent ?? "";
    expect(text).toContain("Archived");
    // 40 archived files, reported as the card's hint rather than left implicit.
    expect(text).toContain("40 files");
    expect(text).toContain("/tmp/codex-home");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("the cleanup estimate follows the slider without asking the server", async () => {
  const { container, root } = await mount();
  try {
    // Default 25% of 40 archived files.
    expect(container.textContent).toContain("10 archived file(s)");

    const slider = container.querySelector<HTMLInputElement>("#storage-cleanup-percent");
    expect(slider).not.toBeNull();
    await act(async () => { typeInto(slider!, "50"); });

    expect(container.textContent).toContain("20 archived file(s)");
    expect(container.textContent).not.toContain("10 archived file(s)");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("the Preview and clean action carries a leading mark, like the prototype's", async () => {
  const { container, root } = await mount();
  try {
    const button = [...container.querySelectorAll<HTMLButtonElement>("button.m3-btn")]
      .find(b => (b.textContent ?? "").includes("Preview and clean"));
    expect(button).toBeDefined();
    // The prototype leads this button with a glyph. The label is what says what
    // the button does; the mark must never be the only thing carrying it, and it
    // is hidden from assistive tech precisely because it is decoration.
    const mark = button!.querySelector("svg");
    expect(mark).not.toBeNull();
    expect(mark!.getAttribute("aria-hidden")).toBe("true");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("the settings search filters the policy card and points at hits on the other card", async () => {
  const { container, root } = await mount();
  try {
    const search = container.querySelector<HTMLInputElement>('input[type="search"]');
    expect(search).not.toBeNull();
    expect(container.textContent).toContain("Trigger when archived size exceeds");

    await act(async () => { typeInto(search!, "schedule"); });
    // The matching field stays; a non-matching one on the same card goes away.
    expect(container.textContent).toContain("Schedule");
    expect(container.textContent).not.toContain("Trigger when archived size exceeds");

    // "permanent" matches the policy's deletion mode *and* the cleanup card's
    // permanent-delete switch — the second must be reported, not swallowed.
    await act(async () => { typeInto(search!, "permanently"); });
    expect(container.textContent).toContain("Archived cleanup");
    expect(container.textContent).toContain("match(es) on other");

    await act(async () => { typeInto(search!, "zzzznothing"); });
    expect(container.textContent).toContain("No settings match on this surface.");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("regex search stays opt-in and an invalid pattern is reported, not thrown", async () => {
  const { container, root } = await mount();
  try {
    const search = container.querySelector<HTMLInputElement>('input[type="search"]');
    // Plain text by default: a regex metacharacter is matched literally, so this
    // finds nothing rather than matching every setting.
    await act(async () => { typeInto(search!, ".*"); });
    expect(container.textContent).toContain("No settings match on this surface.");

    const regexChip = [...container.querySelectorAll<HTMLButtonElement>("button.m3-chip")]
      .find(b => b.textContent === ".*");
    expect(regexChip).toBeDefined();
    await act(async () => { regexChip!.click(); });
    expect(regexChip!.getAttribute("aria-pressed")).toBe("true");
    expect(container.textContent).toContain("Schedule");

    await act(async () => { typeInto(search!, "(unclosed"); });
    expect(container.textContent).toContain("Invalid pattern");
    expect(search!.getAttribute("aria-invalid")).toBe("true");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
