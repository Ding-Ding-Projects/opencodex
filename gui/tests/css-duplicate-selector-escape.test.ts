/**
 * A selector declared by two top-level rules is resolved per-property by source
 * order, not by intent. That is fine when both rules describe the same
 * component -- a base rule plus the `--el-*` element-appearance layer, which is
 * how most of this stylesheet's ~18 duplicate selectors are built. It is a
 * silent, invisible bug when they describe DIFFERENT components.
 *
 * `.m3-badge` was the latter. The notification bell's unread-count dot
 * (`position: absolute; top: 6px; right: 6px`) and the inline status pill
 * rendered by `Badge` (shell/m3-ui.tsx) shared one class name, 570 lines apart.
 * The later pill rule never redeclares `position`, so the dot's took effect on
 * every status pill in the app -- and a pill with no positioned ancestor
 * anchors to the initial containing block, which put the Downloads page's
 * "Completed" pill on top of the window's maximize and close buttons. It
 * shipped in `assets/shots/download-history.png`.
 *
 * ## Why this checks only the position family
 *
 * A first pass flagged every property surviving across a duplicate: 19 hits, 18
 * of them deliberate (`gap`, `background`, `display` and friends re-themed by
 * the appearance layer). A guard needing an 18-entry allowlist is a guard whose
 * allowlist eventually swallows a real defect.
 *
 * Narrowing to the properties that take an element OUT OF FLOW -- position,
 * the four offsets, and z-index -- separates them cleanly. Measured against the
 * stylesheet as it was immediately before the fix, it reports exactly three:
 * `.m3-badge`, plus the two below. Nothing else. Those two are genuinely one
 * component each and genuinely positioned, so they are named here with the
 * reason rather than filtered out by a pattern that would also hide the next
 * `.m3-badge`.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CSS_PATH = join(import.meta.dir, "..", "src", "styles", "m3-shell.css");

/**
 * Selectors whose duplicate rules describe ONE component that really is taken
 * out of flow. Both are overlays whose base rule positions them and whose
 * second rule is the element-appearance layer re-theming the same thing.
 *
 * Keep this list tiny. An entry here is a promise that the two rules are about
 * the same component -- which is the exact property `.m3-badge` violated, and
 * the one thing this test cannot check mechanically.
 */
const SAME_COMPONENT_AND_POSITIONED = new Set([
  ".m3-menu",       // anchored popover surface; positioned by its base rule
  ".m3-snack-host", // fixed-position toast host; positioned by its base rule
]);

/** Properties that move an element out of normal flow. */
const ESCAPES_FLOW = new Set(["position", "top", "right", "bottom", "left", "z-index"]);

interface Rule { selector: string; body: string; line: number }

/**
 * Top-level rules, found by counting braces over comment-stripped text.
 *
 * At-rules are skipped: their body holds nested rules, and a selector repeated
 * inside a `@media` is a deliberate responsive override rather than this
 * defect. Regex-splitting the stylesheet instead would merge a rule with the
 * comment above it and read the whole thing as one selector.
 */
function topLevelRules(css: string): Rule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: Rule[] = [];
  let depth = 0, blockStart = 0, preludeStart = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") {
      if (depth === 0) { preludeStart = blockStart; blockStart = i + 1; }
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const prelude = text.slice(preludeStart, blockStart - 1).trim();
        const body = text.slice(blockStart, i);
        if (!prelude.startsWith("@")) {
          const line = text.slice(0, preludeStart).split("\n").length;
          for (const sel of prelude.split(",").map(s => s.trim()).filter(Boolean)) {
            rules.push({ selector: sel, body, line });
          }
        }
        blockStart = i + 1;
      }
    }
  }
  return rules;
}

function declaredProps(body: string): Set<string> {
  return new Set([...body.matchAll(/(?:^|;)\s*([-a-z]+)\s*:/g)].map(m => m[1]!));
}

/**
 * For each selector with more than one rule, the out-of-flow properties an
 * EARLIER rule sets that the LAST rule never redeclares -- i.e. the ones that
 * survive into whatever the last rule is actually for.
 */
function leakedEscapes(css: string): Map<string, string[]> {
  const bySelector = new Map<string, Rule[]>();
  for (const rule of topLevelRules(css)) {
    if (!bySelector.has(rule.selector)) bySelector.set(rule.selector, []);
    bySelector.get(rule.selector)!.push(rule);
  }

  const out = new Map<string, string[]>();
  for (const [selector, group] of bySelector) {
    if (group.length < 2) continue;
    const lastProps = declaredProps(group[group.length - 1]!.body);
    const leaked = new Set<string>();
    for (const earlier of group.slice(0, -1)) {
      for (const p of declaredProps(earlier.body)) {
        if (ESCAPES_FLOW.has(p) && !lastProps.has(p)) leaked.add(p);
      }
    }
    if (leaked.size > 0) out.set(selector, [...leaked].sort());
  }
  return out;
}

describe("no selector leaks out-of-flow positioning across duplicate rules", () => {
  it("the live stylesheet is clean", () => {
    const unexpected = [...leakedEscapes(readFileSync(CSS_PATH, "utf-8"))]
      .filter(([selector]) => !SAME_COMPONENT_AND_POSITIONED.has(selector))
      .map(([selector, props]) => `${selector}: ${props.join(", ")}`);
    expect(unexpected).toEqual([]);
  });

  it("catches the shape that shipped", () => {
    // The real defect, reduced. Two rules, one class name, and the second never
    // redeclares `position` -- so an inline pill silently inherits `absolute`.
    // Watching this go red is what makes the assertion above worth anything.
    const shipped = `
      .thing { position: absolute; top: 6px; right: 6px; height: 16px; }
      .other { color: red; }
      .thing { display: inline-flex; height: 24px; }
    `;
    expect(leakedEscapes(shipped).get(".thing")).toEqual(["position", "right", "top"]);
  });

  it("does not flag a duplicate that redeclares what it inherits", () => {
    const fine = `
      .thing { position: absolute; top: 6px; }
      .thing { position: static; top: auto; color: red; }
    `;
    expect(leakedEscapes(fine).has(".thing")).toBe(false);
  });

  it("does not flag a duplicate that never positioned anything", () => {
    // The common, harmless case: a base rule plus an appearance-layer override.
    // Flagging these is what made a first draft report 19 hits, 18 of them noise.
    const themed = `
      .thing { display: flex; gap: 8px; background: red; }
      .thing { background: blue; }
    `;
    expect(leakedEscapes(themed).has(".thing")).toBe(false);
  });

  it("ignores a selector repeated inside an at-rule", () => {
    const responsive = `
      .thing { position: absolute; top: 0; }
      @media (max-width: 600px) { .thing { display: none; } }
    `;
    expect(leakedEscapes(responsive).has(".thing")).toBe(false);
  });

  it("does not read a preceding comment as part of the selector", () => {
    const commented = `
      /* .thing { position: absolute; } */
      .thing { display: flex; }
    `;
    expect(leakedEscapes(commented).has(".thing")).toBe(false);
  });
});
