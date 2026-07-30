import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The desktop shell's preload has to be CommonJS, and this test exists because
 * getting it wrong fails *silently*.
 *
 * The window runs with `sandbox: true`, and Electron only supports an ESM preload
 * when the sandbox is off. A `.mjs` preload in a sandboxed renderer never loads:
 * no exception, no console error, nothing in the main process log. It simply
 * means `window.opencodexDesktop` is undefined — which takes out the desktop
 * marker, `html[data-desktop]` (and with it the frameless window's entire drag
 * region, so the window cannot be moved), and the app bar's window controls. The
 * app looks correct in a screenshot and is broken in the hand.
 *
 * That shipped once, in a real signed installer. These assertions are cheap; the
 * failure mode is not.
 */

const ELECTRON_DIR = join(import.meta.dir, "..", "electron");

describe("desktop preload", () => {
  test("is CommonJS, because the renderer is sandboxed", () => {
    expect(existsSync(join(ELECTRON_DIR, "preload.cjs"))).toBe(true);
    // An .mjs preload alongside it would be dead weight at best and the wrong
    // file at worst — the packaged app has no way to tell you which one lost.
    expect(existsSync(join(ELECTRON_DIR, "preload.mjs"))).toBe(false);

    const preload = readFileSync(join(ELECTRON_DIR, "preload.cjs"), "utf8");
    expect(preload).toContain('require("electron")');
    // Any top-level ESM syntax makes the file unloadable as CommonJS.
    expect(/^\s*import\s/m.test(preload)).toBe(false);
    expect(/^\s*export\s/m.test(preload)).toBe(false);
  });

  test("main points at the CommonJS preload, and keeps the sandbox on", () => {
    const main = readFileSync(join(ELECTRON_DIR, "main.mjs"), "utf8");
    expect(main).toContain("preload.cjs");
    expect(main).not.toContain("preload.mjs");
    // If the sandbox is ever turned off, the ESM restriction above stops applying
    // — but so does a real security boundary. Either is a deliberate decision;
    // neither should happen by accident.
    expect(main).toContain("sandbox: true");
  });

  test("exposes the window controls the frameless chrome depends on", () => {
    const preload = readFileSync(join(ELECTRON_DIR, "preload.cjs"), "utf8");
    for (const api of ["customWindowControls", "minimize", "toggleMaximize", "close", "exitApp", "onMaximizedChanged"]) {
      expect(preload).toContain(api);
    }
    // Every invoke channel must have a handler on the other side, or the button
    // rejects at runtime with an unhandled promise and no visible cause.
    const main = readFileSync(join(ELECTRON_DIR, "main.mjs"), "utf8");
    const invoked = [...preload.matchAll(/ipcRenderer\.invoke\("([^"]+)"/g)].map(m => m[1]);
    expect(invoked.length).toBeGreaterThan(0);
    for (const channel of invoked) {
      expect(main).toContain(`ipcMain.handle("${channel}"`);
    }
  });
});
