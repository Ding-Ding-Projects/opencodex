/**
 * The per-element typography channel, and the validation around it.
 *
 * Rich typography cannot ride the `--el-<id>-*` variable channel the six flat
 * overrides use — twenty-eight more variables would each need a `var()` written
 * by hand into every rule that should honour it. It is compiled into a real
 * stylesheet instead, and that swap is what these tests guard:
 *
 *  - the selector map is right, because a rule against the wrong selector
 *    applies to nothing and looks exactly like a control that does not work;
 *  - a stored value cannot escape its declaration, because a generated
 *    stylesheet concatenates strings where the inline channel parses them;
 *  - a persisted style is clamped on the way in.
 */

import { describe, expect, test } from "bun:test";
import {
  ELEMENT_SELECTORS,
  ELEMENT_TYPE_STYLE_ID,
  elementTypographyCss,
  type ElementStyle,
} from "../src/theme/m3";
import { ELEMENT_TARGETS } from "../src/theme/prefs-context";
import { cssText, readTypography, typographyCss } from "../../shared/m3/typography";

describe("the selector map", () => {
  test("names a real selector for every editable target", () => {
    // A target the editor offers but the map has no entry for accepts every
    // typography setting and silently applies none of them.
    const unmapped = ELEMENT_TARGETS.filter(target => !ELEMENT_SELECTORS[target.id]);
    expect(unmapped.map(t => t.id)).toEqual([]);
  });

  test("every selector is a class the shell actually renders", () => {
    // Read off `styles/m3-shell.css`. Named here rather than grepped so a
    // renamed class fails this test instead of quietly detaching the editor.
    expect(ELEMENT_SELECTORS).toEqual({
      navRail: ".m3-nav",
      tabStrip: ".m3-tabstrip",
      appBar: ".m3-appbar",
      card: ".m3-card",
      table: ".m3-table",
      button: ".m3-btn",
    });
  });
});

describe("compiling element typography", () => {
  test("emits one rule per target that has typography, and none for the rest", () => {
    const styles: Record<string, ElementStyle> = {
      card: { typography: { letterSpacing: 2 } },
      // Radius alone is a `--el-*` override; it must not produce a rule here.
      button: { radius: 8 },
    };
    const css = elementTypographyCss(styles);
    expect(css).toContain(".m3-card");
    expect(css).not.toContain(".m3-btn");
    expect(css).toContain("letter-spacing: 2px;");
  });

  test("outranks the base rule without reaching for !important", () => {
    // `.m3-card { font-family: var(--el-card-font, inherit) }` is single-class,
    // and so is `.m3-card` — leaving which wins to stylesheet order, which is a
    // bundler's decision. `:root ` prefixed makes it deterministic; `!important`
    // would make it unbeatable by anything downstream, which is worse.
    const css = elementTypographyCss({ card: { typography: { family: "Roboto" } } });
    expect(css.startsWith(":root .m3-card {")).toBe(true);
    expect(css).not.toContain("!important");
  });

  test("an empty or absent typography object emits nothing at all", () => {
    expect(elementTypographyCss({ card: { typography: {} } })).toBe("");
    expect(elementTypographyCss({ card: { radius: 4 } })).toBe("");
    expect(elementTypographyCss({})).toBe("");
    expect(elementTypographyCss(undefined)).toBe("");
  });

  test("an unknown target id is skipped rather than written against nothing", () => {
    expect(elementTypographyCss({ notAThing: { typography: { size: 20 } } })).toBe("");
  });

  test("the style element carries a stable id so it is reused, not accumulated", () => {
    expect(ELEMENT_TYPE_STYLE_ID).toBe("ocx-element-typography");
  });
});

describe("a stored value cannot escape its declaration", () => {
  // The inline channel is safe by construction: the engine parses each value on
  // its own and rejects junk. A generated <style> block is not — a value
  // carrying `;` or `}` closes the rule and everything after it parses as new
  // CSS against whatever selector the value author chose.
  const payloads = [
    "red; } body { display: none",
    "red } html {opacity:0",
    "url(https://evil.example/x)",
    "red /* comment",
    "red\\3b  x",
  ];

  test("cssText drops a declaration whose value could break out", () => {
    for (const payload of payloads) {
      expect(cssText({ color: payload })).toBe("");
    }
  });

  test("and keeps the ordinary values beside it", () => {
    const css = cssText({ color: "red; } body {", letterSpacing: "2px" });
    expect(css).toBe("letter-spacing: 2px;");
  });

  test("so a hostile family name never reaches the sheet", () => {
    const css = elementTypographyCss({
      card: { typography: { family: "X; } .m3-nav { display: none", letterSpacing: 1 } },
    });
    expect(css).not.toContain("display: none");
    expect(css).toContain("letter-spacing: 1px;");
  });

  test("a plain colour is untouched", () => {
    expect(cssText(typographyCss({ color: "#ff0000" }))).toBe("color: #ff0000;");
    expect(cssText(typographyCss({ color: "oklch(70% 0.1 200 / 0.5)" }))).toContain("oklch(70% 0.1 200 / 0.5)");
  });
});

describe("reading a persisted style", () => {
  test("clamps a number that would make the app unusable", () => {
    // A hand-edited entry must not be able to set every card to 1e9px and leave
    // the reader with a page they cannot navigate back from.
    expect(readTypography({ size: 1e9 })?.size).toBe(200);
    expect(readTypography({ size: -50 })?.size).toBe(6);
    expect(readTypography({ lineHeight: 99 })?.lineHeight).toBe(4);
  });

  test("drops an enum it does not recognise", () => {
    expect(readTypography({ slant: "sideways" })).toBeUndefined();
    expect(readTypography({ slant: "italic" })?.slant).toBe("italic");
  });

  test("drops an axis tag that is not four characters", () => {
    const style = readTypography({ axes: { wght: 500, "not-a-tag": 3, "\"}x": 1 } });
    expect(style?.axes).toEqual({ wght: 500 });
  });

  test("a style that validates down to nothing is undefined, not an empty object", () => {
    // "Has an override" has to stay a truthful question to ask of the map.
    expect(readTypography({ nonsense: true })).toBeUndefined();
    expect(readTypography(null)).toBeUndefined();
  });
});
