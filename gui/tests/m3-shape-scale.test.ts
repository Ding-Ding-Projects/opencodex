/**
 * The corner scale is the design system's, and every corner goes through it.
 *
 * Two properties, and the second is the one with teeth.
 *
 * 1. The scale is M3's own steps — 4 / 8 / 12 / 16 / 28 / full. `--r-xs` was
 *    missing for a long time, and its absence did not read as a gap: it read as
 *    two stylesheets independently writing `border-radius: 4px` because there
 *    was nothing to reach for.
 *
 * 2. **No stylesheet writes a pixel radius by hand.** This is what keeps the
 *    first property true. Every corner in this app is meant to be an appearance
 *    target, and a literal silently opts out — the element still renders, still
 *    looks right, and simply cannot be restyled, with nothing on screen to say
 *    which corners are which. A grep is the only thing that tells them apart,
 *    so the grep is the test.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { SHAPE_TOKENS } from "../src/theme/m3";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function filesWithSuffix(dir: string, suffix: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...filesWithSuffix(full, suffix));
    else if (entry.endsWith(suffix)) out.push(full);
  }
  return out;
}

const cssFiles = (dir: string) => filesWithSuffix(dir, ".css");
const tsxFiles = (dir: string) => filesWithSuffix(dir, ".tsx");

describe("the corner scale", () => {
  test("carries M3's steps, extra-small included", () => {
    expect(SHAPE_TOKENS["--r-xs"]).toBe("4px");
    expect(SHAPE_TOKENS["--r-s"]).toBe("8px");
    expect(SHAPE_TOKENS["--r-m"]).toBe("12px");
    expect(SHAPE_TOKENS["--r-l"]).toBe("16px");
    expect(SHAPE_TOKENS["--r-xl"]).toBe("28px");
    expect(SHAPE_TOKENS["--r-pill"]).toBe("999px");
  });

  test("has no sixth step invented alongside it", () => {
    // A scale that grows a 10px or a 20px on demand is not a scale. If a design
    // genuinely needs another step it belongs here, deliberately, not as a
    // one-off in whichever sheet needed it first.
    expect(Object.keys(SHAPE_TOKENS).sort()).toEqual(
      ["--r-l", "--r-m", "--r-pill", "--r-s", "--r-xl", "--r-xs"],
    );
  });
});

describe("the icon button's touch target", () => {
  const styles = readFileSync(join(SRC, "styles.css"), "utf-8");

  test("is 48px even though the control is drawn at 28px", () => {
    // Material asks for 48dp; the control is deliberately 28px so the dialog
    // header keeps its density. The two are reconciled by extending the hit area
    // past the box, not by inflating the button.
    const rule = styles.slice(styles.indexOf(".btn-icon::after"));
    expect(rule).toContain("width: 48px");
    expect(rule.slice(0, rule.indexOf("}"))).toContain("height: 48px");
    // Positioning the pseudo-element requires the button to be a containing
    // block; without this the 48px box escapes to the nearest positioned
    // ancestor and lands somewhere else entirely.
    expect(styles).toContain(".btn-icon { position: relative; }");
  });

  test("still has exactly one user, which is what makes the larger target safe", () => {
    // An expanded target that overlaps a neighbour steals its taps, so this is
    // only sound while `.btn-icon` stays isolated. If this count moves, check
    // what it is sitting next to before trusting the rule above.
    // `(?![-\w])` and not `\b`: a hyphen is a word boundary, so `\bbtn-icon\b`
    // also matches `btn-icon-only`, which is a different class with its own
    // sizing and would make this count read 2 forever.
    const uses = tsxFiles(SRC)
      .flatMap(file => readFileSync(file, "utf-8").match(/className="[^"]*\bbtn-icon(?![-\w])[^"]*"/g) ?? []);
    expect(uses).toHaveLength(1);
  });
});

describe("no stylesheet hand-writes a radius", () => {
  const files = cssFiles(SRC);

  test("there are stylesheets to check", () => {
    // Guard the guard: if the walk ever returns nothing, every assertion below
    // passes vacuously and this file becomes decoration.
    expect(files.length).toBeGreaterThan(5);
  });

  test("every border-radius resolves through a token", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf-8");
      text.split("\n").forEach((line, i) => {
        // Only literal lengths. `50%`, `inherit` and `0` are fine, and so is
        // `var(--r-pill, 999px)` — a fallback inside a token is the token still
        // being used, and a sheet loaded before the theme applies needs it. So
        // strip every `var(…)` first, innermost out to handle nested fallbacks,
        // and judge what is left.
        for (const match of line.matchAll(/border-radius:\s*([^;{}]+)/g)) {
          const value = match[1].trim();
          let bare = value;
          for (let guard = 0; guard < 10 && bare.includes("var("); guard++) {
            bare = bare.replace(/var\([^()]*\)/g, "");
          }
          if (/\b\d+(\.\d+)?(px|rem|em)\b/.test(bare)) {
            offenders.push(`${file.slice(SRC.length + 1)}:${i + 1}  ${value}`);
          }
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
