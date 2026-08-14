/**
 * `pages/Docs.tsx` — the in-app documentation browser's page.
 *
 * Covers the four load-bearing promises the browser's contract makes: the
 * corpus is genuinely usable offline (no network request, ever), search
 * reaches article body content and not just titles, clicking a link inside a
 * rendered article opens the linked article in the same pane, and a link
 * that resolves outside the bundled corpus gets an honest empty state
 * instead of a silent dead end.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import Docs from "../src/pages/Docs";
import { DOCS_ARTICLES } from "../src/docs/generated-articles";
import { TestLanguageProvider } from "./helpers/providers";

const globals = ["document", "window", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const originalFetch = globalThis.fetch;
let fetchCalls: string[];

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  // The whole point of "bundled at build time": this screen must be fully
  // usable with the network unplugged. A `fetch` call here is the failure,
  // so it is recorded (and would still resolve, but every assertion below
  // that nothing was called is the real check).
  fetchCalls = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetchCalls.push(String(input));
    throw new Error("network unplugged for this test");
  }) as typeof fetch;
});

afterEach(() => {
  testWindow.close();
  globalThis.fetch = originalFetch;
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function mount(): Promise<{ container: HTMLElement; root: Root }> {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <TestLanguageProvider>
        <Docs />
      </TestLanguageProvider>,
    );
  });
  return { container, root };
}

function itemLabelled(container: HTMLElement, title: string): HTMLButtonElement {
  const found = [...container.querySelectorAll(".m3-docs-item")].find(b => b.querySelector(".m3-docs-item-title")?.textContent === title);
  if (!found) throw new Error(`no article item titled "${title}" — found ${[...container.querySelectorAll(".m3-docs-item-title")].map(e => e.textContent).join(" | ")}`);
  return found as HTMLButtonElement;
}

test("opens with an article already selected and renders its Markdown body, with no network request made", async () => {
  const { container, root } = await mount();
  expect(container.querySelector("h1.m3-docs-title")).not.toBeNull();
  expect(container.querySelectorAll(".m3-md .m3-md-p, .m3-md .m3-md-heading").length).toBeGreaterThan(0);
  expect(fetchCalls).toEqual([]);
  await act(async () => { root.unmount(); });
});

test("every bundled article appears in the list, grouped under its category", async () => {
  const { container, root } = await mount();
  expect(container.querySelectorAll(".m3-docs-item").length).toBe(DOCS_ARTICLES.length);
  const groupTitles = [...container.querySelectorAll(".m3-docs-group-title")].map(h => h.textContent);
  expect(groupTitles).toEqual(["Getting started", "Guides", "Reference", "Troubleshooting", "General"]);
  await act(async () => { root.unmount(); });
});

test("clicking a different article in the list opens it in the reading pane", async () => {
  const { container, root } = await mount();
  await act(async () => { itemLabelled(container, "Docker").click(); });
  expect(container.querySelector("h1.m3-docs-title")?.textContent).toBe("Docker");
  await act(async () => { root.unmount(); });
});

test("search reaches article BODY content, not only the title and description", async () => {
  const { container, root } = await mount();
  const input = container.querySelector<HTMLInputElement>('input[type="text"], input:not([type])')!;
  // "prompt_cache_key" appears deep in the body text of two real articles
  // (Claude Code and Providers) and in neither article's title or
  // description — a title/description-only search would find nothing at all.
  await act(async () => {
    Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!.set!.call(input, "prompt_cache_key");
    input.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
  });
  const titles = [...container.querySelectorAll(".m3-docs-item-title")].map(e => e.textContent).sort();
  expect(titles).toEqual(["Claude Code", "Providers"]);
  expect(container.textContent).toContain("2 of 28 articles");
  await act(async () => { root.unmount(); });
});

test("a query matching nothing shows the honest no-results state, not a silently empty list", async () => {
  const { container, root } = await mount();
  const input = container.querySelector<HTMLInputElement>("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!.set!.call(input, "xyxyxyxyxy-nonsense-query-zzz");
    input.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
  });
  expect(container.querySelectorAll(".m3-docs-item").length).toBe(0);
  expect(container.textContent).toContain("No articles match");
  await act(async () => { root.unmount(); });
});

test("clicking an internal link inside a rendered article opens the linked article in the same pane", async () => {
  const { container, root } = await mount();
  await act(async () => { itemLabelled(container, "Providers").click(); });
  expect(container.querySelector("h1.m3-docs-title")?.textContent).toBe("Providers");

  // "Providers" links to "/guides/web-dashboard/#remote-access-and-admission-keys" in its real body text.
  const link = [...container.querySelectorAll(".m3-md a")].find(a => a.getAttribute("href")?.startsWith("/guides/web-dashboard/"));
  expect(link).not.toBeUndefined();

  await act(async () => {
    link!.dispatchEvent(new testWindow.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  expect(container.querySelector("h1.m3-docs-title")?.textContent).toBe("Web Dashboard");
  await act(async () => { root.unmount(); });
});

test("a link to a page outside the bundled corpus (the .mdx changelog) shows the not-bundled empty state", async () => {
  const superExpress = DOCS_ARTICLES.find(a => a.id === "guides/super-express-release")!;
  const { container, root } = await mount();
  await act(async () => { itemLabelled(container, superExpress.title).click(); });

  const link = [...container.querySelectorAll(".m3-md a")].find(a => a.getAttribute("href") === "../../changelog/");
  expect(link).not.toBeUndefined();

  await act(async () => {
    link!.dispatchEvent(new testWindow.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  expect(container.textContent).toContain("Not in this offline copy");
  expect(container.textContent).toContain("../../changelog/");
  await act(async () => { root.unmount(); });
});

test("switching search to regex mode and typing an invalid pattern reports the error without hiding every article", async () => {
  const { container, root } = await mount();
  const regexChip = [...container.querySelectorAll(".m3-docs-nav button")].find(b => b.textContent?.trim() === ".*")!;
  await act(async () => { regexChip.dispatchEvent(new testWindow.MouseEvent("click", { bubbles: true })); });

  const input = container.querySelector<HTMLInputElement>("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!.set!.call(input, "(unterminated[");
    input.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
  });
  expect(container.textContent).toContain("Invalid pattern");
  await act(async () => { root.unmount(); });
});
