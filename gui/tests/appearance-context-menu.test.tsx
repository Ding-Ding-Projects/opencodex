/**
 * Right-click reaching the whole app, not three pieces of chrome.
 *
 * `useAppearanceTarget` was spread by hand in exactly three components — the nav
 * rail, the app bar and the tab strip — so those three had a context menu and
 * nothing else did. Every card, button, field, chip, table and menu across
 * twenty-two pages had no route in at all, even though `ELEMENT_SELECTORS`
 * already said where they lived and the Appearance screen could already style
 * them. `ElementAppearanceHost` now delegates from `document`, which is what
 * makes "every rendered element" true without a hundred call sites remembering
 * a hook.
 *
 * These tests drive real `contextmenu` events at real nodes rather than calling
 * the resolver directly. The resolver being right is not the claim — the claim
 * is that right-clicking a card opens the card's editor, and only an event that
 * travels the same path a mouse takes can show that. In particular the "does
 * nothing" cases matter as much as the positive ones: a delegate that swallows
 * every right-click in the app would pass a naive test and take the platform's
 * paste menu away from every text field in it.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { ReactNode } from "react";
import type { Root } from "react-dom/client";

import ElementAppearanceHost from "../src/shell/ElementAppearanceHost";
import { LanguageProvider } from "../src/i18n/provider";
import { PrefsProvider } from "../src/theme/prefs";

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
          <ElementAppearanceHost>{node}</ElementAppearanceHost>
        </LanguageProvider>
      </PrefsProvider>,
    );
  });
  return { container, root };
}

/** A right-click at the given node, as a mouse actually delivers one. */
async function rightClick(node: Element, init: { shiftKey?: boolean } = {}): Promise<boolean> {
  const event = new testWindow.MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    ...init,
  }) as unknown as MouseEvent;
  await act(async () => { node.dispatchEvent(event); });
  return event.defaultPrevented;
}

/** The anchored editor, identified by the attribute it renders itself with. */
function openEditor(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-element-style-editor]");
}

function openMenu(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-appearance-menu]");
}

test("right-clicking a card opens that card's editor", async () => {
  const { container } = await mount(<div className="m3-card"><p>Providers</p></div>);
  const card = container.querySelector(".m3-card")!;

  expect(openEditor()).toBeNull();
  const handled = await rightClick(card);

  expect(handled).toBe(true);
  expect(openEditor()?.getAttribute("data-element-style-editor")).toBe("card");
});

test("right-clicking inside a card offers the thing clicked and the card", async () => {
  // The realistic case: nobody right-clicks the one pixel of padding between a
  // card's border and its content, so resolving only the exact node under the
  // pointer would leave the feature looking broken everywhere it matters.
  //
  // `.m3-card-title` is not a curated target and does not need to be — it is
  // derived as `auto:span.m3-card-title`, which is what makes "every rendered
  // element" true rather than "the sixteen we remembered". So the click offers
  // both, nearest first, and the card is still one keystroke away.
  const { container } = await mount(
    <div className="m3-card"><span className="m3-card-title">Accounts</span></div>,
  );
  await rightClick(container.querySelector(".m3-card-title")!);

  const items = [...(openMenu()?.querySelectorAll("button") ?? [])].map(b => b.textContent ?? "");
  expect(items.length).toBe(2);
  // Derived targets carry no translation and cannot have one — nobody can
  // pre-translate a class name — so they are named from the id itself.
  expect(items[0]).toContain("Card title");
  expect(items[1]).toContain("Cards");

  await act(async () => { openMenu()!.querySelectorAll("button")[1].click(); });
  expect(openEditor()?.getAttribute("data-element-style-editor")).toBe("card");
});

test("a class-less container is not offered as a target", async () => {
  // `targetFor` will return `auto:div` for a bare `<div>`, which means "every
  // div in the app" — never what someone right-clicking one thing intends, and
  // not harmless: almost everything has a bare div above it, so accepting them
  // put a useless second row in the menu on nearly every click and stopped the
  // editor opening directly.
  const { container } = await mount(<div><div className="m3-card">Providers</div></div>);
  await rightClick(container.querySelector(".m3-card")!);

  expect(openMenu()).toBeNull();
  expect(openEditor()?.getAttribute("data-element-style-editor")).toBe("card");
});

test("a surface with no curated target of its own is still reachable", async () => {
  // The whole point of the derived half. `.provider-row` is not in the selector
  // table and never will be — the table was always going to be shorter than the
  // app.
  const { container } = await mount(<div className="provider-row">openai</div>);
  await rightClick(container.querySelector(".provider-row")!);

  expect(openEditor()?.getAttribute("data-element-style-editor")).toBe("auto:div.provider-row");
});

test("a button inside a card offers both, nearest first", async () => {
  const { container } = await mount(
    <div className="m3-card"><button type="button" className="m3-btn">Save</button></div>,
  );
  await rightClick(container.querySelector(".m3-btn")!);

  // A menu rather than a straight-to-editor jump: the pointer genuinely sat
  // inside two editable surfaces, and guessing which one was meant is how a user
  // ends up restyling the card when they wanted the button.
  const menu = openMenu();
  expect(menu).not.toBeNull();
  expect(openEditor()).toBeNull();

  const items = [...menu!.querySelectorAll("button")].map(b => b.textContent ?? "");
  expect(items.length).toBe(2);
  expect(items[0]).toContain("Filled buttons");
  expect(items[1]).toContain("Cards");

  await act(async () => { menu!.querySelectorAll("button")[1].click(); });
  expect(openEditor()?.getAttribute("data-element-style-editor")).toBe("card");
  expect(openMenu()).toBeNull();
});

test("the surfaces that previously had no route in are all reachable", async () => {
  // One assertion per surface would pass with three of them silently detached,
  // because each is a separate test that can be read as "the others are covered
  // elsewhere". Together, they are the claim.
  const cases: [string, string][] = [
    ["m3-icon-btn", "iconButton"],
    ["m3-chip", "chip"],
    ["m3-table", "table"],
    ["m3-menu", "menu"],
  ];
  const found: string[] = [];
  for (const [className] of cases) {
    const { container, root } = await mount(<div className={className}>x</div>);
    await rightClick(container.querySelector(`.${className}`)!);
    found.push(openEditor()?.getAttribute("data-element-style-editor") ?? "none");
    await act(async () => { root.unmount(); });
    container.remove();
  }
  expect(found).toEqual(cases.map(([, id]) => id));
});

test("a plain right-click on a text field keeps the platform's own menu", async () => {
  // Cut/copy/paste is used constantly and the styling dialog is used once. Taking
  // the first away to offer the second is a straight downgrade, so the delegate
  // stands down here and `preventDefault` is never called — which is what lets
  // the browser show its own menu.
  const { container } = await mount(<input className="m3-input" defaultValue="hi" />);
  const handled = await rightClick(container.querySelector(".m3-input")!);

  expect(handled).toBe(false);
  expect(openEditor()).toBeNull();
  expect(openMenu()).toBeNull();
});

test("Shift+right-click reaches the field's appearance anyway", async () => {
  const { container } = await mount(<input className="m3-input" defaultValue="hi" />);
  const handled = await rightClick(container.querySelector(".m3-input")!, { shiftKey: true });

  expect(handled).toBe(true);
  expect(openEditor()?.getAttribute("data-element-style-editor")).toBe("input");
});

test("a surface with its own menu keeps it", async () => {
  // The tab strip has ten commands of its own and calls `preventDefault`. A
  // delegate that ignored that would open two menus on one click.
  function OwnMenu() {
    return (
      <div className="m3-card">
        <button type="button" className="m3-btn" onContextMenu={e => e.preventDefault()}>Tab</button>
      </div>
    );
  }
  const { container } = await mount(<OwnMenu />);
  await rightClick(container.querySelector(".m3-btn")!);

  expect(openEditor()).toBeNull();
  expect(openMenu()).toBeNull();
});

test("right-clicking nothing in particular does nothing", async () => {
  const { container } = await mount(<p>just some prose</p>);
  const handled = await rightClick(container.querySelector("p")!);

  expect(handled).toBe(false);
  expect(openEditor()).toBeNull();
});

test("the editor's own controls are not themselves right-click targets", async () => {
  // Otherwise a style that made the editor unreadable would also make the reset
  // button that undoes it unreachable.
  const { container } = await mount(<div className="m3-card">x</div>);
  await rightClick(container.querySelector(".m3-card")!);
  const editor = openEditor();
  expect(editor).not.toBeNull();

  const inside = editor!.querySelector("button")!;
  const handled = await rightClick(inside);
  expect(handled).toBe(false);
});
