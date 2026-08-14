/**
 * The desktop-bridge-or-honest-fallback split behind the recovery route.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { hasDesktopAppDataBridge, openAppDataFolder, resolveAppDataPath } from "../src/shell/app-data-path";

afterEach(() => {
  delete (globalThis as unknown as { opencodexDesktop?: unknown }).opencodexDesktop;
});

describe("no desktop bridge (plain browser context)", () => {
  test("hasDesktopAppDataBridge is false", () => {
    expect(hasDesktopAppDataBridge()).toBe(false);
  });

  test("resolveAppDataPath resolves null rather than throwing", async () => {
    expect(await resolveAppDataPath()).toBeNull();
  });

  test("openAppDataFolder resolves false rather than throwing", async () => {
    expect(await openAppDataFolder()).toBe(false);
  });
});

describe("the desktop bridge present", () => {
  function install(bridge: { path: () => Promise<string>; open: () => Promise<{ ok: boolean; path: string; error?: string }> }) {
    (globalThis as unknown as { opencodexDesktop: unknown }).opencodexDesktop = { isDesktop: true, appData: bridge };
  }

  test("resolveAppDataPath returns the bridge's real resolved path", async () => {
    install({ path: async () => "C:\\Users\\swiftie\\AppData\\Roaming\\opencodex", open: async () => ({ ok: true, path: "" }) });
    expect(await resolveAppDataPath()).toBe("C:\\Users\\swiftie\\AppData\\Roaming\\opencodex");
  });

  test("openAppDataFolder reports the bridge's own success", async () => {
    install({ path: async () => "/x", open: async () => ({ ok: true, path: "/x" }) });
    expect(await openAppDataFolder()).toBe(true);
  });

  test("openAppDataFolder reports the bridge's own failure honestly", async () => {
    install({ path: async () => "/x", open: async () => ({ ok: false, path: "/x", error: "no file manager" }) });
    expect(await openAppDataFolder()).toBe(false);
  });

  test("a bridge call that throws resolves the honest fallback rather than propagating", async () => {
    install({ path: async () => { throw new Error("ipc gone"); }, open: async () => { throw new Error("ipc gone"); } });
    expect(await resolveAppDataPath()).toBeNull();
    expect(await openAppDataFolder()).toBe(false);
  });
});
