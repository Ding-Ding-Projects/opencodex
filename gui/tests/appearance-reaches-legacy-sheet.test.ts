/**
 * The appearance controls have to reach the whole app, not just the migrated part.
 *
 * `styles.css` carries its own type and spacing scales, and 83 live elements
 * still render through them. Those scales were written as fixed pixels with no
 * link to `typeTokens()` or `densityTokens()`, so moving the font-size or
 * density slider changed `--t-*` and `--sp-*` while every legacy element stayed
 * exactly where it was. The control did not error, or warn, or half-work — on an
 * unmigrated screen it did nothing at all, which reads as a broken slider rather
 * than an unfinished migration.
 *
 * These are source-text assertions on purpose. The defect is an alias quietly
 * going missing, and nothing else in the suite would notice: every rendering
 * test passes just as happily with a severed scale, because the default values
 * are identical either way. It is only the *derivation* that matters, and the
 * derivation only exists in the stylesheet.
 */

import { describe, expect, test } from "bun:test";

import { DEFAULT_PREFS } from "../src/theme/prefs-context";
import { densityTokens, typeTokens } from "../src/theme/m3";

const css = await Bun.file(new URL("../src/styles.css", import.meta.url)).text();

describe("the font-size scale reaches the legacy type scale", () => {
  test("every legacy step is multiplied by the user's scale", () => {
    for (const step of [
      "--text-micro", "--text-caption", "--text-label", "--text-control",
      "--text-body", "--text-subtitle", "--text-title", "--text-display",
    ]) {
      const declaration = css.match(new RegExp(`${step}:\\s*([^;]+);`))?.[1] ?? "";
      expect(`${step} -> ${declaration.includes("--m3-type-scale")}`).toBe(`${step} -> true`);
    }
  });

  test("the multiplier is actually written onto the element", () => {
    // `typeTokens` emits the derived roles; the raw multiplier is a separate
    // export, because the legacy sheet has to scale its own ramp rather than
    // restate the M3 one.
    const m3 = Bun.file(new URL("../src/theme/m3.ts", import.meta.url));
    return m3.text().then(source => {
      expect(source).toContain("--m3-type-scale");
    });
  });

  test("a scale of 1 leaves every size where it was", () => {
    // The fix must not itself be a redesign. `calc(12px * 1)` is 12px.
    expect(css).toContain("--text-label: calc(12px * var(--m3-type-scale, 1))");
    expect(typeTokens(1)["--t-label-m"]).toBe("12.00px");
  });
});

describe("the density control reaches the legacy spacing scale", () => {
  test("the spacing steps derive from the density ramp", () => {
    for (const [step, token] of [
      ["--space-2", "--sp-1"], ["--space-3", "--sp-2"], ["--space-4", "--sp-3"],
      ["--space-6", "--sp-4"], ["--space-8", "--sp-5"],
    ] as const) {
      const declaration = css.match(new RegExp(`${step}:\\s*([^;]+);`))?.[1] ?? "";
      expect(`${step} -> ${declaration.includes(token)}`).toBe(`${step} -> true`);
    }
  });

  test("the mapping is exact at the loosest density, so nothing moves there", () => {
    // Density 1 must reproduce the pixel values the sheet shipped with, or this
    // stops being an alias and becomes a silent respacing of the whole app.
    const loose = densityTokens(1);
    expect(loose["--sp-1"]).toBe("8px");
    expect(loose["--sp-2"]).toBe("12px");
    expect(loose["--sp-3"]).toBe("16px");
    expect(loose["--sp-4"]).toBe("24px");
    expect(loose["--sp-5"]).toBe("32px");
  });

  test("the hairline steps stay fixed", () => {
    // 2px is a hairline at every density, not a spacing decision.
    expect(css).toContain("--space-0-5: 2px");
    expect(css).toContain("--space-1: 4px");
  });
});

test("the default density matches the prototype", () => {
  // design/OpenCodex M3.dc.html: `density: p.density ?? 3`. This shipped as 4,
  // one step tighter than the design it was ported from.
  expect(DEFAULT_PREFS.density).toBe(3);
});
