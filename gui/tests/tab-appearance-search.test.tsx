/**
 * The per-tab appearance editor's settings search.
 *
 * The defect this guards is specific and silent: every control in this panel is
 * now wrapped in `matches("id")`, and those ids are plain string literals matched
 * against a hand-written option list. TypeScript cannot check a string against a
 * string, so a renamed option or a mistyped `matches("colour")` compiles happily
 * and makes that control **disappear from the panel the moment anyone types** —
 * the search would look like it worked, and the setting would look like it had
 * been removed from the product.
 *
 * The first test is therefore the important one: with an empty field the panel
 * must render every control it rendered before the search existed. The rest cover
 * the searching itself, and the rule that an appearance editor is a settings
 * surface like any other.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import TabAppearanceEditor from "../src/shell/TabAppearanceEditor";
import type { TabStyle } from "../src/shell/use-tabs";

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
});

afterEach(() => {
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

/* The editor takes the styled record's identity and style directly rather than a
   whole `Tab`, because a group header has a style and no tab behind it. */
const STYLE: TabStyle = { color: "#ff0000", badge: "beta" };

async function mount(node: React.ReactNode): Promise<{ container: HTMLElement; root: Root }> {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider>{node}</LanguageProvider>);
  });
  return { container, root };
}

async function open() {
  return mount(
    <TabAppearanceEditor
      kind="tab"
      id="t1"
      style={STYLE}
      label="Settings"
      anchor={null}
      onChange={() => {}}
      onClose={() => {}}
    />,
  );
}

const field = (c: HTMLElement) => c.querySelector<HTMLInputElement>('input[type="search"]')!;
/** Every control the panel offers, by its accessible name. */
const namesOf = (c: HTMLElement) =>
  [...c.querySelectorAll<HTMLElement>("input, select, button")]
    .map(el => el.getAttribute("aria-label") ?? el.textContent ?? "")
    .filter(Boolean);

function typeInto(el: HTMLInputElement, value: string): void {
  const proto = Object.getPrototypeOf(el) as HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  el.dispatchEvent(new testWindow.Event("input", { bubbles: true }) as never);
}

/* ------------------------------------------------- nothing hidden by default -- */

// The regression that would be invisible in review: one mistyped id and that
// control is gone from the product, for everyone, the moment they search.
test("with an empty field every appearance control is still rendered", async () => {
  const { container, root } = await open();
  const names = namesOf(container).join(" | ");

  for (const expected of ["Label colour", "Background", "Font", "Label size", "Label weight", "Badge"]) {
    expect(names).toContain(expected);
  }
  // The reset-all action too — it is an option in the index, so a typo there
  // hides it exactly the same way.
  expect(names).toContain("Reset every property");

  await act(async () => { root.unmount(); });
});

/* ------------------------------------------------------------- it filters -- */

test("typing narrows the panel to the matching control", async () => {
  const { container, root } = await open();

  await act(async () => { typeInto(field(container), "badge"); });
  const names = namesOf(container).join(" | ");

  expect(names).toContain("Badge");
  expect(names).not.toContain("Background");
  expect(names).not.toContain("Weight");

  await act(async () => { root.unmount(); });
});

// Rule 1 of the contract: a control is findable by what it currently reads, not
// only by its name. This tab's colour is #ff0000 and its badge says "beta".
test("a control is findable by its current value", async () => {
  const { container, root } = await open();

  await act(async () => { typeInto(field(container), "#ff0000"); });
  const byValue = namesOf(container).join(" | ");
  expect(byValue).toContain("Label colour");
  // Only that control: the value is what narrowed it, so nothing else may survive.
  expect(byValue).not.toContain("Background");

  await act(async () => { typeInto(field(container), "beta"); });
  expect(namesOf(container).join(" | ")).toContain("Badge");

  await act(async () => { root.unmount(); });
});

// The preview is what is being edited, not one of the things being searched —
// filtering it away would leave the user changing something they cannot see.
test("the preview survives a query that matches no control", async () => {
  const { container, root } = await open();
  await act(async () => { typeInto(field(container), "zzzzz"); });

  expect(container.textContent).toContain("Preview");
  // And the field itself is still there, or there would be no way to undo the search.
  expect(field(container)).not.toBeNull();

  await act(async () => { root.unmount(); });
});

/* --------------------------------------------------------- the builder is here -- */

test("the panel's search reaches the regex builder, anchored inside the panel", async () => {
  const { container, root } = await open();

  const triggers = [...container.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="dialog"]')];
  expect(triggers.length).toBe(1);
  expect(triggers[0]!.getAttribute("aria-label")).toBe("Open regex builder");

  await act(async () => { triggers[0]!.click(); });
  // Inside this panel, not a navigation to the builder page — the editor is
  // itself a popover, and losing it to a route change loses the tab being edited.
  expect(container.querySelector('[role="dialog"].m3-rxpop')).not.toBeNull();
  expect(container.querySelector('a[href="#regex"]')).toBeNull();

  await act(async () => { root.unmount(); });
});
