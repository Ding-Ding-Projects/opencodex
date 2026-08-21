import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  assertAllowedDesktopFeed,
  createDesktopAutoUpdater,
  parseSquirrelReleases,
  validateSquirrelPackage,
} from "../electron/auto-updater.mjs";

class FakeAutoUpdater {
  listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  feedUrl: string | null = null;
  checks = 0;
  installs = 0;
  stops = 0;

  on(event: string, listener: (...args: unknown[]) => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  emit(event: string, ...args: unknown[]) {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  setFeedURL(options: { url: string }) { this.feedUrl = options.url; }
  checkForUpdates() { this.checks += 1; }
  quitAndInstall() { this.installs += 1; }
  stopDownload() { this.stops += 1; }
}

describe("desktop Squirrel updater", () => {
  test("accepts only exact project feed shapes and rejects URL decorations or path normalization", () => {
    expect(assertAllowedDesktopFeed("https://update.electronjs.org/Ding-Ding-Projects/opencodex/win32-x64/2.7.42")).toBe(
      "https://update.electronjs.org/Ding-Ding-Projects/opencodex/win32-x64/2.7.42",
    );
    expect(assertAllowedDesktopFeed("https://github.com/Ding-Ding-Projects/opencodex/releases/latest/download/")).toBe(
      "https://github.com/Ding-Ding-Projects/opencodex/releases/latest/download/",
    );

    const credentialedFeed = "https://user:" + ["password", "github.com/Ding-Ding-Projects/opencodex/releases/download/v2.7.43/"].join("@");
    for (const feed of [
      "https://github.com.evil.example/Ding-Ding-Projects/opencodex/releases/download/v2.7.43/",
      credentialedFeed,
      "https://github.com:443/Ding-Ding-Projects/opencodex/releases/download/v2.7.43/",
      "https://github.com/Ding-Ding-Projects/opencodex/releases/download/v2.7.43/?channel=stable",
      "https://github.com/Ding-Ding-Projects/opencodex/releases/download/v2.7.43/#latest",
      "https://github.com/Ding-Ding-Projects/opencodex/releases/%64ownload/v2.7.43/",
      "https://github.com/Ding-Ding-Projects/opencodex/releases/download/v2.7.43/../latest/",
      "https://github.com/Ding-Ding-Projects/opencodex/releases/download/v2.7.43//",
      "https://github.com/Ding-Ding-Projects/opencodex/releases/download/v2.7.43/Setup.exe",
    ]) {
      expect(() => assertAllowedDesktopFeed(feed), feed).toThrow("HTTPS allowlisted");
    }
  });

  test("rejects a non-HTTPS or unallowlisted feed before touching Electron", async () => {
    const electronUpdater = new FakeAutoUpdater();
    const engine = createDesktopAutoUpdater({
      updater: electronUpdater,
      feedUrl: "http://evil.example/releases/",
      packaged: true,
    });

    await expect(engine.start()).rejects.toThrow("HTTPS allowlisted");
    expect(electronUpdater.checks).toBe(0);
  });

  test("maps the built-in Squirrel events and never installs before an explicit action", async () => {
    const electronUpdater = new FakeAutoUpdater();
    const states: string[] = [];
    let scheduled: (() => void) | null = null;
    const engine = createDesktopAutoUpdater({
      updater: electronUpdater,
      feedUrl: "https://github.com/Ding-Ding-Projects/opencodex/releases/download/v2.7.43/",
      packaged: true,
      onState: state => states.push(state.status),
      setIntervalFn: callback => { scheduled = callback; return 1; },
    });

    await engine.start();
    expect(electronUpdater.checks).toBe(1);
    electronUpdater.emit("checking-for-update");
    electronUpdater.emit("update-available", { version: "2.7.43" });
    electronUpdater.emit("download-progress", { percent: 42 });
    electronUpdater.emit("update-downloaded", { version: "2.7.43", releaseNotes: "https://github.com/Ding-Ding-Projects/opencodex/releases/tag/v2.7.43" });

    expect(states).toEqual(["checking", "available", "downloading", "ready"]);
    expect(electronUpdater.installs).toBe(0);
    expect(engine.snapshot()).toMatchObject({ status: "ready", version: "2.7.43", progress: 100 });
    expect(scheduled).toBeTruthy();
    await engine.install({ confirm: async () => false });
    expect(electronUpdater.installs).toBe(0);
    await engine.install({ confirm: async () => true });
    expect(electronUpdater.installs).toBe(1);
  });

  test("retries a transient initial check and keeps the bounded schedule alive across two ticks", async () => {
    const electronUpdater = new FakeAutoUpdater();
    let attempts = 0;
    const originalSetFeedURL = electronUpdater.setFeedURL.bind(electronUpdater);
    electronUpdater.setFeedURL = options => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary feed setup failure");
      originalSetFeedURL(options);
    };
    let scheduled: (() => Promise<unknown>) | null = null;
    const engine = createDesktopAutoUpdater({
      updater: electronUpdater,
      feedUrl: "https://github.com/Ding-Ding-Projects/opencodex/releases/download/v2.7.43/",
      packaged: true,
      setIntervalFn: callback => { scheduled = callback as () => Promise<unknown>; return 1; },
    });

    await expect(engine.start()).rejects.toThrow("temporary feed setup failure");
    expect(scheduled).toBeTruthy();
    expect(engine.snapshot().status).toBe("failed");

    await engine.start();
    expect(electronUpdater.checks).toBe(1);
    await scheduled!();
    await scheduled!();
    expect(electronUpdater.checks).toBe(3);
    expect(attempts).toBe(4);
  });

  test("cancels a download and keeps a failed/corrupt state visible", async () => {
    const electronUpdater = new FakeAutoUpdater();
    const engine = createDesktopAutoUpdater({
      updater: electronUpdater,
      feedUrl: "https://github.com/Ding-Ding-Projects/opencodex/releases/download/v2.7.43/",
      packaged: true,
    });
    await engine.start();
    electronUpdater.emit("download-progress", { percent: 12 });
    engine.cancel();
    expect(electronUpdater.stops).toBe(1);
    expect(engine.snapshot().status).toBe("cancelled");
    electronUpdater.emit("error", Object.assign(new Error("RELEASES hash mismatch"), { code: "ERR_SQUIRREL_HASH" }));
    expect(engine.snapshot().status).toBe("corrupt");
  });

  test("validates the RELEASES record against the downloaded package bytes", async () => {
    const bytes = new TextEncoder().encode("fake nupkg");
    const sha1 = createHash("sha1").update(bytes).digest("hex");
    const releases = parseSquirrelReleases(`${sha1} 10 opencodex-2.7.43-full.nupkg\n`);
    expect(releases).toHaveLength(1);
    expect(await validateSquirrelPackage(releases[0]!, bytes)).toEqual({ ok: true });
    expect(await validateSquirrelPackage(releases[0]!, new TextEncoder().encode("wrong"))).toMatchObject({ ok: false });
  });

  test("the desktop shell wires startup, manual check, cancellation, and explicit install IPC", async () => {
    const main = await Bun.file(new URL("../electron/main.mjs", import.meta.url)).text();
    const preload = await Bun.file(new URL("../electron/preload.cjs", import.meta.url)).text();
    expect(main).toContain("startDesktopUpdater();");
    const lifecycleAt = main.indexOf("app.whenReady().then(async () => {");
    const updaterFunctionAt = main.indexOf("function startDesktopUpdater()");
    const windowIpcAt = main.indexOf("/* ------------------------------------------------------------ window IPC -- */", updaterFunctionAt);
    const updaterFunction = main.slice(updaterFunctionAt, windowIpcAt);
    expect(updaterFunction).not.toContain("ensureProxy");
    expect(updaterFunction).not.toContain("stopProxy");
    const registerAt = main.indexOf("  registerWindowIpc();", lifecycleAt);
    const updaterAt = main.indexOf("  startDesktopUpdater();", lifecycleAt);
    const proxyAt = main.indexOf("    const started = await ensureProxy(DEFAULT_PORT", lifecycleAt);
    expect(registerAt).toBeGreaterThan(-1);
    expect(updaterAt).toBeGreaterThan(registerAt);
    expect(proxyAt).toBeGreaterThan(updaterAt);
    expect(main).toContain("proxy startup failed; keeping the desktop recovery shell alive");
    expect(main).not.toContain("    app.quit();\n    return;\n  }\n\n  registerWindowIpc();");
    expect(main).toContain('ipcMain.handle("desktop-update:check"');
    expect(main).toContain('ipcMain.handle("desktop-update:cancel"');
    expect(main).toContain('ipcMain.handle("desktop-update:install"');
    expect(main).toContain("desktopUpdater?.stop()");
    expect(preload).toContain('ipcRenderer.invoke("desktop-update:state")');
    expect(preload).toContain('ipcRenderer.invoke("desktop-update:install")');
    expect(preload).toContain('ipcRenderer.on("desktop-update:state"');
  });
});
