/**
 * `PathInput` — the native Browse control beside every single-path text box.
 *
 * The recorded failure this suite is shaped against: *"a test that injects the
 * dependency proves the screen and nothing about the wiring."* A UI test with a
 * hand-made bridge object passes whether or not `electron/preload.cjs` actually
 * exposes `dialog.openPath`, or whether `electron/main.mjs` handles the channel
 * it invokes. Three separate defects of exactly that shape survived a
 * 5,600-test suite in this repo and were each found in the first minute of
 * opening the built app.
 *
 * So the last two tests here read the real preload and main-process sources and
 * assert the seam matches: same channel name on both sides, exposed under the
 * key the renderer reads. That is not a substitute for opening the built app --
 * it is the cheap half that catches a renamed channel.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { PathInput } from "../src/components/PathInput";
import { LanguageProvider } from "../src/i18n";
import { SettingsDraftProvider } from "../src/settings-drafts";

const ROOT_DIR = join(import.meta.dir, "..", "..");

// bun runs the whole `tests/` directory in one process, so every global set
// here is restored in afterEach -- a sibling file has been silently poisoned by
// a leaked non-writable global before.
const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(k => [k, Reflect.get(globalThis, k)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  const d = { configurable: true, writable: true, enumerable: true };
  Object.defineProperties(globalThis, {
    document: { ...d, value: testWindow.document },
    window: { ...d, value: testWindow },
    navigator: { ...d, value: testWindow.navigator },
    localStorage: { ...d, value: testWindow.localStorage },
    IS_REACT_ACT_ENVIRONMENT: { ...d, value: true },
  });
  container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.append(container as never);
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  for (const key of globals) {
    Object.defineProperty(globalThis, key, {
      configurable: true, writable: true, enumerable: true, value: previousGlobals[key],
    });
  }
});

async function render(node: React.ReactElement): Promise<void> {
  // Imported HERE, not at module scope. react-dom binds to the DOM globals it
  // sees when it is first evaluated, and `beforeEach` does not swap them in
  // until after module-level imports have already run -- so a top-level
  // `import { createRoot }` gives a renderer wired to the wrong environment.
  // It renders and looks right; what it does NOT do is deliver a dispatched
  // `input` event to React's listener, so a typing test fails while every
  // render assertion passes. Same shape as tests/app-logo-picker.test.tsx.
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(container);
    // LanguageProvider reads the language mode out of the settings drafts, so
    // the real provider stack is needed even for a single control.
    root.render(<SettingsDraftProvider><LanguageProvider>{node}</LanguageProvider></SettingsDraftProvider>);
  });
}

function browseButton(): HTMLButtonElement | null {
  return container.querySelector(".m3-pathinput__browse");
}

describe("PathInput", () => {
  it("renders no Browse button when there is no desktop shell to ask", async () => {
    // A browser cannot open a native dialog. The button is ABSENT rather than
    // disabled or inert: a control that looks like it works and does not is the
    // exact defect these rules forbid everywhere else, and a disabled button
    // with no explanation reads as broken rather than as unavailable.
    await render(<PathInput value="" onChange={() => {}} />);
    expect(browseButton()).toBeNull();
    expect(container.querySelector("input")).not.toBeNull();
  });

  it("puts a browsed path into the field", async () => {
    let seen = "";
    (testWindow as unknown as Record<string, unknown>).opencodexDesktop = {
      dialog: { openPath: async () => ({ ok: true, canceled: false, path: "C:\\picked\\file.json" }) },
    };
    await render(<PathInput value="" onChange={v => { seen = v; }} />);
    await act(async () => { browseButton()!.click(); });
    expect(seen).toBe("C:\\picked\\file.json");
  });

  it("leaves the field alone when the dialog is cancelled", async () => {
    // Cancelling is a normal outcome, not a failure: it must not clear the
    // field, and it must not raise an error the user has to dismiss.
    let calls = 0;
    (testWindow as unknown as Record<string, unknown>).opencodexDesktop = {
      dialog: { openPath: async () => ({ ok: true, canceled: true }) },
    };
    await render(<PathInput value="C:\\kept.json" onChange={() => { calls++; }} />);
    await act(async () => { browseButton()!.click(); });
    expect(calls).toBe(0);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("reports a failed dialog instead of silently doing nothing", async () => {
    (testWindow as unknown as Record<string, unknown>).opencodexDesktop = {
      dialog: { openPath: async () => ({ ok: false, canceled: false, error: "no window" }) },
    };
    await render(<PathInput value="" onChange={() => {}} />);
    await act(async () => { browseButton()!.click(); });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("no window");
  });

  it("gives the button its own accessible name, distinct from the field", async () => {
    (testWindow as unknown as Record<string, unknown>).opencodexDesktop = {
      dialog: { openPath: async () => ({ ok: true, canceled: true }) },
    };
    await render(<PathInput value="" onChange={() => {}} mode="directory" ariaLabel="Source" />);
    const button = browseButton()!;
    const input = container.querySelector("input")!;
    expect(button.getAttribute("aria-label")).toBeTruthy();
    expect(button.getAttribute("aria-label")).not.toBe(input.getAttribute("aria-label"));
    // The mode picks the label: a folder picker must not say "Browse file".
    expect(button.getAttribute("aria-label")).toContain("folder");
  });

  it("a typed path reaches onChange exactly as typed", async () => {
    // Free text stays available for whatever a picker cannot anticipate, and a
    // browsed value is not trusted more than a typed one -- both arrive here.
    let seen = "";
    await render(<PathInput value="" onChange={v => { seen = v; }} />);
    const input = container.querySelector("input")!;
    await act(async () => {
      // Same shape as tests/app-logo-picker.test.tsx's `typeInto`: the setter
      // has to come from the element's OWN prototype. Reaching for
      // `testWindow.HTMLInputElement.prototype` instead looks equivalent and is
      // not -- the descriptor found there does not drive this node, so the
      // dispatch is silently a no-op and the assertion fails for a reason with
      // nothing to do with the component.
      const proto = Object.getPrototypeOf(input) as HTMLInputElement;
      Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(input, "C:\\typed\\by\\hand.json");
      input.dispatchEvent(new testWindow.Event("input", { bubbles: true }) as never);
    });
    expect(seen).toBe("C:\\typed\\by\\hand.json");
  });

  describe("the seam the unit tests above stub", () => {
    it("preload exposes the channel the renderer invokes", () => {
      const preload = readFileSync(join(ROOT_DIR, "electron", "preload.cjs"), "utf-8");
      // The CLOSING quote is load-bearing. `toContain("dialog:open-path")`
      // matches `"dialog:open-path-RENAMED"` just as happily, so this assertion
      // was watched failing to catch exactly that rename before the delimiter
      // was added -- the substring trap this repo has been bitten by before.
      expect(preload).toContain('"dialog:open-path"');
      // Under the `dialog` key, because that is what `PathInput` reads off
      // `window.opencodexDesktop`. A rename on either side is invisible to
      // every test above, which supplies its own bridge object.
      expect(preload).toMatch(/dialog:\s*\{[\s\S]{0,400}?openPath/);
    });

    it("the main process handles that exact channel", () => {
      const main = readFileSync(join(ROOT_DIR, "electron", "main.mjs"), "utf-8");
      // Closing quote again, for the same reason as above.
      expect(main).toContain('ipcMain.handle("dialog:open-path"');
      // Modal to the asking window, or the picker can end up behind the app.
      expect(main).toMatch(/showOpenDialog\(\s*window/);
      expect(main).toMatch(/showSaveDialog\(\s*window/);
    });

    it("the pages that had path fields actually use PathInput", () => {
      // The other half of "wired at one end and consumed at neither": a bridge
      // nothing calls ships just as silently as a caller with no bridge.
      for (const page of ["Converter.tsx", "PdfTools.tsx"]) {
        const src = readFileSync(join(ROOT_DIR, "gui", "src", "pages", page), "utf-8");
        expect(src).toContain("PathInput");
      }
    });
  });
});
