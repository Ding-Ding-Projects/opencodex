/**
 * `AppLogoPicker` — the rendered surface for the app-logo customization
 * contract: presets (with a real, keyboard-operable search over them), the
 * custom-upload states, and the reset-to-shipped action. The byte-level
 * validation and store logic this component drives are already proven
 * exhaustively in `app-logo-format.test.ts` and `app-logo-store.test.ts`;
 * this file is about what actually renders and reacts live.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { AppLogoPicker } from "../src/components/appearance/AppLogoPicker";
import { TestProviders } from "./helpers/providers";
import {
  applyCustomLogo,
  LOGO_OUTPUT_SIZES,
  resetAppLogo,
  resetAppLogoForTests,
  selectLogoPreset,
  type CustomLogoAsset,
} from "../src/theme/app-logo";
import { probeImageBytes } from "../src/theme/app-logo-format";

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
  resetAppLogoForTests();
});

afterEach(() => {
  testWindow.close();
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  resetAppLogoForTests();
});

async function mount(): Promise<{ container: HTMLElement; root: Root }> {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <TestProviders>
        <AppLogoPicker />
      </TestProviders>,
    );
  });
  return { container, root };
}

function typeInto(el: HTMLInputElement, value: string): void {
  const proto = Object.getPrototypeOf(el) as HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  el.dispatchEvent(new testWindow.Event("input", { bubbles: true }) as never);
}

function pngDataUri(size: number): string {
  const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  const chunk = (type: string, data: number[]) => [
    ...u32(data.length), ...[...type].map(c => c.charCodeAt(0)), ...data, 0, 0, 0, 0,
  ];
  const bytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk("IHDR", [...u32(size), ...u32(size), 8, 6, 0, 0, 0]),
    ...chunk("IDAT", [0, 0, 0, 0]),
    ...chunk("IEND", []),
  ]);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:image/png;base64,${btoa(binary)}`;
}

function validAsset(): CustomLogoAsset {
  const variants: Record<number, string> = {};
  for (const size of LOGO_OUTPUT_SIZES) variants[size] = pngDataUri(size);
  return {
    format: "png",
    sourceWidth: 300,
    sourceHeight: 300,
    fit: "contain",
    background: null,
    focal: { x: 0.5, y: 0.5 },
    cropBox: null,
    variants,
  };
}

test("every shipped preset renders as a radio option, with the shipped mark checked by default", async () => {
  const { container, root } = await mount();

  const options = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
  expect(options.length).toBeGreaterThanOrEqual(4);
  const labels = options.map(o => o.getAttribute("aria-label"));
  expect(labels).toContain("Shipped mark");
  expect(labels).toContain("Circle badge");
  expect(labels).toContain("Square badge");
  expect(labels).toContain("Outline badge");

  const shipped = options.find(o => o.getAttribute("aria-label") === "Shipped mark");
  expect(shipped?.getAttribute("aria-checked")).toBe("true");
  const circle = options.find(o => o.getAttribute("aria-label") === "Circle badge");
  expect(circle?.getAttribute("aria-checked")).toBe("false");

  // No custom logo has ever been uploaded, and the reset control only makes
  // sense once the active mark is no longer the shipped one.
  const buttons = [...container.querySelectorAll("button")].map(b => b.textContent);
  expect(buttons).toContain("Upload a custom logo…");
  expect(buttons).not.toContain("Reset to shipped mark");

  await act(async () => { root.unmount(); });
});

test("the search bar filters presets to the ones whose label matches", async () => {
  const { container, root } = await mount();

  const search = container.querySelector<HTMLInputElement>("input[aria-label='Search logo presets']");
  expect(search).toBeTruthy();

  await act(async () => { typeInto(search!, "circle"); });
  const visible = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')].map(o => o.getAttribute("aria-label"));
  expect(visible).toEqual(["Circle badge"]);

  await act(async () => { typeInto(search!, "no such preset exists"); });
  expect(container.querySelectorAll('[role="radio"]').length).toBe(0);
  expect(container.querySelector("[role='status']")?.textContent).toBe("No preset matches that search.");

  await act(async () => { root.unmount(); });
});

test("selecting a preset checks it, unchecks the previous one, and reveals the reset control", async () => {
  const { container, root } = await mount();

  const circle = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    .find(o => o.getAttribute("aria-label") === "Circle badge")!;
  await act(async () => { circle.dispatchEvent(new testWindow.Event("click", { bubbles: true }) as never); });

  expect(circle.getAttribute("aria-checked")).toBe("true");
  const shipped = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    .find(o => o.getAttribute("aria-label") === "Shipped mark")!;
  expect(shipped.getAttribute("aria-checked")).toBe("false");

  const buttons = [...container.querySelectorAll("button")].map(b => b.textContent);
  expect(buttons).toContain("Reset to shipped mark");

  // The status line names the active preset in plain words.
  const status = [...container.querySelectorAll('[role="status"]')].find(el => el.textContent?.startsWith("Using"));
  expect(status?.textContent).toBe("Using Circle badge. No custom logo uploaded.");

  await act(async () => { root.unmount(); });
});

test("resetting after a preset selection returns to the shipped mark", async () => {
  const { container, root } = await mount();

  await act(async () => { selectLogoPreset("badge-outline"); });

  const resetButton = [...container.querySelectorAll("button")].find(b => b.textContent === "Reset to shipped mark");
  expect(resetButton).toBeTruthy();
  await act(async () => { resetButton!.dispatchEvent(new testWindow.Event("click", { bubbles: true }) as never); });

  const shipped = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    .find(o => o.getAttribute("aria-label") === "Shipped mark")!;
  expect(shipped.getAttribute("aria-checked")).toBe("true");
  expect([...container.querySelectorAll("button")].map(b => b.textContent)).not.toContain("Reset to shipped mark");

  await act(async () => { root.unmount(); });
});

test("an active custom logo renders the 'converted' state and offers Replace instead of Upload", async () => {
  const { container, root } = await mount();

  await act(async () => { applyCustomLogo(validAsset()); });

  const buttons = [...container.querySelectorAll("button")].map(b => b.textContent);
  expect(buttons).toContain("Replace custom logo…");
  expect(buttons).not.toContain("Upload a custom logo…");
  expect(buttons).toContain("Reset to shipped mark");

  const status = [...container.querySelectorAll('[role="status"]')].find(el => el.textContent?.startsWith("Custom logo active"));
  expect(status?.textContent).toBe("Custom logo active — 300×300 PNG, Contain fit.");

  // None of the presets are checked while a custom logo is the active source.
  const checked = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')].filter(o => o.getAttribute("aria-checked") === "true");
  expect(checked.length).toBe(0);

  await act(async () => { resetAppLogo(); });
  await act(async () => { root.unmount(); });
});

test("picking a file that is not a real image reports the 'invalid' state without changing the active logo", async () => {
  const { container, root } = await mount();

  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  expect(input).toBeTruthy();
  const junk = new File([new Uint8Array([1, 2, 3, 4])], "not-an-image.png", { type: "image/png" });
  // happy-dom's `files` is a read-only FileList in the platform sense, so the
  // test drives it the same way real browsers force a script to: by defining
  // the property directly, then dispatching the `change` event the handler
  // actually listens for.
  Object.defineProperty(input, "files", { configurable: true, value: [junk] });
  await act(async () => { input!.dispatchEvent(new testWindow.Event("change", { bubbles: true }) as never); });
  // Let the async onPick handler's microtasks settle.
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });

  expect(probeImageBytes(new Uint8Array([1, 2, 3, 4])).ok).toBe(false);
  const status = [...container.querySelectorAll('[role="status"]')].find(el => el.textContent?.includes("Could not use that file"));
  expect(status?.textContent).toBe("Could not use that file: Only PNG and JPEG images are supported.");

  // The rejection never touched the active source — still the shipped mark.
  const shipped = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    .find(o => o.getAttribute("aria-label") === "Shipped mark")!;
  expect(shipped.getAttribute("aria-checked")).toBe("true");

  await act(async () => { root.unmount(); });
});
