/**
 * The "On this page" search bar, and the one thing about it that is easy to get
 * wrong twice.
 *
 * Starlight renders two tables of contents — a sidebar and a narrow-width
 * dropdown — and at some widths both are in the DOM at once. Each gets its own
 * copy of the search island, and each must filter *its own* list.
 *
 * The first version did not. Astro wraps a hydrated island in `<astro-island>`,
 * so the island's `parentElement` is that wrapper and the list is its sibling;
 * the scoped lookup missed, fell through to a `document.querySelector`, and both
 * copies then pointed at whichever list came first in the document. Nothing threw
 * and nothing looked broken — typing in the dropdown just quietly filtered the
 * sidebar behind it.
 *
 * So the invariant worth pinning is structural: each `.m3-toc-host` contains an
 * island *and* the table of contents that island is for. The runtime lookup
 * scopes to that wrapper, so as long as the pairing holds, the wrong-list bug
 * cannot come back.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src", "components");

describe("the island", () => {
  const source = readFileSync(join(SRC, "TocSearch.tsx"), "utf-8");

  test("scopes to its own wrapper and never reaches across the page", () => {
    expect(source).toContain(`host.closest<HTMLElement>(".m3-toc-host")`);
    // The fallback is the bug. A document-wide lookup is how one copy ends up
    // filtering the other's list, so its absence is the assertion.
    expect(source).not.toContain("document.querySelector<HTMLElement>(rootSelector)");
  });

  test("un-hides everything when it goes away", () => {
    // A reader must never be left with a table of contents missing most of its
    // entries because an island unmounted mid-filter.
    expect(source).toContain("return () => { for (const entry of entries) entry.li.hidden = false; };");
  });

  test("says nothing on a page with nothing to search", () => {
    expect(source).toContain("if (entries.length < 2) return null;");
  });
});

describe("both overrides exist and are wired", () => {
  const config = readFileSync(join(ROOT, "astro.config.mjs"), "utf-8");

  test("Starlight is told about both tables of contents", () => {
    expect(config).toContain(`TableOfContents: "./src/components/TableOfContents.astro"`);
    expect(config).toContain(`MobileTableOfContents: "./src/components/MobileTableOfContents.astro"`);
  });

  test("each override targets the element it actually owns", () => {
    const desktop = readFileSync(join(SRC, "TableOfContents.astro"), "utf-8");
    const mobile = readFileSync(join(SRC, "MobileTableOfContents.astro"), "utf-8");
    expect(desktop).toContain(`rootSelector="starlight-toc ul"`);
    expect(mobile).toContain(`rootSelector="mobile-starlight-toc ul"`);
    // Each renders Starlight's own component rather than reimplementing it, so
    // the scroll-spy and its anchors stay Starlight's problem.
    expect(desktop).toContain("@astrojs/starlight/components/TableOfContents.astro");
    expect(mobile).toContain("@astrojs/starlight/components/MobileTableOfContents.astro");
  });
});

describe("the built pages", () => {
  const page = join(ROOT, "dist", "guides", "launcher-and-terminal", "index.html");

  test.skipIf(!existsSync(page))("each host holds its own island and its own list", () => {
    const html = readFileSync(page, "utf-8");
    const hosts = [...html.matchAll(/<div class="m3-toc-host[^"]*"[\s\S]*?(?=<div class="m3-toc-host|$)/g)]
      .map(match => match[0]);

    // Two: the sidebar and the dropdown. If this ever reads 1, one override
    // stopped rendering and half the pages lost their search with no error.
    expect(hosts).toHaveLength(2);

    const mobile = hosts.find(h => /m3-toc-host--mobile/.test(h.slice(0, 200)));
    const desktop = hosts.find(h => !/m3-toc-host--mobile/.test(h.slice(0, 200)));
    expect(mobile).toBeDefined();
    expect(desktop).toBeDefined();

    // The pairing the runtime lookup depends on.
    expect(/astro-island/.test(mobile!)).toBe(true);
    expect(/<mobile-starlight-toc/.test(mobile!)).toBe(true);
    expect(/<starlight-toc/.test(mobile!)).toBe(false);

    expect(/astro-island/.test(desktop!)).toBe(true);
    expect(/<starlight-toc/.test(desktop!)).toBe(true);
    expect(/<mobile-starlight-toc/.test(desktop!)).toBe(false);
  });
});
