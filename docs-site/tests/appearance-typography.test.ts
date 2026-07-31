/**
 * The typography compiler and the font reader.
 *
 * Three properties in CSS are *shared* by more than one control — the decoration
 * line, the decoration style, and the text shadow — and the failure they cause
 * is the same each time: setting the second control silently unsets the first,
 * with no error and nothing on screen to suggest which one won. Those cases are
 * what most of this file is about.
 *
 * The `fvar` reader is exercised against a synthetic font built byte by byte
 * here. That is deliberate: the parser walks offsets out of an arbitrary file
 * from the user's machine, so "does it survive a truncated table" is a real
 * question, and a real font in the repository would only ever prove the happy
 * path.
 */

import { describe, expect, test } from "bun:test";
import {
  CAPABILITY_BY_ID,
  cssText,
  isEmptyTypography,
  kebab,
  readTypography,
  typographyCss,
} from "../../shared/m3/typography";
import { readVariationAxes, quoteFamily, stackFor } from "../../shared/m3/fonts";

describe("shared CSS properties", () => {
  test("underline, strike and overline coexist on one decoration line", () => {
    // Emitted as three declarations each would overwrite the last, so turning on
    // an overline would quietly remove the underline the user had just set.
    const css = typographyCss({ underline: "solid", strike: "single", overline: true });
    expect(css.textDecorationLine).toBe("underline line-through overline");
  });

  test("a double strike wins the single decoration-style slot, and says so", () => {
    const css = typographyCss({ underline: "wavy", strike: "double" });
    expect(css.textDecorationStyle).toBe("double");
    // The capability table is where the user is told, so it has to actually
    // carry the explanation rather than leave it in a code comment.
    expect(CAPABILITY_BY_ID.strike.caveat).toContain("wavy");
  });

  test("a wavy underline survives when no strike competes for the slot", () => {
    expect(typographyCss({ underline: "wavy" }).textDecorationStyle).toBe("wavy");
    // `solid` is the initial value, so emitting it would override an inherited
    // decoration style for no reason.
    expect(typographyCss({ underline: "solid" }).textDecorationStyle).toBeUndefined();
  });

  test("shadow and glow share one text-shadow list instead of erasing each other", () => {
    const css = typographyCss({ shadowX: 1, shadowY: 2, shadowBlur: 3, shadowColor: "black", glowBlur: 8, glowColor: "cyan" });
    expect(css.textShadow).toBe("1px 2px 3px black, 0 0 8px cyan");
  });
});

describe("unset stays unset", () => {
  test("an empty style emits nothing at all", () => {
    // Emitting `letter-spacing: normal` for an unset value would override an
    // inherited one, which is the opposite of what unset means here.
    expect(typographyCss({})).toEqual({});
    expect(typographyCss(undefined)).toEqual({});
    expect(isEmptyTypography(undefined)).toBe(true);
    expect(isEmptyTypography({ size: 12 })).toBe(false);
  });

  test("only the properties actually set are emitted", () => {
    expect(Object.keys(typographyCss({ weight: 600 }))).toEqual(["fontWeight"]);
  });
});

describe("property mapping", () => {
  test("oblique carries its angle, italic does not", () => {
    expect(typographyCss({ slant: "oblique", obliqueAngle: 12 }).fontStyle).toBe("oblique 12deg");
    expect(typographyCss({ slant: "italic", obliqueAngle: 12 }).fontStyle).toBe("italic");
  });

  test("small caps use font-variant-caps while the rest use text-transform", () => {
    expect(typographyCss({ caps: "small-caps" }).fontVariantCaps).toBe("small-caps");
    expect(typographyCss({ caps: "small-caps" }).textTransform).toBeUndefined();
    expect(typographyCss({ caps: "uppercase" }).textTransform).toBe("uppercase");
  });

  test("superscript ships the visible fallback as well as the OpenType feature", () => {
    // `font-variant-position` silently does nothing for a face with no
    // positioned glyphs and there is no way to detect that from script, so the
    // shift is the honest floor.
    const css = typographyCss({ script: "super", size: 16 });
    expect(css.fontVariantPosition).toBe("super");
    expect(css.verticalAlign).toBe("super");
    expect(css.fontSize).toBe("12px");
  });

  test("axes become a quoted font-variation-settings list", () => {
    expect(typographyCss({ axes: { wght: 620, wdth: 87.5 } }).fontVariationSettings)
      .toBe('"wght" 620, "wdth" 87.5');
  });

  test("direction sets unicode-bidi too, or mixed-script text ignores it", () => {
    expect(typographyCss({ direction: "rtl" }).unicodeBidi).toBe("isolate");
  });

  test("a leading webkit becomes a leading dash", () => {
    // `webkit-text-stroke-width` is not a property; `-webkit-text-stroke-width`
    // is. The naive kebab conversion produces the former and fails in silence.
    expect(kebab("webkitTextStrokeWidth")).toBe("-webkit-text-stroke-width");
    expect(kebab("fontVariationSettings")).toBe("font-variation-settings");
    expect(cssText({ webkitTextStrokeWidth: "1px" })).toBe("-webkit-text-stroke-width: 1px;");
  });
});

describe("validation", () => {
  test("out-of-range numbers are clamped, not dropped", () => {
    const style = readTypography({ size: 5000, weight: -3, lineHeight: 99, letterSpacing: 500 })!;
    expect(style.size).toBe(200);
    expect(style.weight).toBe(1);
    expect(style.lineHeight).toBe(4);
    expect(style.letterSpacing).toBe(40);
  });

  test("an unrecognised enum value is dropped rather than passed through to CSS", () => {
    expect(readTypography({ caps: "url(evil)", slant: "italic" })).toEqual({ slant: "italic" });
  });

  test("unknown keys never survive into the style", () => {
    expect(readTypography({ size: 12, nonsense: "x" })).toEqual({ size: 12 });
  });

  test("a capability record exists for every control that needs an explanation", () => {
    for (const id of ["strike", "script", "highlight", "baselineShift", "glowBlur", "outlineWidth"]) {
      expect(CAPABILITY_BY_ID[id], id).toBeDefined();
      expect(CAPABILITY_BY_ID[id].css.length, id).toBeGreaterThan(0);
    }
    // A degraded capability with no caveat renders an empty explanation, which
    // reads as a control that is broken for no stated reason.
    for (const capability of Object.values(CAPABILITY_BY_ID)) {
      if (capability.degraded) expect(capability.caveat.length, capability.id).toBeGreaterThan(0);
    }
  });
});

describe("font stacks", () => {
  test("a family name is quoted only when it needs to be", () => {
    expect(quoteFamily("Segoe UI")).toBe('"Segoe UI"');
    expect(quoteFamily('Evil", monospace; x')).toBe('"Evil\\", monospace; x"');
  });

  test("every stack carries a CJK-safe tail", () => {
    // Without it a Latin-configured system renders the site's Cantonese,
    // Japanese and Korean copy as tofu and the picker gets blamed.
    expect(stackFor("Iosevka")).toContain("Noto Sans HK");
    expect(stackFor("Geist Variable")).toContain("Pretendard Variable");
  });
});

/* ---------------------------------------------------------------- fvar -- */

/** A minimal SFNT carrying one `fvar` table with `axisCount` axes. */
function syntheticFont(axes: { tag: string; min: number; def: number; max: number; nameId: number }[]): ArrayBuffer {
  const AXIS_SIZE = 20;
  const fvarLength = 16 + axes.length * AXIS_SIZE;
  const fvarOffset = 12 + 16;
  const buffer = new ArrayBuffer(fvarOffset + fvarLength);
  const view = new DataView(buffer);

  view.setUint32(0, 0x00010000);
  view.setUint16(4, 1); // numTables
  for (let i = 0; i < 4; i++) view.setUint8(12 + i, "fvar".charCodeAt(i));
  view.setUint32(12 + 8, fvarOffset);
  view.setUint32(12 + 12, fvarLength);

  view.setUint16(fvarOffset + 0, 1);          // majorVersion
  view.setUint16(fvarOffset + 4, 16);         // axesArrayOffset
  view.setUint16(fvarOffset + 8, axes.length);
  view.setUint16(fvarOffset + 10, AXIS_SIZE);

  axes.forEach((axis, i) => {
    const at = fvarOffset + 16 + i * AXIS_SIZE;
    for (let j = 0; j < 4; j++) view.setUint8(at + j, axis.tag.charCodeAt(j));
    view.setInt32(at + 4, axis.min * 65536);
    view.setInt32(at + 8, axis.def * 65536);
    view.setInt32(at + 12, axis.max * 65536);
    view.setUint16(at + 16, 0);               // flags
    view.setUint16(at + 18, axis.nameId);     // axisNameID — NOT at 16
  });
  return buffer;
}

describe("variable axis reader", () => {
  test("reads tag, range and default in the right order", () => {
    const axes = readVariationAxes(syntheticFont([
      { tag: "wght", min: 100, def: 400, max: 900, nameId: 256 },
      { tag: "wdth", min: 75, def: 100, max: 125, nameId: 257 },
    ]));
    expect(axes).toHaveLength(2);
    expect(axes[0]).toMatchObject({ tag: "wght", min: 100, default: 400, max: 900 });
    expect(axes[1]).toMatchObject({ tag: "wdth", min: 75, default: 100, max: 125 });
  });

  test("falls back to the registered label when there is no name table", () => {
    // With the name id read from the wrong offset every axis reports name id 0,
    // which labels them all "Copyright notice" in a font that does have a name
    // table. Here the fallback table has to answer instead.
    expect(readVariationAxes(syntheticFont([{ tag: "wght", min: 1, def: 400, max: 1000, nameId: 256 }]))[0].name)
      .toBe("Weight");
  });

  test("a truncated, empty or hostile file yields no axes rather than throwing", () => {
    const good = syntheticFont([{ tag: "wght", min: 100, def: 400, max: 900, nameId: 256 }]);
    expect(readVariationAxes(good.slice(0, 20))).toEqual([]);
    expect(readVariationAxes(new ArrayBuffer(0))).toEqual([]);
    expect(readVariationAxes(new ArrayBuffer(4096))).toEqual([]);
  });

  test("a font collection is declined rather than half-read", () => {
    // The first font in a collection is not necessarily the family the entry
    // referred to, so guessing would attribute one face's axes to another.
    const ttc = new ArrayBuffer(64);
    new DataView(ttc).setUint32(0, 0x74746366);
    expect(readVariationAxes(ttc)).toEqual([]);
  });
});
