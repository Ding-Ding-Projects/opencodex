/**
 * `.m3-badge` was declared twice in `m3-shell.css`, ~570 lines apart, by two
 * components with contradictory intent: the notification bell's unread-count
 * dot (`position: absolute; top: 6px; right: 6px`) and the shared inline
 * status pill rendered by `Badge` in `shell/m3-ui.tsx`.
 *
 * Which rule "wins" is decided per-property by source order, so both were
 * wrong at once: the later pill rule took `display`/`height`/`padding`/`font-*`
 * from the dot, and the dot's `position`/`top`/`right` cascaded into the pill
 * because the pill rule never redeclares them. A Badge with no positioned
 * ancestor therefore anchored to the initial containing block, which parked the
 * Downloads page's "Completed" pill over the window's maximize and close
 * buttons. It shipped in `assets/shots/download-history.png` and no test
 * noticed, because every test that renders a Badge asserts on its text.
 *
 * Two assertions, because either alone lets the bug back:
 *
 *   - exactly one rule may own `.m3-badge`. A second one reintroduces the
 *     order-dependence whatever it happens to declare.
 *   - that one rule may not set `position`. Even alone, an absolutely
 *     positioned inline pill escapes its row.
 *
 * The selector is matched with an exact-boundary check rather than
 * `includes(".m3-badge")` -- `.m3-badge-count` contains that substring, and a
 * guard a rename can silently satisfy is not a guard. Rules are found by
 * counting braces over comment-stripped text, not by a `[\s\S]*?` regex, which
 * cannot see nesting and would read a `@media` block or a preceding comment as
 * part of the selector.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CSS = readFileSync(join(import.meta.dir, "..", "src", "styles", "m3-shell.css"), "utf-8");

/** Strip `/* ... *\/` comments so a commented-out rule or a comment containing
 *  a brace cannot be read as real CSS. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Every rule whose selector list mentions `selector` as a whole selector,
 * returned as its declaration body. Walks braces with a depth counter so rules
 * nested inside `@media`/`@supports` are found too and never merged with their
 * neighbours.
 */
function rulesFor(css: string, selector: string): string[] {
  const text = stripComments(css);
  const found: string[] = [];
  let depth = 0;
  let blockStart = 0;
  let prelude = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") {
      if (depth === 0) {
        prelude = text.slice(blockStart, i);
        blockStart = i + 1;
      }
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const body = text.slice(blockStart, i);
        // An at-rule prelude (`@media ...`) wraps nested rules rather than
        // owning declarations; recurse so those are seen too.
        if (prelude.trim().startsWith("@")) found.push(...rulesFor(body, selector));
        else if (selectorListOwns(prelude, selector)) found.push(body);
        blockStart = i + 1;
      }
    }
  }
  return found;
}

/**
 * True when a comma-separated selector list contains `selector` as its own
 * selector -- alone, or followed by a pseudo-class/element or attribute, but
 * NOT followed by an identifier character (which would make it a different
 * class, e.g. `.m3-badge-count`) and NOT followed by a descendant (a rule
 * about a CHILD is not a rule about the component; a previous guard in this
 * repo passed on a deleted rule because `.shot img` satisfied it).
 */
function selectorListOwns(prelude: string, selector: string): boolean {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const exact = new RegExp(`(^|,)\\s*${escaped}\\s*(::?[a-zA-Z-]+(\\([^)]*\\))?|\\[[^\\]]*\\])*\\s*(,|$)`);
  return exact.test(prelude);
}

describe(".m3-badge has exactly one owner", () => {
  it("is declared by exactly one rule", () => {
    // Two rules for one class name is decided by source order, not intent --
    // which is the whole defect, regardless of what the second one declares.
    expect(rulesFor(CSS, ".m3-badge")).toHaveLength(1);
  });

  it("does not position itself", () => {
    const [body] = rulesFor(CSS, ".m3-badge");
    expect(body).toBeDefined();
    // `Badge` is an inline pill inside whatever row renders it. Any `position`
    // here takes it out of flow, and with no positioned ancestor it lands in
    // the window corner over the window controls.
    expect(body).not.toMatch(/(^|[;{\s])position\s*:/);
    expect(body).not.toMatch(/(^|[;{\s])(top|right|bottom|left)\s*:/);
  });

  it("still styles the pill it is responsible for", () => {
    // Guards catch a thing done wrongly, never a thing not done at all: without
    // this, deleting `.m3-badge` outright passes both assertions above.
    const [body] = rulesFor(CSS, ".m3-badge");
    expect(body).toMatch(/display\s*:\s*inline-flex/);
    expect(body).toMatch(/border-radius\s*:/);
  });

  it("the count dot keeps its own name and its own positioning", () => {
    const [body] = rulesFor(CSS, ".m3-badge-count");
    expect(body).toBeDefined();
    expect(body).toMatch(/position\s*:\s*absolute/);
  });

  it("the exact-boundary matcher does not confuse the two class names", () => {
    // Proves the assertions above are actually distinguishing them, rather
    // than `.m3-badge-count` quietly satisfying the `.m3-badge` lookup.
    const fixture = ".m3-badge-count { position: absolute; } .m3-badge img { color: red; }";
    expect(rulesFor(fixture, ".m3-badge")).toHaveLength(0);
    expect(rulesFor(fixture, ".m3-badge-count")).toHaveLength(1);
  });
});
