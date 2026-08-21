import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
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
    expect(main).toContain('ipcMain.handle("desktop-update:check"');
    expect(main).toContain('ipcMain.handle("desktop-update:cancel"');
    expect(main).toContain('ipcMain.handle("desktop-update:install"');
    expect(main).toContain("desktopUpdater?.stop()");
    expect(preload).toContain('ipcRenderer.invoke("desktop-update:state")');
    expect(preload).toContain('ipcRenderer.invoke("desktop-update:install")');
    expect(preload).toContain('ipcRenderer.on("desktop-update:state"');
  });
});
