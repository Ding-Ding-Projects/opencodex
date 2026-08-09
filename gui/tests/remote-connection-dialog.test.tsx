import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useState } from "react";
import type { Root } from "react-dom/client";

import RemoteConnectionDialog from "../src/components/RemoteConnectionDialog";
import { LanguageProvider } from "../src/i18n/provider";

const globals = [
  "document",
  "window",
  "navigator",
  "localStorage",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;

let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let root: Root | null = null;

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

  const proto = testWindow.HTMLDialogElement.prototype as unknown as Record<string, unknown>;
  proto.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
    (this.querySelector("input, button") as HTMLElement | null)?.focus();
  };
  proto.show = function show(this: HTMLDialogElement) { this.setAttribute("open", ""); };
  proto.close = function close(this: HTMLDialogElement) { this.removeAttribute("open"); };
});

afterEach(async () => {
  if (root) await act(async () => { root?.unmount(); });
  root = null;
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function mount(node: React.ReactNode): Promise<HTMLElement> {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider>{node}</LanguageProvider>);
  });
  return container;
}

async function setInput(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")?.set;
  if (!setter) throw new Error("input value setter unavailable");
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
    input.dispatchEvent(new testWindow.Event("change", { bubbles: true }));
  });
}

function buttonNamed(container: HTMLElement, name: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find(candidate => candidate.textContent === name);
  if (!button) throw new Error(`button not found: ${name}`);
  return button as HTMLButtonElement;
}

test("the modal is named, described, focused, and validates the exact host field", async () => {
  const connected: string[] = [];
  const container = await mount(
    <RemoteConnectionDialog open onClose={() => {}} onConnect={url => connected.push(url)} />,
  );

  const dialog = container.querySelector("dialog")!;
  expect(dialog.hasAttribute("open")).toBe(true);
  const labelledBy = dialog.getAttribute("aria-labelledby")!;
  const describedBy = dialog.getAttribute("aria-describedby")!;
  expect(document.getElementById(labelledBy)?.textContent).toBe("Connect to another OpenCodex");
  expect(document.getElementById(describedBy)?.textContent).toContain("standard port");

  const host = container.querySelector<HTMLInputElement>("#ocx-remote-host")!;
  const port = container.querySelector<HTMLInputElement>("#ocx-remote-port")!;
  expect(document.activeElement).toBe(host);
  expect(port.value).toBe("10100");
  expect(buttonNamed(container, "Connect").disabled).toBe(true);

  await setInput(host, "010.000.000.001");
  expect(host.getAttribute("aria-invalid")).toBe("true");
  const errorId = host.getAttribute("aria-describedby")!;
  expect(document.getElementById(errorId)?.getAttribute("role")).toBe("alert");
  expect(document.getElementById(errorId)?.textContent).toContain("leading zeroes");
  expect(connected).toEqual([]);

  await setInput(host, "Remote.Example.Test");
  await setInput(port, "12345");
  expect(host.getAttribute("aria-invalid")).toBe("false");
  expect(buttonNamed(container, "Connect").disabled).toBe(false);
  const storageBeforeConnect = { ...localStorage };
  await act(async () => {
    container.querySelector("form")!.dispatchEvent(new testWindow.Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(connected).toEqual(["http://remote.example.test:12345"]);
  expect({ ...localStorage }).toEqual(storageBeforeConnect);
});

test("closing and reopening mounts a fresh form and restores trigger focus", async () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" id="remote-trigger" onClick={() => setOpen(true)}>Open remote</button>
        <RemoteConnectionDialog
          key={open ? "open" : "closed"}
          open={open}
          onClose={() => setOpen(false)}
          onConnect={() => {}}
        />
      </>
    );
  }

  const container = await mount(<Harness />);
  const trigger = container.querySelector<HTMLButtonElement>("#remote-trigger")!;
  trigger.focus();
  await act(async () => { trigger.click(); });
  await setInput(container.querySelector<HTMLInputElement>("#ocx-remote-host")!, "bad host");
  expect(container.querySelector("[role=alert]")).not.toBeNull();

  await act(async () => { buttonNamed(container, "Cancel").click(); });
  expect(container.querySelector("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);

  await act(async () => { trigger.click(); });
  expect(container.querySelector<HTMLInputElement>("#ocx-remote-host")?.value).toBe("");
  expect(container.querySelector<HTMLInputElement>("#ocx-remote-port")?.value).toBe("10100");
  expect(container.querySelector("[role=alert]")).toBeNull();
});

test("native Escape cancellation closes through React state", async () => {
  let closes = 0;
  const container = await mount(
    <RemoteConnectionDialog open onClose={() => { closes += 1; }} onConnect={() => {}} />,
  );
  const event = new testWindow.Event("cancel", { bubbles: false, cancelable: true });
  await act(async () => { container.querySelector("dialog")!.dispatchEvent(event); });
  expect(event.defaultPrevented).toBe(true);
  expect(closes).toBe(1);
});
