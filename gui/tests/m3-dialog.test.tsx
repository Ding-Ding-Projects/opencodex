/**
 * The shared Material 3 Dialog.
 *
 * Fifteen files were migrated onto this component in one pass, and the three
 * defects that survived review were all *its* gaps rather than mistakes in the
 * conversions: no `id`, no accessible name from `title`, no slot for a trailing
 * close button, and no focus restoration for the `{open && <Dialog/>}` pattern
 * every caller actually uses. Each case below is one of those, so a future
 * change to this component cannot quietly reintroduce them across the whole app.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";

import { Dialog } from "../src/shell/m3-ui";

const globals = ["document", "window", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(k => [k, Reflect.get(globalThis, k)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // happy-dom does not implement the top-layer methods the native element uses.
  const proto = testWindow.HTMLDialogElement?.prototype as unknown as Record<string, unknown> | undefined;
  if (proto) {
    proto.showModal = function showModal(this: HTMLDialogElement) { this.setAttribute("open", ""); };
    proto.show = function show(this: HTMLDialogElement) { this.setAttribute("open", ""); };
    proto.close = function close(this: HTMLDialogElement) { this.removeAttribute("open"); };
  }
});

afterEach(() => {
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function mount(node: React.ReactNode): Promise<{ container: HTMLElement; root: Root }> {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(node);
  });
  return { container, root };
}

test("a title gives the dialog an accessible name without the caller wiring one", async () => {
  // Requiring every caller to pass `labelledBy` by hand made "forgot to" the
  // default, and a dialog with no accessible name is announced as "dialog".
  const { container, root } = await mount(<Dialog onClose={() => {}} title="Delete API key" />);
  const dialog = container.querySelector("dialog")!;
  const labelledBy = dialog.getAttribute("aria-labelledby");
  expect(labelledBy).toBeTruthy();
  // getElementById rather than a `#id` selector: React's useId emits colons,
  // which are not valid in a CSS id selector without escaping.
  const heading = container.ownerDocument.getElementById(labelledBy!);
  expect(heading?.textContent).toBe("Delete API key");
  await act(async () => { root.unmount(); });
});

test("an explicit labelledBy wins, and no duplicate id is emitted", async () => {
  const { container, root } = await mount(
    <Dialog onClose={() => {}} labelledBy="mine" title={<span id="mine">Caller owns this</span>} />,
  );
  const dialog = container.querySelector("dialog")!;
  expect(dialog.getAttribute("aria-labelledby")).toBe("mine");
  // The generated id must not also land on the h2, or two elements claim it.
  expect(container.querySelector("h2")?.getAttribute("id")).toBeNull();
  await act(async () => { root.unmount(); });
});

test("an id lands on the dialog, so an aria-controls trigger still resolves", async () => {
  // Dropping the id orphaned four live `aria-controls` references on the
  // dashboard: triggers advertising a relationship to an element not in the DOM.
  const { container, root } = await mount(<Dialog onClose={() => {}} id="help-dialog" title="Help" />);
  expect(container.querySelector("dialog")?.getAttribute("id")).toBe("help-dialog");
  await act(async () => { root.unmount(); });
});

test("headAction renders outside the heading", async () => {
  // A close button nested in `title` becomes part of the h2's computed text, so
  // heading navigation announces "Help Close" instead of "Help".
  const { container, root } = await mount(
    <Dialog onClose={() => {}} title="Help" headAction={<button type="button">Close</button>} />,
  );
  const heading = container.querySelector("h2")!;
  expect(heading.textContent).toBe("Help");
  expect(heading.querySelector("button")).toBeNull();
  expect(container.querySelector(".m3-dialog__headaction button")?.textContent).toBe("Close");
  await act(async () => { root.unmount(); });
});

test("focus returns to the opener when the dialog is unmounted", async () => {
  // Callers render `{open && <Dialog/>}`, and removing an open <dialog> from the
  // DOM never runs the close algorithm — so the browser's own focus restoration
  // does not happen and focus silently drops to <body>.
  const opener = document.createElement("button");
  opener.textContent = "Open";
  document.body.append(opener);
  opener.focus();
  expect(document.activeElement).toBe(opener);

  const { root } = await mount(<Dialog onClose={() => {}} title="Confirm" />);
  await act(async () => { root.unmount(); });

  expect(document.activeElement).toBe(opener);
});

test("a non-modal dialog uses show(), leaving the background interactive", async () => {
  const calls: string[] = [];
  const proto = testWindow.HTMLDialogElement.prototype as unknown as Record<string, unknown>;
  proto.showModal = function showModal(this: HTMLDialogElement) { calls.push("showModal"); this.setAttribute("open", ""); };
  proto.show = function show(this: HTMLDialogElement) { calls.push("show"); this.setAttribute("open", ""); };

  const { container, root } = await mount(<Dialog onClose={() => {}} modal={false} title="Request detail" />);
  expect(calls).toEqual(["show"]);
  expect(container.querySelector("dialog")?.className).toContain("m3-dialog--nonmodal");
  await act(async () => { root.unmount(); });
});

test("a modal dialog traps focus via showModal()", async () => {
  const calls: string[] = [];
  const proto = testWindow.HTMLDialogElement.prototype as unknown as Record<string, unknown>;
  proto.showModal = function showModal(this: HTMLDialogElement) { calls.push("showModal"); this.setAttribute("open", ""); };
  proto.show = function show(this: HTMLDialogElement) { calls.push("show"); this.setAttribute("open", ""); };

  const { root } = await mount(<Dialog onClose={() => {}} title="Confirm" />);
  expect(calls).toEqual(["showModal"]);
  await act(async () => { root.unmount(); });
});

test("no legacy modal class survives on the dialog", async () => {
  const { container, root } = await mount(<Dialog onClose={() => {}} title="x" description="y" actions={<button type="button">OK</button>} />);
  const html = container.innerHTML;
  for (const legacy of ["modal-overlay", "modal-card", "modal-head", "modal-desc", "modal-actions"]) {
    expect(`${legacy}: ${html.includes(legacy)}`).toBe(`${legacy}: false`);
  }
  await act(async () => { root.unmount(); });
});
