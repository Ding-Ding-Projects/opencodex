/**
 * Regression test for confirmed finding L6-03: the shared bulk-action bar
 * (`shell/BulkBar.tsx`) rendered three of its own classes —
 * `.m3-bulkbar`, `.m3-bulkbar__count`, `.m3-bulkbar__actions` — that no
 * shipped stylesheet defined anywhere. Same shape HANDOFF.md already
 * recorded once in this codebase ("`PdfTools.tsx` referencing CSS classes
 * defined in no stylesheet"): a capability (a styled bar) wired at the
 * component end and never wired to a stylesheet, with nothing erroring to
 * say so — five separate pages render it (`ComboWorkspace.tsx`, `Models.tsx`,
 * `Locks.tsx`, `Authenticator.tsx`, `ApiKeys.tsx`), so the blast radius was
 * every bulk-select surface in the app, not one screen.
 *
 * Following this codebase's own established convention for a CSS claim in a
 * `happy-dom` suite (see `bottom-nav-min-width.test.ts`'s module doc: no
 * layout engine here, so a test in this suite can only prove a rule's text
 * is present or absent, never that it visually renders) — this is that cheap,
 * always-on half: it reads the real shipped stylesheet text directly,
 * exactly as `bottom-nav-min-width.test.ts` does for `m3-shell.css`.
 *
 * `main.tsx` imports only `styles.css`, which `@import`s the other 13 files;
 * together they are the entire shipped stylesheet — confirmed by reading
 * `src/styles.css`'s own `@import` list before writing this test.
 *
 * Note on the three `hasRuleFor(...)` selector arguments below: the
 * original hunt draft passed an already backslash-escaped selector
 * (`"\\.m3-bulkbar"`) into a helper that escapes its input itself (see
 * `hasRuleFor`'s own `.replace(...)` line, identical to `bottom-nav-min-
 * width.test.ts`'s `rule()`), which double-escapes the leading dot and
 * requires a literal backslash character in the stylesheet text — something
 * no real CSS rule ever contains, so those three assertions could never
 * pass against any stylesheet. Fixed here to the plain-selector form
 * (`".m3-bulkbar"`) that `hasRuleFor` and its sibling `rule()` are actually
 * written to take, which keeps the exact same claim each test's name states.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC_DIR = new URL("../src", import.meta.url).pathname;

function walkCss(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walkCss(p, out);
    else if (entry.endsWith(".css")) out.push(p);
  }
  return out;
}

const ALL_CSS = walkCss(SRC_DIR).map(p => readFileSync(p, "utf8")).join("\n/* --- next file --- */\n");
const BULK_BAR_TSX = readFileSync(new URL("../src/shell/BulkBar.tsx", import.meta.url), "utf8");

/** Whether `selector { ... }` (or `selector,` sharing a rule) appears anywhere. */
function hasRuleFor(selector: string): boolean {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escaped}\\s*[,{]`).test(ALL_CSS);
}

describe("BulkBar's own classes are styled somewhere in the shipped stylesheet", () => {
  test("this test is actually looking at real, sizeable stylesheet content", () => {
    // Guard the guard: an empty read would pass every "no rule found"
    // assertion below vacuously.
    expect(ALL_CSS.length).toBeGreaterThan(50_000);
  });

  test("BulkBar.tsx still renders these three classes (guards against a stale test)", () => {
    expect(BULK_BAR_TSX).toContain('className="m3-bulkbar"');
    expect(BULK_BAR_TSX).toContain("m3-bulkbar__count");
    expect(BULK_BAR_TSX).toContain("m3-bulkbar__actions");
  });

  test("the five real consumers of BulkBar are still there (this is not a one-screen risk)", () => {
    const consumers = [
      "../src/components/ComboWorkspace.tsx",
      "../src/pages/Models.tsx",
      "../src/pages/Locks.tsx",
      "../src/pages/Authenticator.tsx",
      "../src/pages/ApiKeys.tsx",
    ];
    for (const rel of consumers) {
      const content = readFileSync(new URL(rel, import.meta.url), "utf8");
      expect(content).toContain("BulkBar");
    }
  });

  // RED before the fix (all three): the shared bar itself had zero visual
  // identity — no background, no border, no padding, no elevation
  // distinguishing it from plain stacked text — on every one of the five
  // pages above, the instant any row was selected. GREEN after the fix: each
  // of these three classes gets a real rule in the shipped stylesheet.
  test("the outer bar container has a real rule", () => {
    expect(hasRuleFor(".m3-bulkbar")).toBe(true);
  });

  test("the selection-count text has a real rule", () => {
    expect(hasRuleFor(".m3-bulkbar__count")).toBe(true);
  });

  test("the actions row has a real rule", () => {
    expect(hasRuleFor(".m3-bulkbar__actions")).toBe(true);
  });
});
