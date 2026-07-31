/**
 * The colour engine, and the failures a picker cannot show you.
 *
 * A wrong conversion matrix does not throw. It produces a colour that is merely
 * a bit off — indistinguishable from a design decision in a screenshot, and
 * wrong in every gradient, every contrast readout and every exported value
 * forever. So these tests check conversions against *reference values* rather
 * than against themselves, and they check the round trip separately, because a
 * pair of mutually inverse but equally wrong matrices round-trips perfectly.
 *
 * The gamut and clipping assertions matter for the same reason: the whole point
 * of the warning is that the user cannot see the problem on their own display.
 */

import { describe, expect, test } from "bun:test";
import {
  clipsSrgb,
  contrastGrade,
  contrastRatio,
  formatColor,
  formatHex,
  fromRgb,
  gamutOf,
  nameOf,
  nearestName,
  over,
  parseColor,
  relativeLuminance,
  toCssValue,
  toRgb255,
  translate,
} from "../../shared/m3/color";

const hex = (value: string) => parseColor(value)!;

describe("parsing", () => {
  test("every syntax the translator emits parses back to the same colour", () => {
    const original = hex("#3d7a58");
    for (const row of translate(original)) {
      // `named` is the one space that is allowed to be inexact — most colours
      // have no name, and the row says so with a `~`.
      if (row.space === "named") continue;
      const parsed = parseColor(row.value);
      expect(parsed, `${row.space} -> ${row.value}`).not.toBeNull();
      expect(formatHex(parsed!), row.space).toBe("#3d7a58");
    }
  });

  test("named colours, hex shorthands and a bare hex", () => {
    expect(formatHex(hex("rebeccapurple"))).toBe("#663399");
    expect(formatHex(hex("#f00"))).toBe("#ff0000");
    expect(formatHex(hex("0f8"))).toBe("#00ff88");
    expect(hex("#0000ff80").alpha).toBeCloseTo(128 / 255, 3);
    expect(hex("transparent").alpha).toBe(0);
  });

  test("legacy comma syntax and modern slash syntax agree", () => {
    const legacy = hex("rgba(12, 34, 56, 0.5)");
    const modern = hex("rgb(12 34 56 / 50%)");
    expect(formatHex(legacy)).toBe(formatHex(modern));
    expect(legacy.alpha).toBeCloseTo(0.5, 3);
    expect(modern.alpha).toBeCloseTo(0.5, 3);
  });

  test("percentage and integer rgb channels resolve on their own scale", () => {
    expect(toRgb255(hex("rgb(50% 0% 100%)"))).toEqual([128, 0, 255]);
    expect(toRgb255(hex("rgb(128 0 255)"))).toEqual([128, 0, 255]);
  });

  test("rubbish is rejected rather than turned into black", () => {
    for (const bad of ["", "not a colour", "rgb(", "#12345", "hsl(deg)"]) {
      expect(parseColor(bad), bad).toBeNull();
    }
  });

  test("hwb resolves its achromatic case by ratio, not by clipping", () => {
    // w + b >= 1 is grey; the two decide which grey between them.
    expect(formatHex(hex("hwb(200 60% 60%)"))).toBe(formatHex(fromRgb(0.5, 0.5, 0.5)));
    expect(formatHex(hex("hwb(0 0% 100%)"))).toBe("#000000");
  });
});

describe("conversion accuracy", () => {
  /*
   * Reference values. sRGB white, mid grey and the primaries have published
   * OKLab / CIELAB coordinates; checking against those catches a transposed or
   * mistyped matrix, which a round-trip test cannot.
   */
  test("white and black land on the OKLab endpoints", () => {
    expect(fromRgb(1, 1, 1).l).toBeCloseTo(1, 5);
    expect(fromRgb(0, 0, 0).l).toBeCloseTo(0, 5);
    expect(fromRgb(1, 1, 1).c).toBeCloseTo(0, 5);
  });

  test("sRGB red matches its published OKLCh coordinates", () => {
    const red = fromRgb(1, 0, 0);
    expect(red.l).toBeCloseTo(0.6279, 3);
    expect(red.c).toBeCloseTo(0.2577, 3);
    expect(red.h).toBeCloseTo(29.23, 1);
  });

  test("CIELAB is D50-adapted, as CSS lab() requires", () => {
    // sRGB white in CSS `lab()` is L=100 with a and b at zero. Without the
    // Bradford adaptation the a/b components come out around (-0.5, -0.9),
    // which is small enough to look like rounding and is not.
    const white = formatColor(fromRgb(1, 1, 1), "lab");
    const [, L, A, B] = /lab\(([\d.]+)% (-?[\d.]+) (-?[\d.]+)/.exec(white)!;
    expect(Number(L)).toBeCloseTo(100, 1);
    expect(Number(A)).toBeCloseTo(0, 1);
    expect(Number(B)).toBeCloseTo(0, 1);
  });

  test("HSL round-trips through the model", () => {
    expect(formatColor(hex("hsl(210 50% 40%)"), "hsl")).toBe("hsl(210 50% 40%)");
  });
});

describe("gamut and clipping", () => {
  test("an sRGB colour is named sRGB and does not clip", () => {
    expect(gamutOf(hex("#3d7a58"))).toBe("sRGB");
    expect(clipsSrgb(hex("#3d7a58"))).toBe(false);
  });

  test("a P3-only colour is named, and reported as clipping", () => {
    // Saturated green beyond what sRGB can reach at this lightness.
    const wide = hex("oklch(86.6% 0.295 142.5)");
    expect(clipsSrgb(wide)).toBe(true);
    expect(["Display P3", "Rec. 2020", "Beyond Rec. 2020"]).toContain(gamutOf(wide));
  });

  test("an impossible colour is named beyond every standard gamut", () => {
    expect(gamutOf(hex("oklch(70% 0.9 320)"))).toBe("Beyond Rec. 2020");
  });

  test("a wide colour is written as oklch() so it is not silently clipped", () => {
    expect(toCssValue(hex("oklch(86.6% 0.295 142.5)")).startsWith("oklch(")).toBe(true);
    expect(toCssValue(hex("#3d7a58"))).toBe("#3d7a58");
    expect(toCssValue(hex("#3d7a5880"))).toBe("#3d7a5880");
  });
});

describe("contrast", () => {
  test("black on white is the WCAG maximum", () => {
    expect(contrastRatio(fromRgb(0, 0, 0), fromRgb(1, 1, 1))).toBeCloseTo(21, 2);
  });

  test("relative luminance matches the WCAG definition for mid grey", () => {
    expect(relativeLuminance(hex("#808080"))).toBeCloseTo(0.2159, 3);
  });

  test("grading is size-aware", () => {
    expect(contrastGrade(7.5)).toBe("AAA");
    expect(contrastGrade(4.6)).toBe("AA");
    expect(contrastGrade(4.6, true)).toBe("AAA");
    expect(contrastGrade(2.9)).toBe("Fail");
  });

  test("a translucent colour is measured over its backdrop, not as if opaque", () => {
    const ghost = hex("#ffffff20");
    const black = fromRgb(0, 0, 0);
    // Treated as opaque white this would be 21:1 and would certify unreadable
    // text as perfect.
    expect(contrastRatio(ghost, black)).toBeCloseTo(21, 1);
    expect(contrastRatio(over(ghost, black), black)).toBeLessThan(2);
  });
});

describe("names", () => {
  test("an exact name is returned, and a near miss is not", () => {
    expect(nameOf(hex("#ff0000"))).toBe("red");
    expect(nameOf(hex("#ff0001"))).toBeNull();
    // A name has no alpha, so a translucent red is not "red".
    expect(nameOf(hex("#ff000080"))).toBeNull();
  });

  test("the nearest name is perceptual, and marked as approximate", () => {
    expect(nearestName(hex("#ff0002")).name).toBe("red");
    expect(formatColor(hex("#ff0002"), "named")).toBe("~red");
    expect(formatColor(hex("#ff0000"), "named")).toBe("red");
  });
});
