/**
 * Toy locks on the per-tab/per-group appearance editor: "Lock this tab…" /
 * "Lock this group…", the gate that replaces the editable body while locked,
 * and that unlocking here is exactly as independent as everywhere else.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { ReactNode } from "react";
import type { Root } from "react-dom/client";

import TabAppearanceEditor from "../src/shell/TabAppearanceEditor";
import { TestLanguageProvider } from "./helpers/providers";
import { buttonWithText, clickUntil, setInputValue } from "./helpers/dom-interact";
import { createLock, findLock, isUnlocked } from "../src/shell/locks";

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "CustomEvent", "IS_REACT_ACT_ENVIRONMENT"] as const;
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
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
    CustomEvent: { configurable: true, value: testWindow.CustomEvent },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
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
    root.render(<TestLanguageProvider>{node}</TestLanguageProvider>);
  });
  return { container, root };
}

const click = (el: Element, until?: () => boolean | Promise<boolean>) => clickUntil(testWindow, el, until);
const setValue = (input: HTMLInputElement, value: string) => setInputValue(testWindow, input, value);

test("an unlocked tab shows \"Lock this tab…\" and every style control", async () => {
  const { container } = await mount(
    <TabAppearanceEditor kind="tab" id="tab1" label="Providers" anchor={null} onChange={() => {}} onClose={() => {}} />,
  );
  expect(container.textContent).toContain("Lock this tab…");
  // The ordinary editable surface is present and not gated away: the preview
  // heading and the reset-everything button both render normally.
  expect(container.textContent).toContain("Preview");
  expect(() => buttonWithText(container, "Reset every property")).not.toThrow();
});

test("a group offers \"Lock this group…\", not the tab wording", async () => {
  const { container } = await mount(
    <TabAppearanceEditor kind="group" id="grp1" label="Work" anchor={null} onChange={() => {}} onClose={() => {}} />,
  );
  expect(container.textContent).toContain("Lock this group…");
  expect(container.textContent).not.toContain("Lock this tab…");
});

test("a locked tab shows the unlock gate instead of the style controls, and unlocking reveals them", async () => {
  const lock = await createLock({
    kind: "tab", targetId: "tab2", label: "Combos",
    credential: { method: "password", password: "correct-password" },
    duration: "here", lockedOnLaunch: true,
  });
  const { container } = await mount(
    <TabAppearanceEditor kind="tab" id="tab2" label="Combos" anchor={null} onChange={() => {}} onClose={() => {}} />,
  );

  expect(container.textContent).toContain("Combos is locked");
  // The style controls are genuinely gone from the DOM, not just visually
  // hidden — the preview heading and the reset-all button are both inside the
  // gated section, and neither renders while it is gated.
  expect(container.textContent).not.toContain("Preview");
  expect(() => buttonWithText(container, "Reset every property")).toThrow();

  const password = container.querySelector('input[type="password"]') as HTMLInputElement;
  await setValue(password, "correct-password");
  await click(buttonWithText(container, "Unlock"), () => isUnlocked(lock.id));

  expect(isUnlocked(lock.id)).toBe(true);
  expect(container.textContent).toContain("Unlocked");
});

test("creating a lock from the tab editor itself produces a real, independently-credentialed lock", async () => {
  const { container } = await mount(
    <TabAppearanceEditor kind="tab" id="tab3" label="Storage" anchor={null} onChange={() => {}} onClose={() => {}} />,
  );
  await click(buttonWithText(container, "Lock this tab…"));
  await click(buttonWithText(container, "Next"));

  const password = [...container.querySelectorAll("label")]
    .find(l => l.textContent?.trim() === "Password")!
    .closest(".m3-field")!.querySelector("input") as HTMLInputElement;
  const confirm = [...container.querySelectorAll("label")]
    .find(l => l.textContent?.trim() === "Confirm password")!
    .closest(".m3-field")!.querySelector("input") as HTMLInputElement;
  await setValue(password, "a brand new password");
  await setValue(confirm, "a brand new password");
  await click(buttonWithText(container, "Next"));
  await click(buttonWithText(container, "Create lock"), () => findLock("tab", "tab3") !== undefined);

  const record = findLock("tab", "tab3")!;
  expect(record.kind).toBe("tab");
  // The panel immediately reflects its own new lock: unlocked (the wizard
  // just granted a session) and offering "Change credential" rather than
  // "Lock this tab…" a second time.
  expect(container.textContent).toContain("Change credential");
  expect(container.textContent).not.toContain("Lock this tab…");
});
