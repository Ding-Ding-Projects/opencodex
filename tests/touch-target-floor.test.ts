/**
 * 44 must not come back.
 *
 * The touch-target audit found one belief, not a list of bugs: that **44px**
 * "clears the minimum hit target". It does not — 44 is Apple's HIG figure and
 * Material's is 48 — and it had spread into comments asserting the claim, into
 * inline React styles no stylesheet could reach, into a `--control-touch: 44px`
 * design token, and into `shared/m3/components.css`, which the app and the
 * documentation site both load.
 *
 * That is exactly the shape of thing a test catches and a review does not: every
 * individual `44px` looks deliberate, and each one was.
 *
 * ## Why it bans a number rather than checking a minimum
 *
 * "No control smaller than 48" cannot be decided from source. A 32px swatch with
 * a 48px pseudo-element target is correct; an 18px checkbox inside a 48px
 * wrapper is correct; a 20px switch thumb is not a target at all. Only layout
 * knows, which is what `scripts/touch-target-audit.ts` is for — it measures a
 * real engine and is the check that proves compliance.
 *
 * This is the cheap half: it guards the specific wrong number that was actually
 * believed, so a copy-paste cannot quietly reintroduce it between audits. A
 * genuine 44px that is NOT a touch target should be written as a different
 * number or given the exemption below with a reason.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Everything that renders a user-facing surface. */
const ROOTS = ["gui/src", "shared", "docs-site/src"];

const SKIP_DIRS = new Set(["node_modules", "dist", ".astro", "build", "coverage"]);
const EXTENSIONS = new Set([".css", ".ts", ".tsx", ".astro", ".mjs"]);

/**
 * Places a literal 44 is legitimate and not a touch target.
 *
 * Empty on purpose. It is here so the next person has somewhere to put a real
 * exception with a reason, rather than deleting the test — but an exemption
 * should be rare enough that adding one prompts the question "is this a control?"
 */
const EXEMPT: Array<{ file: string; why: string }> = [];

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (EXTENSIONS.has(extname(entry))) out.push(full);
  }
  return out;
}

/**
 * `min-height: 44px`, `width:44px` — and `2.75rem`, which is the same number in
 * different clothes.
 *
 * The rem spelling is not hypothetical: `.ocx-menu-btn` in the documentation
 * site's header was `2.75rem` square, and a sweep looking for `44px` walked
 * straight past it. A guard that only knows one spelling teaches people the
 * other one.
 */
const CSS_44 = /(?:min-|max-)?(?:width|height)\s*:\s*(?:44px|2\.75rem)/gi;
/** React inline styles: `minHeight: 44`, `width: 44,`. No stylesheet can floor these. */
const INLINE_44 = /\b(?:minHeight|minWidth|height|width)\s*:\s*44\b/g;

interface Hit { file: string; line: number; text: string }

function scan(): Hit[] {
  const hits: Hit[] = [];
  for (const root of ROOTS) {
    for (const file of walk(join(ROOT, root))) {
      const rel = relative(ROOT, file).replace(/\\/g, "/");
      if (EXEMPT.some(entry => entry.file === rel)) continue;
      const lines = readFileSync(file, "utf-8").split(/\r?\n/);
      lines.forEach((text, index) => {
        // BOTH patterns on every file, not one chosen by extension. An `.astro`
        // or `.tsx` file carries a `<style>` block of real CSS, so picking the
        // inline pattern for those missed `height: 44px` entirely — caught by
        // mutating exactly that and watching this stay green. A `.css` file
        // never contains a JS style object, so running both costs nothing.
        for (const pattern of [CSS_44, INLINE_44]) {
          pattern.lastIndex = 0;
          if (pattern.test(text)) {
            hits.push({ file: rel, line: index + 1, text: text.trim().slice(0, 100) });
            return;
          }
        }
      });
    }
  }
  return hits;
}

describe("the 48dp touch-target floor", () => {
  test("this test is actually looking at files", () => {
    // Guard the guard. A scan whose roots moved would pass vacuously while the
    // number crept back in everywhere.
    let count = 0;
    for (const root of ROOTS) count += walk(join(ROOT, root)).length;
    expect(count).toBeGreaterThan(50);
  });

  test("no control is sized 44px anywhere the user can touch it", () => {
    const hits = scan();
    const report = hits.map(hit => `${hit.file}:${hit.line}  ${hit.text}`);
    // 44 is Apple's minimum. Material's — which this project follows — is 48.
    // If a 44 here is genuinely not a touch target, say so in EXEMPT with a
    // reason rather than widening the pattern.
    expect(report).toEqual([]);
  });

  test("the shared stylesheet the docs site and the app both load is covered", () => {
    // `shared/m3/components.css` was the root of the original spread: fixing the
    // app alone left the documentation site on 44.
    const files = walk(join(ROOT, "shared")).map(f => relative(ROOT, f).replace(/\\/g, "/"));
    expect(files).toContain("shared/m3/components.css");
  });
});
