/**
 * Element identity, style validation and the CSS the editor produces.
 *
 * The two classes of failure this guards are both invisible at build time.
 *
 * **A derived id that is not stable.** Every per-element style is keyed by an id
 * built from the DOM, so an id that changes when Astro rehashes a scoped class
 * means the reader's customization silently applies to nothing after the next
 * deploy. Nothing errors; the styling just stops.
 *
 * **A selector reconstructed from storage.** `selectorFor` turns a stored string
 * straight into `querySelectorAll`, so it has to be total and it has to be safe
 * for values that were never written by us.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
  applyToNodes,
  declarationsFor,
  elementIdFor,
  labelFor,
  mergeElementStyle,
  readElementStyle,
  readElementStyles,
  readPresetFile,
  rootVars,
  selectorFor,
  targetChain,
  PRESET_KIND,
} from "../../shared/m3/elements";

let window: Window;
const html = (markup: string) => {
  window.document.body.innerHTML = markup;
  return window.document.body.firstElementChild as unknown as Element;
};

beforeEach(() => {
  window = new Window({ url: "http://localhost/" });
});

describe("identity", () => {
  test("an explicit data-m3-el wins over the derived signature", () => {
    expect(elementIdFor(html(`<div data-m3-el="tabStrip" class="m3-tabstrip"></div>`))).toBe("tabStrip");
  });

  test("framework-generated classes never enter an id", () => {
    // `astro-j7pv25f6` and `_card_1hs9x` change whenever their source file is
    // edited. An id built from one stops matching after the next deploy and the
    // reader's customization vanishes with nothing reporting it.
    const node = html(`<a class="astro-j7pv25f6 sl-link-card _card_1hs9x"></a>`);
    expect(elementIdFor(node)).toBe("auto:a.sl-link-card");
  });

  test("state classes never enter an id", () => {
    // Otherwise hovering a tab would retarget the editor at a different element.
    expect(elementIdFor(html(`<div class="m3-tab selected dragging"></div>`))).toBe("auto:div.m3-tab");
  });

  test("an id is capped at two classes so one extra modifier does not fork it", () => {
    expect(elementIdFor(html(`<p class="one two three four"></p>`))).toBe("auto:p.one.two");
  });

  test("a class-free element still gets an id", () => {
    expect(elementIdFor(html(`<h2></h2>`))).toBe("auto:h2");
  });
});

describe("selector reconstruction", () => {
  test("every id this module produces maps back to a selector", () => {
    for (const markup of [
      `<div data-m3-el="card"></div>`,
      `<a class="sl-link-card"></a>`,
      `<h2></h2>`,
      `<div class="one two"></div>`,
    ]) {
      const id = elementIdFor(html(markup));
      expect(selectorFor(id), id).not.toBeNull();
    }
  });

  test("a hostile stored id cannot produce a selector", () => {
    for (const bad of [
      'auto:div"]{display:none}[x="',
      "auto:div.a b",
      "auto:*",
      'x"] , script[x="',
      "auto:.leading-dot",
    ]) {
      expect(selectorFor(bad), bad).toBeNull();
    }
  });

  test("a curated id resolves to its attribute selector", () => {
    expect(selectorFor("tabStrip")).toBe('[data-m3-el="tabStrip"]');
  });
});

describe("target chain", () => {
  test("walks upwards, collapses duplicates and stops at body", () => {
    window.document.body.innerHTML = `
      <div class="outer"><div class="outer"><aside class="starlight-aside">
        <p class="note"><span>word</span></p>
      </aside></div></div>`;
    const span = window.document.querySelector("span") as unknown as Element;
    const chain = targetChain(span);
    const ids = chain.map(c => c.id);
    expect(ids[0]).toBe("auto:span");
    expect(ids).toContain("auto:aside.starlight-aside");
    // `.outer` appears twice in the DOM and once in the chain: two rows doing
    // exactly the same thing is a menu that looks broken.
    expect(ids.filter(id => id === "auto:div.outer")).toHaveLength(1);
    expect(ids).not.toContain("auto:body");
  });

  test("a curated ancestor is labelled from the table, not from its tag", () => {
    window.document.body.innerHTML = `<div data-m3-el="sidebar"><a href="#">x</a></div>`;
    const link = window.document.querySelector("a") as unknown as Element;
    expect(targetChain(link).map(c => c.label)).toContain("Sidebar");
  });

  test("a derived label is readable rather than a selector", () => {
    expect(labelFor("auto:a.sl-link-card")).toBe("Link card <a>");
    expect(labelFor("auto:h2")).toBe("<h2>");
  });
});

describe("style validation", () => {
  test("numbers are clamped so storage cannot render the page unusable", () => {
    const style = readElementStyle({ radius: 1e9, pad: -40, opacity: 12, text: { size: 100000 } });
    expect(style?.radius).toBe(999);
    expect(style?.pad).toBe(0);
    expect(style?.opacity).toBe(1);
    expect(style?.text?.size).toBe(200);
  });

  test("an unusable id is dropped from a stored map rather than kept forever", () => {
    const styles = readElementStyles({ "auto:div.ok": { bg: "red" }, 'auto:x"]{a': { bg: "red" } });
    expect(Object.keys(styles)).toEqual(["auto:div.ok"]);
  });

  test("an empty style is dropped, so a reset leaves no husk behind", () => {
    expect(readElementStyle({})).toBeUndefined();
    expect(readElementStyle({ text: {} })).toBeUndefined();
  });

  test("an axis tag that is not four characters never reaches the CSS", () => {
    const style = readElementStyle({ text: { axes: { 'wght" ; color:red': 700, wght: 700 } } });
    expect(style?.text?.axes).toEqual({ wght: 700 });
  });
});

describe("merging", () => {
  test("undefined clears one property without disturbing the rest", () => {
    const base = readElementStyle({ bg: "red", radius: 8 })!;
    expect(mergeElementStyle(base, { bg: undefined })).toEqual({ radius: 8 });
  });

  test("a text patch merges into the existing typography rather than replacing it", () => {
    const base = readElementStyle({ text: { size: 18, weight: 700 } })!;
    const next = mergeElementStyle(base, { text: { weight: 400 } });
    expect(next?.text).toEqual({ size: 18, weight: 400 });
  });

  test("an explicit undefined text clears the whole block", () => {
    const base = readElementStyle({ text: { size: 18 }, bg: "red" })!;
    expect(mergeElementStyle(base, { text: undefined })).toEqual({ bg: "red" });
  });
});

describe("CSS output", () => {
  test("box properties become declarations", () => {
    const css = declarationsFor(readElementStyle({ bg: "red", radius: 8, border: 2, elevation: "e2" }));
    expect(css.background).toBe("red");
    expect(css.borderRadius).toBe("8px");
    expect(css.borderWidth).toBe("2px");
    // A width with no style set renders nothing at all in CSS.
    expect(css.borderStyle).toBe("solid");
    expect(css.boxShadow).toBe("var(--e2)");
  });

  test("only curated ids reach the :root variable channel", () => {
    const vars = rootVars({
      tabStrip: readElementStyle({ bg: "red", pad: 4 })!,
      "auto:div.x": readElementStyle({ bg: "blue" })!,
    });
    expect(vars).toEqual({ "--el-tabStrip-bg": "red", "--el-tabStrip-pad": "4px" });
  });

  test("applying clears the properties it previously wrote", () => {
    const node = html(`<div></div>`) as unknown as HTMLElement;
    applyToNodes([node], readElementStyle({ bg: "red", radius: 8 }));
    expect(node.style.background).toBe("red");
    applyToNodes([node], readElementStyle({ radius: 8 }));
    // Without the clear pass the old background would be stranded on the node
    // and "reset" would visibly do nothing.
    expect(node.style.background).toBe("");
    expect(node.style.borderRadius).toBe("8px");
  });

  test("an inline style the component set for itself survives", () => {
    const node = html(`<div></div>`) as unknown as HTMLElement;
    node.style.setProperty("z-index", "5");
    applyToNodes([node], readElementStyle({ bg: "red" }));
    applyToNodes([node], undefined);
    expect(node.style.getPropertyValue("z-index")).toBe("5");
  });
});

describe("presets", () => {
  const readAppearance = (value: unknown) => value ?? null;

  test("a file with the wrong kind imports nothing", () => {
    expect(readPresetFile({ kind: "something-else", name: "x" }, readAppearance)).toHaveLength(0);
    expect(readPresetFile("not json at all", readAppearance)).toHaveLength(0);
  });

  test("a wrapped list and a bare list both import", () => {
    const one = { kind: PRESET_KIND, version: 1, name: "Dark reading", elements: { "auto:h2": { bg: "red" } } };
    expect(readPresetFile({ presets: [one] }, readAppearance)).toHaveLength(1);
    expect(readPresetFile([one, one], readAppearance)).toHaveLength(2);
    expect(readPresetFile(one, readAppearance)[0].elements["auto:h2"].bg).toBe("red");
  });

  test("an imported preset's element styles go through the same validation", () => {
    const imported = readPresetFile(
      { kind: PRESET_KIND, name: "x", elements: { 'auto:a"]{': { bg: "red" }, "auto:h2": { radius: 1e9 } } },
      readAppearance,
    );
    expect(Object.keys(imported[0].elements)).toEqual(["auto:h2"]);
    expect(imported[0].elements["auto:h2"].radius).toBe(999);
  });
});
