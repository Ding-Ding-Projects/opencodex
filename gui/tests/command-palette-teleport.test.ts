/**
 * Landing on the exact element a palette result named — the DOM half of the
 * teleport, tested against a real (if minimal) document rather than through
 * the whole `CommandPalette` component, so a failure here says "the label
 * search is wrong" instead of "something in a 600-line component broke".
 *
 * `happy-dom` is the same DOM implementation the component tests already use.
 * It does not implement `scrollIntoView`, which is exactly why
 * `highlightAndFocus` calls it through an optional chain rather than assuming
 * every environment has it — these tests are what would have caught that if
 * it had been missing.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

import {
  PALETTE_HIGHLIGHT_MS, findLabeledElement, highlightAndFocus, teleportToSetting, waitForLabeledElement,
} from "../src/shell/command-palette-teleport";

const domGlobals = ["document", "window", "HTMLElement", "Node", "matchMedia"] as const;
let previous: Record<(typeof domGlobals)[number], unknown>;
let testWindow: Window;

beforeEach(() => {
  previous = Object.fromEntries(domGlobals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previous;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    HTMLElement: { configurable: true, value: testWindow.HTMLElement },
    Node: { configurable: true, value: testWindow.Node },
    matchMedia: { configurable: true, value: undefined },
  });
});

afterEach(async () => {
  for (const key of domGlobals) Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
  await testWindow.happyDOM?.close?.();
});

function setBody(html: string): void {
  testWindow.document.body.innerHTML = html;
}

describe("findLabeledElement", () => {
  test("picks the exact-match leaf over a wrapper that merely contains the text", () => {
    setBody(`
      <div class="m3-field">
        <span class="m3-field-label">Theme</span>
        <p class="m3-field-hint">Theme of the whole app, light or dark</p>
      </div>
    `);
    const found = findLabeledElement(testWindow.document as unknown as ParentNode, "Theme");
    expect(found?.tagName).toBe("SPAN");
    expect(found?.textContent?.trim()).toBe("Theme");
  });

  test("falls back to the smallest containing element when no exact leaf exists", () => {
    // A `Toggle`'s visible label sits beside the control rather than wrapping
    // it — see `narrator.enable` in the real app — so the row itself is the
    // best a text search can do.
    setBody(`
      <div class="m3-row">
        <span>Enable narrator, off by default</span>
        <button role="switch" aria-checked="false"></button>
      </div>
    `);
    const found = findLabeledElement(testWindow.document as unknown as ParentNode, "Enable narrator");
    expect(found?.tagName).toBe("SPAN");
    expect(found?.textContent).toContain("Enable narrator");
  });

  test("an empty label finds nothing rather than matching everything", () => {
    setBody(`<div class="m3-field"><span>Theme</span></div>`);
    expect(findLabeledElement(testWindow.document as unknown as ParentNode, "   ")).toBeNull();
  });

  test("a label nobody rendered finds nothing", () => {
    setBody(`<div class="m3-field"><span>Theme</span></div>`);
    expect(findLabeledElement(testWindow.document as unknown as ParentNode, "Density")).toBeNull();
  });

  test("hidden and aria-hidden elements are not candidates, even when their text matches exactly", () => {
    setBody(`
      <div class="m3-field">
        <span hidden>Theme</span>
        <span aria-hidden="true">Theme</span>
        <span class="m3-field-label">Theme</span>
      </div>
    `);
    const found = findLabeledElement(testWindow.document as unknown as ParentNode, "Theme");
    expect(found?.className).toBe("m3-field-label");
  });

  test("scopes to the given root, not the whole document", () => {
    setBody(`
      <div id="other"><span>Theme</span></div>
      <div id="scope"><span>Density</span></div>
    `);
    const scope = testWindow.document.getElementById("scope")!;
    expect(findLabeledElement(scope as unknown as ParentNode, "Theme")).toBeNull();
    expect(findLabeledElement(scope as unknown as ParentNode, "Density")).not.toBeNull();
  });
});

describe("highlightAndFocus", () => {
  test("highlights the nearest row-like ancestor, not the bare label span", () => {
    setBody(`
      <div class="m3-field" id="row">
        <span class="m3-field-label" id="label">Density</span>
        <input id="ctl" type="range" />
      </div>
    `);
    const label = testWindow.document.getElementById("label") as unknown as HTMLElement;
    const row = testWindow.document.getElementById("row") as unknown as HTMLElement;

    highlightAndFocus(label, { reducedMotion: true });

    expect(row.classList.contains("m3-command-palette-highlight")).toBe(true);
    expect(label.classList.contains("m3-command-palette-highlight")).toBe(false);
  });

  test("hands focus to the real control inside the row, not the label", () => {
    setBody(`
      <div class="m3-field">
        <span id="label">Density</span>
        <input id="ctl" type="range" />
      </div>
    `);
    const label = testWindow.document.getElementById("label") as unknown as HTMLElement;
    const ctl = testWindow.document.getElementById("ctl") as unknown as HTMLElement;

    highlightAndFocus(label, { reducedMotion: true });

    expect(testWindow.document.activeElement).toBe(ctl as unknown as Element);
  });

  test("with no real control in the row, the label itself becomes focusable and is released on blur", () => {
    setBody(`<div class="m3-row"><span id="label">Auto-start Codex</span></div>`);
    const label = testWindow.document.getElementById("label") as unknown as HTMLElement;

    highlightAndFocus(label, { reducedMotion: true });

    expect(testWindow.document.activeElement).toBe(label as unknown as Element);
    expect(label.getAttribute("tabindex")).toBe("-1");

    label.dispatchEvent(new testWindow.Event("blur", { bubbles: false }) as unknown as Event);
    expect(label.hasAttribute("tabindex")).toBe(false);
  });

  test("a label that already had its own tabindex keeps it after blur — teleporting never removes state it did not add", () => {
    setBody(`<div class="m3-row"><span id="label" tabindex="0">Auto-start Codex</span></div>`);
    const label = testWindow.document.getElementById("label") as unknown as HTMLElement;

    highlightAndFocus(label, { reducedMotion: true });
    label.dispatchEvent(new testWindow.Event("blur", { bubbles: false }) as unknown as Event);

    expect(label.getAttribute("tabindex")).toBe("0");
  });

  test("the highlight clears after the documented duration, through the injectable clock", () => {
    setBody(`<div class="m3-field" id="row"><span id="label">Theme</span></div>`);
    const label = testWindow.document.getElementById("label") as unknown as HTMLElement;
    const row = testWindow.document.getElementById("row") as unknown as HTMLElement;

    let capturedMs = 0;
    let run: (() => void) | null = null;
    highlightAndFocus(label, {
      reducedMotion: true,
      clearAfter: (fn, ms) => { run = fn; capturedMs = ms; },
    });

    expect(row.classList.contains("m3-command-palette-highlight")).toBe(true);
    expect(capturedMs).toBe(PALETTE_HIGHLIGHT_MS);
    run!();
    expect(row.classList.contains("m3-command-palette-highlight")).toBe(false);
  });
});

describe("waitForLabeledElement", () => {
  test("resolves immediately when the element is already there", async () => {
    setBody(`<div><span>Theme</span></div>`);
    const found = await waitForLabeledElement(
      () => testWindow.document as unknown as ParentNode,
      "Theme",
      { schedule: fn => fn() },
    );
    expect(found?.textContent).toBe("Theme");
  });

  test("retries until the root exists and renders the label — the real shape of an opened tab mounting", async () => {
    let attempt = 0;
    const getRoot = () => {
      attempt += 1;
      // Nothing for the first two polls (the tab has not mounted yet), a
      // container with no matching content on the third, the real content
      // from the fourth attempt on.
      if (attempt < 3) return null;
      if (attempt === 3) { setBody(`<div id="page"></div>`); return testWindow.document.getElementById("page") as unknown as ParentNode; }
      const page = testWindow.document.getElementById("page")!;
      page.innerHTML = `<span>Density</span>`;
      return page as unknown as ParentNode;
    };

    const found = await waitForLabeledElement(getRoot, "Density", { schedule: fn => fn() });
    expect(found?.textContent).toBe("Density");
    expect(attempt).toBeGreaterThanOrEqual(4);
  });

  test("gives up after the attempt bound and reports nothing found, rather than polling forever", async () => {
    let calls = 0;
    const found = await waitForLabeledElement(
      () => { calls += 1; return null; },
      "Never rendered",
      { schedule: fn => fn(), maxAttempts: 5 },
    );
    expect(found).toBeNull();
    // One initial attempt plus five retries.
    expect(calls).toBe(6);
  });
});

describe("teleportToSetting", () => {
  test("opens the target page, then finds and highlights the row once it renders", async () => {
    const opened: string[] = [];
    setBody(`<div id="page"></div>`);

    const result = await teleportToSetting(
      { page: "storage", label: "Cleanup on startup" },
      {
        openPage: page => {
          opened.push(page);
          // Simulates the React re-render `tabs.openPage` triggers: the target
          // page's row appears only after the call returns.
          testWindow.document.getElementById("page")!.innerHTML = `<div class="m3-field"><span>Cleanup on startup</span></div>`;
        },
        getRoot: () => testWindow.document.getElementById("page") as unknown as ParentNode,
        wait: { schedule: fn => fn() },
        highlight: { reducedMotion: true, clearAfter: () => {} },
      },
    );

    expect(opened).toEqual(["storage"]);
    expect(result?.textContent).toBe("Cleanup on startup");
    expect(result?.parentElement?.classList.contains("m3-command-palette-highlight")).toBe(true);
  });

  test("a row that never renders resolves to null rather than throwing", async () => {
    setBody(`<div id="page"></div>`);
    const result = await teleportToSetting(
      { page: "storage", label: "Never rendered" },
      {
        openPage: () => {},
        getRoot: () => testWindow.document.getElementById("page") as unknown as ParentNode,
        wait: { schedule: fn => fn(), maxAttempts: 3 },
      },
    );
    expect(result).toBeNull();
  });
});
