/**
 * The three controls the Material 3 parity audit found missing outright: the
 * infinite colour picker, the word-depth typography panel, and a font picker
 * that can see the fonts on this machine.
 *
 * The headline assertion is the negative one — no `<input type="color">`
 * survives anywhere in the app. That control is a swatch grid in some engines
 * and a spectrum in others, carries no alpha, names no colour space, warns about
 * no clipping and reports no contrast, and the design rules name it explicitly
 * as insufficient. Everything else here is the positive half: what replaced it
 * actually does those things.
 *
 * There is no raster surface in this DOM — happy-dom ships no canvas adapter, so
 * `getContext("2d")` returns null and `getBoundingClientRect()` is all zeros.
 * That is deliberate coverage rather than a limitation: the picker's value, its
 * keyboard path and its ARIA all have to work with the painted field absent,
 * because a control that only works once a canvas paints is a control that
 * breaks the first time one does not.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { ReactNode } from "react";
import Appearance from "../src/pages/Appearance";
import { ColorField } from "../src/components/appearance/ColorPicker";
import { FontPicker } from "../src/components/appearance/FontPicker";
import { TypographyEditor } from "../src/components/appearance/TypographyEditor";
import { LanguageProvider } from "../src/i18n/provider";
import { PrefsProvider } from "../src/theme/prefs";
import { NotificationsProvider } from "../src/shell/notifications";
import { GUI_BUNDLED_FAMILIES, resetGuiFontCatalogue } from "../src/theme/fonts";
import { parseColor, toCssValue } from "../../shared/m3/color";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // The catalogue is memoized across mounts on purpose (the probe is ~700
  // measurements); each test starts from a clean sweep against its own DOM.
  resetGuiFontCatalogue();
});

afterEach(() => {
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function mount(node: ReactNode): Promise<{ container: HTMLElement; root: Root }> {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <PrefsProvider>
        <LanguageProvider>
          <NotificationsProvider>{node}</NotificationsProvider>
        </LanguageProvider>
      </PrefsProvider>,
    );
  });
  return { container, root };
}

function click(el: Element | null | undefined): Promise<void> {
  return act(async () => {
    el?.dispatchEvent(new testWindow.Event("click", { bubbles: true }) as never);
  });
}

/**
 * React shadows `value` with an instance property so it can tell a real edit
 * from a programmatic assignment. Writing through the prototype setter bypasses
 * that tracker, which is what makes the dispatched `input` event look like typing.
 */
function typeInto(el: HTMLInputElement, value: string): void {
  const proto = Object.getPrototypeOf(el) as HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  el.dispatchEvent(new testWindow.Event("input", { bubbles: true }) as never);
}

/* ------------------------------------------------------- the audit finding -- */

test("the Appearance screen has no bare colour input left anywhere", async () => {
  const { container, root } = await mount(<Appearance />);
  expect(container.querySelectorAll('input[type="color"]').length).toBe(0);
  // And the thing that replaced them is present, once per colour control.
  expect(container.querySelectorAll(".ap-colorfield__trigger").length).toBeGreaterThan(0);
  await act(async () => { root.unmount(); });
});

test("the per-element editor offers the word-depth properties, not three of them", async () => {
  const { container, root } = await mount(<Appearance />);
  const labels = [...container.querySelectorAll(".m3-field-label")].map(node => node.textContent);
  // A representative spread across the groups: decoration, case, colour,
  // shadow and layout. Before this change the screen had family, a global size
  // scale and a global weight, and nothing else.
  for (const label of ["Strikethrough", "Capitalization", "Highlight", "Glow", "Character spacing", "Baseline shift"]) {
    expect(labels).toContain(label);
  }
  await act(async () => { root.unmount(); });
});

/* ------------------------------------------------------------ colour field -- */

async function openPicker(value: string | undefined = "#2f6b4f") {
  let latest = value;
  const Host = () => (
    <ColorField label="Accent" value={latest} onChange={next => { latest = next; }} />
  );
  const mounted = await mount(<Host />);
  await click(mounted.container.querySelector(".ap-colorfield__trigger"));
  return { ...mounted, read: () => latest };
}

test("the picker is a continuous field plus numeric entry, never a swatch grid", async () => {
  const { container, root } = await openPicker();

  // The 2-D field, keyboard-operable in its own right.
  const field = container.querySelector(".ap-picker__field");
  expect(field?.getAttribute("role")).toBe("application");
  expect(field?.getAttribute("tabindex")).toBe("0");

  // Continuous hue and alpha ramps.
  const ramps = [...container.querySelectorAll<HTMLInputElement>(".ap-picker__ramp")];
  expect(ramps.map(r => r.getAttribute("aria-label"))).toEqual(["Hue", "Opacity"]);
  expect(ramps.every(r => r.type === "range")).toBe(true);

  // Numeric entry for all three OKLCh components — the real controls, each
  // independently focusable and labelled.
  const numbers = [...container.querySelectorAll<HTMLInputElement>('.ap-picker__number input[type="number"]')];
  expect(numbers.map(n => n.getAttribute("aria-label"))).toEqual(["Lightness", "Chroma", "Hue"]);

  await act(async () => { root.unmount(); });
});

test("the translator covers every required colour space, each copyable", async () => {
  const { container, root } = await openPicker();

  const spaces = [...container.querySelectorAll(".ap-picker__space")].map(n => n.textContent);
  expect(spaces).toEqual([
    "Named", "HEX", "HEX8", "RGB", "RGBA", "HSL", "HSLA",
    "HSV / HSB", "HWB", "CIELAB", "CIE LCH", "OKLab", "OKLCH", "CMYK",
  ]);

  // Every row carries its own copy control, named for the space it copies.
  const copies = [...container.querySelectorAll(".ap-picker__translator button")]
    .map(n => n.getAttribute("aria-label"));
  expect(copies).toContain("Copy the OKLCH value");
  expect(copies.length).toBe(spaces.length);

  await act(async () => { root.unmount(); });
});

test("it names the gamut and reports contrast against the live surface", async () => {
  const { container, root } = await openPicker();

  expect(container.querySelector(".ap-picker__gamut")?.textContent).toContain("sRGB");
  const facts = [...container.querySelectorAll(".ap-picker__contrast")].map(n => n.textContent);
  expect(facts.length).toBe(2);
  expect(facts[0]).toContain("Contrast against the page");
  expect(facts[1]).toContain("Contrast against body text");
  // A real computed ratio, not a placeholder.
  expect(facts[0]).toMatch(/\d+\.\d\d:1/);

  await act(async () => { root.unmount(); });
});

test("a colour outside sRGB warns before it is clipped", async () => {
  const { container, root } = await openPicker("oklch(70% 0.34 150)");
  const warn = container.querySelector(".ap-picker__warn");
  expect(warn?.getAttribute("role")).toBe("status");
  expect(warn?.textContent).toContain("outside sRGB");
  expect(container.querySelector(".ap-picker__gamut")?.className).toContain("warn");
  await act(async () => { root.unmount(); });
});

test("alpha survives the round trip instead of being dropped", async () => {
  const { container, root, read } = await openPicker("#2f6b4f80");

  const alpha = container.querySelector<HTMLInputElement>(".ap-picker__ramp--alpha");
  expect(Number(alpha!.value)).toBeCloseTo(0x80 / 255, 2);

  await act(async () => { typeInto(alpha!, "0.25"); });
  const emitted = parseColor(read() ?? "");
  expect(emitted?.alpha).toBeCloseTo(0.25, 2);

  await act(async () => { root.unmount(); });
});

test("typing a word that is also an Object prototype key does not take the editor down", async () => {
  // `NAMED_COLORS` is an object literal, so a bare index for "constructor"
  // returned a function and the parser called `.trim()` on it. The value field
  // parses on every keystroke, so the word alone crashed the React tree.
  const { container, root } = await openPicker();
  const value = container.querySelector<HTMLInputElement>(".m3-input--mono");
  expect(value).toBeTruthy();

  for (const word of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    await act(async () => { typeInto(value!, word); });
    expect(container.querySelector(".ap-picker")).toBeTruthy();
  }
  // Reported as unreadable, and what was typed is still in the field.
  expect(value!.getAttribute("aria-invalid")).toBe("true");
  expect(value!.value).toBe("hasOwnProperty");

  await act(async () => { root.unmount(); });
});

test("an unreadable value is kept rather than silently turned into black", async () => {
  const { container, root, read } = await openPicker("#2f6b4f");
  const value = container.querySelector<HTMLInputElement>(".m3-input--mono");

  await act(async () => { typeInto(value!, "not a colour"); });
  expect(value!.value).toBe("not a colour");
  expect(value!.getAttribute("aria-invalid")).toBe("true");
  // Nothing was committed from the unparseable text.
  expect(read()).toBe("#2f6b4f");

  await act(async () => { root.unmount(); });
});

test("a typed colour in any space is accepted and normalised on the way out", async () => {
  const { container, root, read } = await openPicker("#2f6b4f");
  const value = container.querySelector<HTMLInputElement>(".m3-input--mono");

  await act(async () => { typeInto(value!, "hsl(120 50% 40%)"); });
  const emitted = parseColor(read() ?? "");
  expect(emitted).not.toBeNull();
  expect(toCssValue(emitted!)).toBe(read());

  await act(async () => { root.unmount(); });
});

test("Escape closes the picker and puts focus back on its trigger", async () => {
  const { container, root } = await openPicker();
  const trigger = container.querySelector<HTMLButtonElement>(".ap-colorfield__trigger");
  expect(container.querySelector(".ap-popover")).toBeTruthy();
  expect(trigger?.getAttribute("aria-expanded")).toBe("true");

  await act(async () => {
    document.dispatchEvent(new testWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as never);
  });

  expect(container.querySelector(".ap-popover")).toBeNull();
  expect(trigger?.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(trigger as unknown as Element);

  await act(async () => { root.unmount(); });
});

test("an unset colour reads as inheriting rather than as a fabricated black", async () => {
  const { container, root } = await mount(
    <ColorField label="Accent" value={undefined} onChange={() => {}} />,
  );
  expect(container.querySelector(".ap-colorfield__value")?.textContent).toBe("Inherits");
  expect(container.querySelector(".ap-colorfield__chip")?.hasAttribute("data-empty")).toBe(true);
  await act(async () => { root.unmount(); });
});

/* ------------------------------------------------------------- font picker -- */

test("the font picker lists the bundled faces and draws each name in itself", async () => {
  const { container, root } = await mount(<FontPicker value={undefined} onChange={() => {}} />);
  await act(async () => {});

  const rows = [...container.querySelectorAll(".ap-fonts__row")];
  const names = rows.map(r => r.querySelector(".ap-fonts__name")?.textContent);
  for (const family of GUI_BUNDLED_FAMILIES) {
    expect(names).toContain(family.family);
  }

  // The point of the list: the name is drawn in its own face, not the UI font.
  const robotoFlex = rows.find(r => r.querySelector(".ap-fonts__name")?.textContent === "Roboto Flex");
  expect(robotoFlex?.querySelector<HTMLElement>(".ap-fonts__name")?.style.fontFamily).toContain("Roboto Flex");
  expect(robotoFlex?.querySelector<HTMLElement>(".ap-fonts__sample")?.style.fontFamily).toContain("Roboto Flex");

  await act(async () => { root.unmount(); });
});

test("every bundled family has a CJK-safe tail so 廣東話 never renders as tofu", () => {
  for (const family of GUI_BUNDLED_FAMILIES) {
    // Either it names a CJK-capable face itself, or it falls through to one.
    expect(family.stack).toMatch(/Noto Sans HK|JhengHei|PingFang|monospace/);
  }
});

test("the picker says its list was measured rather than passing it off as your fonts", async () => {
  const { container, root } = await mount(<FontPicker value={undefined} onChange={() => {}} />);
  await act(async () => {});
  // No canvas here, so nothing could be measured at all — and it says exactly
  // that rather than "grant access", which would offer a route that could not
  // have produced a list either.
  expect(container.textContent).toContain("only the bundled families are listed");
  await act(async () => { root.unmount(); });
});

test("the search filters the list and reports an honest miss", async () => {
  const { container, root } = await mount(<FontPicker value={undefined} onChange={() => {}} />);
  await act(async () => {});

  const search = container.querySelector<HTMLInputElement>('input[type="search"]');
  await act(async () => { typeInto(search!, "mono"); });
  const names = [...container.querySelectorAll(".ap-fonts__name")].map(n => n.textContent);
  expect(names).toContain("Roboto Mono");
  expect(names).not.toContain("Roboto Flex");

  await act(async () => { typeInto(search!, "no-such-face"); });
  expect(container.querySelector(".ap-fonts__empty")?.textContent).toBe("No typeface matches that search.");

  await act(async () => { root.unmount(); });
});

test("a surface with nowhere to store axes is not given axis sliders", async () => {
  // The tab editor stores one stack and has no axis field. A slider that saves
  // nothing is worse than an honestly absent one.
  const stack = GUI_BUNDLED_FAMILIES[0].stack;
  const { container, root } = await mount(<FontPicker value={stack} onChange={() => {}} />);
  await act(async () => {});
  expect(container.querySelector(".ap-fonts__axes")).toBeNull();
  await act(async () => { root.unmount(); });
});

/* -------------------------------------------------------- typography panel -- */

test("an unsupported or unverifiable property stays visible and says why", async () => {
  const { container, root } = await mount(
    <TypographyEditor style={{}} onChange={() => {}} />,
  );

  // This DOM has no `CSS.supports`, so every probed capability resolves to
  // "unknown" — and the rule is that a control must not vanish on that basis. A
  // missing capability API is not evidence a feature is missing.
  const notes = [...container.querySelectorAll(".ap-cap")].map(n => n.textContent);
  expect(notes.length).toBeGreaterThan(0);
  expect(notes.some(n => n?.includes("could not be checked here"))).toBe(true);
  expect(notes.some(n => n?.includes("Your setting is saved either way"))).toBe(true);

  // The controls those notes describe are still on screen.
  const labels = [...container.querySelectorAll(".m3-field-label")].map(n => n.textContent);
  expect(labels).toContain("Slant");
  expect(labels).toContain("Underline");

  await act(async () => { root.unmount(); });
});

test("a partial capability explains the compromise rather than hiding it", async () => {
  const { container, root } = await mount(<TypographyEditor style={{}} onChange={() => {}} />);
  const notes = [...container.querySelectorAll(".ap-cap")].map(n => n.textContent).join("\n");
  // `strike` has no probe and is flagged degraded, so its caveat always shows.
  expect(notes).toContain("wavy underline and a double strike cannot both be shown");
  await act(async () => { root.unmount(); });
});

test("unset properties read as inheriting, and their reset is disabled not hidden", async () => {
  const { container, root } = await mount(<TypographyEditor style={{}} onChange={() => {}} />);

  const values = [...container.querySelectorAll(".m3-slider-value")].map(n => n.textContent);
  expect(values.every(v => v === "Inherits")).toBe(true);

  // Disabled rather than removed, so the rows do not change height as
  // properties are cleared and the control the user is reaching for does not
  // slide out from under the pointer.
  const resets = [...container.querySelectorAll<HTMLButtonElement>('button[aria-label^="Reset "]')];
  expect(resets.length).toBeGreaterThan(0);
  expect(resets.every(b => b.disabled)).toBe(true);

  await act(async () => { root.unmount(); });
});

test("a set property announces its real value, not the slider's fallback", async () => {
  const { container, root } = await mount(
    <TypographyEditor style={{ letterSpacing: 3 }} onChange={() => {}} />,
  );
  const slider = container.querySelector<HTMLInputElement>('input[aria-valuetext="3px"]');
  expect(slider).toBeTruthy();
  expect(slider!.value).toBe("3");
  await act(async () => { root.unmount(); });
});

test("clearing one property is reported as clearing exactly that one", async () => {
  const patches: Record<string, unknown>[] = [];
  const { container, root } = await mount(
    <TypographyEditor style={{ letterSpacing: 3, size: 20 }} onChange={patch => patches.push(patch)} />,
  );
  const reset = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find(b => b.getAttribute("aria-label") === "Reset Character spacing");
  await click(reset);
  // `undefined` means clear. A patch that omitted the key would mean "leave it".
  expect(patches).toEqual([{ letterSpacing: undefined }]);
  await act(async () => { root.unmount(); });
});
