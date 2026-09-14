/**
 * ACCESS-02: two `scrollIntoView({ behavior: "smooth" })` call sites never
 * check `prefers-reduced-motion`, unlike the sibling that established the
 * correct pattern.
 *
 * `src/shell/command-palette-teleport.ts` (`highlightAndFocus`) reads
 * `matchMedia("(prefers-reduced-motion: reduce)")` and falls back to
 * `behavior: "auto"` for anyone who asked the OS for less motion (a smooth
 * scroll is exactly the vestibular trigger that preference exists to suppress),
 * and the CSS-wide `* { animation: none !important; transition: none !important; }`
 * backstop in `src/styles.css` does not cover it, because native scroll-behavior
 * is neither a CSS animation nor a CSS transition.
 *
 * `src/pages/ApiKeys.tsx` ("Manage" from the Copilot panel) and
 * `src/pages/Locks.tsx` (opening Support Tickets) both hard-code
 * `behavior: "smooth"` with no such check, so a reduced-motion user gets the
 * animated scroll here that the rest of the product deliberately spares them.
 *
 * This walks the source the same way `every-search-bar-has-a-builder.test.ts`
 * does, because the underlying shape is identical: a contract satisfied by
 * hand at each call site, with nothing stopping the next one from being
 * added wrong. Failing here is cheaper than an unannounced scroll six months
 * from now.
 */

import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

/** Every `.ts`/`.tsx` file under `src`, repository-relative for readable failures. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** A literal, unconditional smooth scroll: the string "smooth" bound directly to `behavior`. */
const HARD_CODED_SMOOTH = /behavior:\s*["']smooth["']/;

/**
 * Files allowed to hard-code smooth scrolling because they already gate it on
 * `prefers-reduced-motion` themselves, just not through a `behavior:` literal
 * next to the offending match (the ternary lives on the same line, one file
 * away from the regex above by design, see `command-palette-teleport.ts`).
 */
const SELF_GATED = new Set<string>([
  join(SRC, "shell", "command-palette-teleport.ts"),
]);

test("every hard-coded smooth scrollIntoView site also consults prefers-reduced-motion", () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC)) {
    if (SELF_GATED.has(file)) continue;
    const text = readFileSync(file, "utf8");
    if (!HARD_CODED_SMOOTH.test(text)) continue;
    // The whole file, not just the matched line: a module-level `matchMedia`
    // check earlier in the file would still make the call site correct.
    if (/prefers-reduced-motion|reducedMotion/.test(text)) continue;
    offenders.push(relative(SRC, file).split(sep).join("/"));
  }

  // Today: src/pages/ApiKeys.tsx and src/pages/Locks.tsx both hard-code
  // `behavior: "smooth"` with no reduced-motion check anywhere in the file.
  // A correct fix reads matchMedia the way command-palette-teleport.ts does
  // and this list goes empty.
  expect(offenders).toEqual([]);
});
