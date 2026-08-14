/**
 * `shell/Markdown.tsx` — the app's one shared, isolated Markdown renderer.
 *
 * Covers every construct the bundled documentation corpus actually uses
 * (headings, inline formatting, fenced code, lists, blockquotes, tables,
 * links, `:::` asides) and, separately, the safety property the whole
 * component exists for: text that LOOKS like HTML never becomes live DOM.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import Markdown, { slugifyHeading, type MarkdownLinkTarget } from "../src/shell/Markdown";
import { TestLanguageProvider } from "./helpers/providers";

const globals = ["document", "window", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function mount(text: string, onInternalLink?: (t: MarkdownLinkTarget) => void): Promise<{ container: HTMLElement; root: Root }> {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <TestLanguageProvider>
        <Markdown text={text} onInternalLink={onInternalLink} />
      </TestLanguageProvider>,
    );
  });
  return { container, root };
}

describe("block-level constructs", () => {
  test("a level-1 Markdown heading renders as h2 — the article's own title stays the page's only h1", async () => {
    const { container, root } = await mount("# Web Dashboard\n\nSome text.");
    const h2 = container.querySelector("h2.m3-md-heading");
    expect(h2?.textContent).toBe("Web Dashboard");
    expect(container.querySelector("h1")).toBeNull();
    await act(async () => { root.unmount(); });
  });

  test("headings carry a slugified id for anchor navigation", async () => {
    const { container, root } = await mount("## Remote access and admission keys");
    const h3 = container.querySelector("h3.m3-md-heading");
    expect(h3?.id).toBe("remote-access-and-admission-keys");
    await act(async () => { root.unmount(); });
  });

  test("fenced code block renders as <pre><code class=\"language-x\">, verbatim, unformatted", async () => {
    const { container, root } = await mount('```json\n{\n  "openai": {\n    "authMode": "forward"\n  }\n}\n```');
    const code = container.querySelector("pre.m3-md-pre code");
    expect(code?.className).toBe("language-json");
    expect(code?.textContent).toBe('{\n  "openai": {\n    "authMode": "forward"\n  }\n}');
    await act(async () => { root.unmount(); });
  });

  test("an unordered list renders <li> per item, an ordered list renders <ol>", async () => {
    const { container, root } = await mount("- one\n- two\n- three");
    const items = [...container.querySelectorAll("ul.m3-md-list > li")].map(li => li.textContent);
    expect(items).toEqual(["one", "two", "three"]);
    await act(async () => { root.unmount(); });

    const { container: c2, root: r2 } = await mount("1. first\n2. second");
    expect(c2.querySelector("ol.m3-md-list")).not.toBeNull();
    expect([...c2.querySelectorAll("ol.m3-md-list > li")].map(li => li.textContent)).toEqual(["first", "second"]);
    await act(async () => { r2.unmount(); });
  });

  test("a nested list renders a second list inside its parent item", async () => {
    const { container, root } = await mount("- outer one\n  - inner a\n  - inner b\n- outer two");
    const outerItems = container.querySelectorAll(":scope > ul.m3-md-list > li");
    expect(outerItems.length).toBe(2);
    const nested = outerItems[0]!.querySelector("ul.m3-md-list");
    expect(nested).not.toBeNull();
    expect([...nested!.querySelectorAll("li")].map(li => li.textContent)).toEqual(["inner a", "inner b"]);
    await act(async () => { root.unmount(); });
  });

  test("a blockquote renders as <blockquote> and can itself contain a paragraph", async () => {
    const { container, root } = await mount("> Quoted line one.\n> Quoted line two.");
    const quote = container.querySelector("blockquote.m3-md-quote");
    expect(quote?.textContent).toContain("Quoted line one. Quoted line two.");
    await act(async () => { root.unmount(); });
  });

  test("a horizontal rule renders as <hr>, distinct from a table separator row", async () => {
    const { container, root } = await mount("Above.\n\n---\n\nBelow.");
    expect(container.querySelectorAll("hr.m3-md-hr").length).toBe(1);
    const paragraphs = [...container.querySelectorAll("p.m3-md-p")].map(p => p.textContent);
    expect(paragraphs).toEqual(["Above.", "Below."]);
    await act(async () => { root.unmount(); });
  });

  test("a pipe table renders headers, aligned cells, and body rows", async () => {
    const { container, root } = await mount(
      "| Provider | Base URL |\n| --- | ---: |\n| `openai` | `https://api.openai.com/v1` |\n| `anthropic` | `https://api.anthropic.com` |",
    );
    const table = container.querySelector("table.m3-md-table");
    expect(table).not.toBeNull();
    const headers = [...table!.querySelectorAll("thead th")].map(th => th.textContent);
    expect(headers).toEqual(["Provider", "Base URL"]);
    const secondHeader = table!.querySelector("thead th:nth-child(2)") as HTMLElement;
    expect(secondHeader.style.textAlign).toBe("right");
    const rows = [...table!.querySelectorAll("tbody tr")].map(tr => [...tr.querySelectorAll("td")].map(td => td.textContent));
    expect(rows).toEqual([["openai", "https://api.openai.com/v1"], ["anthropic", "https://api.anthropic.com"]]);
    await act(async () => { root.unmount(); });
  });

  test(":::tip[Title] renders the given title; a bare :::note falls back to the translated default title", async () => {
    const { container, root } = await mount(':::tip[What this costs you]\nBody text.\n:::\n\n:::note\nAnother body.\n:::');
    const asides = [...container.querySelectorAll(".m3-md-aside")];
    expect(asides.length).toBe(2);
    expect(asides[0]!.classList.contains("m3-md-aside--tip")).toBe(true);
    expect(asides[0]!.querySelector(".m3-md-aside-title")?.textContent).toBe("What this costs you");
    expect(asides[1]!.classList.contains("m3-md-aside--note")).toBe(true);
    expect(asides[1]!.querySelector(".m3-md-aside-title")?.textContent).toBe("Note");
    await act(async () => { root.unmount(); });
  });
});

describe("inline formatting", () => {
  test("bold, inline code, and bold-containing-code all render as the right elements", async () => {
    const { container, root } = await mount("Set **`authMode`: `forward`** to enable it.");
    const strong = container.querySelector("p.m3-md-p strong");
    expect(strong).not.toBeNull();
    expect(strong!.querySelectorAll("code").length).toBe(2);
    expect(strong!.textContent).toBe("authMode: forward");
    await act(async () => { root.unmount(); });
  });

  test("*italic* renders as <em>; a snake_case identifier is left completely alone", async () => {
    const { container, root } = await mount("This is *emphasised*, unlike `model_provider` or OPENCODEX_DEBUG_SANDBOX.");
    const em = container.querySelector("p.m3-md-p em");
    expect(em?.textContent).toBe("emphasised");
    // The whole point of not treating `_..._` as emphasis: no <em> swallows
    // half of an identifier that merely contains an underscore.
    expect(container.querySelector("p.m3-md-p")?.textContent).toContain("OPENCODEX_DEBUG_SANDBOX");
    expect(container.querySelectorAll("em").length).toBe(1);
    await act(async () => { root.unmount(); });
  });
});

describe("links", () => {
  test("an internal link (leading '/') calls onInternalLink and never performs a real navigation", async () => {
    const seen: MarkdownLinkTarget[] = [];
    const { container, root } = await mount("See [the dashboard](/guides/web-dashboard/#remote-access-and-admission-keys).", t => seen.push(t));
    const a = container.querySelector("a")!;
    expect(a.getAttribute("href")).toBe("/guides/web-dashboard/#remote-access-and-admission-keys");
    expect(a.hasAttribute("target")).toBe(false);

    await act(async () => {
      a.dispatchEvent(new testWindow.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(seen).toEqual([{ internal: true, href: "/guides/web-dashboard/#remote-access-and-admission-keys" }]);
    await act(async () => { root.unmount(); });
  });

  test("an external link opens in a new tab with rel=noreferrer and carries the external-link icon", async () => {
    const { container, root } = await mount("See [ollama.com](https://ollama.com/settings/keys).");
    const a = container.querySelector("a")!;
    expect(a.getAttribute("href")).toBe("https://ollama.com/settings/keys");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noreferrer noopener");
    expect(a.querySelector("svg")).not.toBeNull();
    await act(async () => { root.unmount(); });
  });
});

describe("isolation / safety", () => {
  test("text that looks like a <script> tag renders as inert visible text, never as a live element", async () => {
    const { container, root } = await mount('A malicious body might contain <script>alert(1)</script> as plain text.');
    expect(container.querySelectorAll("script").length).toBe(0);
    expect(container.textContent).toContain("<script>alert(1)</script>");
    await act(async () => { root.unmount(); });
  });

  test("an image tag with an onerror handler renders as inert text, never as a live <img>", async () => {
    const { container, root } = await mount('<img src=x onerror="alert(1)">');
    expect(container.querySelectorAll("img").length).toBe(0);
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
    await act(async () => { root.unmount(); });
  });
});

describe("slugifyHeading", () => {
  test("matches the corpus's real anchor targets", () => {
    expect(slugifyHeading("Remote access and admission keys")).toBe("remote-access-and-admission-keys");
    expect(slugifyHeading("`providers[<name>].accountPool` (experimental)")).toBe("providersnameaccountpool-experimental");
  });
});
