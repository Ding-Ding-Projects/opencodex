/**
 * What survives the trip from `localStorage` into a real stylesheet.
 *
 * The six flat per-element fields used to reach the page only through
 * `--el-<id>-*` custom properties, set with `el.style.setProperty`. That channel
 * is safe by construction: the CSSOM parses each value on its own and rejects
 * junk without anyone having to validate it.
 *
 * Derived (`auto:…`) targets have no hand-written variable anywhere, so their
 * six are compiled into a generated `<style>` block instead. That changed what
 * unvalidated storage can do — an absurd number is now a real declaration
 * applied to everything the selector matches, not an unread custom property.
 *
 * These pin both halves of the guard: values are clamped on the way in, and
 * `cssText` refuses anything that could escape a declaration on the way out.
 */

import { describe, expect, test } from "bun:test";
import { PREFS_KEY, readPrefs } from "../src/theme/prefs-context";
import { elementTypographyCss } from "../src/theme/m3";

/** Round-trip a stored blob through the real reader. */
function stored(elementStyles: unknown) {
  const store = new Map<string, string>([[PREFS_KEY, JSON.stringify({ elementStyles })]]);
  const previous = Reflect.get(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (k: string) => store.get(k) ?? null, setItem: () => {} },
  });
  try {
    return readPrefs().elementStyles;
  } finally {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: previous });
  }
}

describe("reading stored element styles", () => {
  test("absurd numbers are clamped rather than trusted", () => {
    // `border-radius: 1000000000px` on every card is a screen nobody can
    // navigate back from, and it reaches a real rule now.
    const styles = stored({ "auto:div.m3-card": { radius: 1e9, pad: -50, size: 99999 } });
    const card = styles["auto:div.m3-card"]!;
    expect(card.radius).toBe(999);
    expect(card.pad).toBe(0);
    expect(card.size).toBe(400);
  });

  test("a non-numeric number is dropped, not coerced to NaN", () => {
    // `border-radius: NaNpx` is an invalid declaration that silently voids the
    // whole rule in some engines.
    const styles = stored({ "auto:div.m3-card": { radius: "wide", bg: "red" } });
    expect(styles["auto:div.m3-card"]).toEqual({ bg: "red" });
  });

  test("an oversized string is capped", () => {
    const styles = stored({ "auto:div.m3-card": { bg: "x".repeat(5000) } });
    expect(styles["auto:div.m3-card"]!.bg!.length).toBe(400);
  });

  test("an entry that validates down to nothing is dropped entirely", () => {
    // Otherwise it sits in storage styling nothing and shows up in the reset
    // list as an override that will not go away.
    const styles = stored({ "auto:div.m3-card": { bg: "   ", radius: "nope" } });
    expect(Object.keys(styles)).toEqual([]);
  });

  test("an id whose selector cannot be rebuilt never reaches the stylesheet", () => {
    const styles = stored({
      "not-a-target": { bg: "red" },
      "auto:div.m3-card": { bg: "blue" },
    });
    expect(Object.keys(styles)).toEqual(["auto:div.m3-card"]);
  });
});

describe("compiling those styles into CSS", () => {
  test("a derived target emits its own rule with the flat six", () => {
    const css = elementTypographyCss({ "auto:div.m3-card": { bg: "blue", radius: 8, size: 14 } });
    expect(css).toContain(":root div.m3-card {");
    expect(css).toContain("background: blue;");
    expect(css).toContain("border-radius: 8px;");
    // The size control is a TYPE size everywhere in this system.
    expect(css).toContain("font-size: 14px;");
    expect(css).not.toContain("min-height");
  });

  test("a curated target emits typography only — its six ride the variables", () => {
    // Emitting both would have the generated rule fight `--el-card-bg` for the
    // same property, and which wins would depend on stylesheet order.
    const css = elementTypographyCss({ card: { bg: "blue", radius: 8 } });
    expect(css).not.toContain("background: blue");
  });

  test("a value that could escape the declaration is refused", () => {
    // Belt to the reader's braces: even if something got past storage
    // validation, `cssText` drops it rather than closing the rule.
    const css = elementTypographyCss({
      "auto:div.m3-card": { bg: "red; } :root * { display: none", radius: 4 },
    });
    expect(css).not.toContain("display: none");
    expect(css).toContain("border-radius: 4px;");
  });
});
