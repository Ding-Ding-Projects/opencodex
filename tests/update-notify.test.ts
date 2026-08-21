import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cancelVersionRefreshSchedule,
  getUpgradeVersionForPopup,
  isNewer,
  isSourceBuildVersion,
  readVersionCache,
  scheduleVersionRefreshIfStale,
  refreshVersionCache,
  writeVersionCache,
  type VersionCache,
} from "../src/update/notify";
import { removeTempDir } from "./helpers/temp-dir";

const prevHome = process.env.OPENCODEX_HOME;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ocx-version-"));
  process.env.OPENCODEX_HOME = dir;
});

afterEach(() => {
  cancelVersionRefreshSchedule();
  if (prevHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = prevHome;
  try { removeTempDir(dir); } catch { /* ignore */ }
});

describe("bounded background version refresh scheduling", () => {
  test("schedules exactly one refresh when a long-running service crosses freshness", async () => {
    let timerCallback: (() => void) | undefined;
    let timerCount = 0;
    let refreshCount = 0;
    const timer = { unref: () => undefined };
    const now = Date.parse("2026-08-21T12:00:00.000Z");
    const cache: VersionCache = {
      latest_version: "2.7.0",
      last_checked_at: new Date(now).toISOString(),
      tag: "latest",
    };

    scheduleVersionRefreshIfStale("latest", cache, {
      now: () => now,
      setTimeoutFn: (callback, delay) => {
        timerCount += 1;
        expect(delay).toBe(20 * 60 * 60 * 1000);
        timerCallback = callback;
        return timer;
      },
      refreshFn: async () => { refreshCount += 1; },
    });
    scheduleVersionRefreshIfStale("latest", cache, {
      now: () => now,
      setTimeoutFn: () => { throw new Error("must stay single-flight"); },
      refreshFn: async () => { refreshCount += 1; },
    });

    expect(timerCount).toBe(1);
    timerCallback?.();
    await Promise.resolve();
    expect(refreshCount).toBe(1);
  });

  test("failed metadata refresh does not advance the successful timestamp", async () => {
    const cache: VersionCache = {
      latest_version: "2.7.0",
      last_checked_at: "2026-08-20T12:00:00.000Z",
      tag: "latest",
    };
    writeVersionCache(cache);
    await refreshVersionCache("latest", () => null);
    expect(readVersionCache("latest")).toMatchObject(cache);
  });

  test("shutdown cancellation clears the single scheduled timer", () => {
    let clearCount = 0;
    const timer = { unref: () => undefined };
    scheduleVersionRefreshIfStale("latest", null, {
      setTimeoutFn: () => timer,
      clearTimeoutFn: () => { clearCount += 1; },
    });
    cancelVersionRefreshSchedule();
    expect(clearCount).toBe(1);
    cancelVersionRefreshSchedule();
    expect(clearCount).toBe(1);
  });
});

describe("isNewer — latest channel", () => {
  test("higher patch/minor/major is newer", () => {
    expect(isNewer("2.7.0", "2.6.4", "latest")).toBe(true);
    expect(isNewer("2.6.5", "2.6.4", "latest")).toBe(true);
    expect(isNewer("3.0.0", "2.9.9", "latest")).toBe(true);
  });
  test("equal or older is not newer", () => {
    expect(isNewer("2.6.4", "2.6.4", "latest")).toBe(false);
    expect(isNewer("2.6.3", "2.6.4", "latest")).toBe(false);
  });
  test("prereleases are ignored on the stable channel", () => {
    expect(isNewer("2.7.0-preview.1", "2.6.4", "latest")).toBe(false);
  });
});

describe("isNewer — preview channel", () => {
  test("higher preview number on the same base is newer", () => {
    expect(isNewer("2.7.0-preview.5", "2.7.0-preview.3", "preview")).toBe(true);
  });
  test("equal preview is not newer", () => {
    expect(isNewer("2.7.0-preview.3", "2.7.0-preview.3", "preview")).toBe(false);
  });
  test("stable with a strictly higher base is newer than a preview (O3)", () => {
    expect(isNewer("2.8.0", "2.7.0-preview.3", "preview")).toBe(true);
  });
  test("stable with the same base as the preview is NOT newer (O3)", () => {
    expect(isNewer("2.7.0", "2.7.0-preview.5", "preview")).toBe(false);
  });
  test("higher base preview beats lower base preview", () => {
    expect(isNewer("2.8.0-preview.1", "2.7.0-preview.9", "preview")).toBe(true);
  });
});

describe("isSourceBuildVersion", () => {
  test("only 0.0.0 is a source build", () => {
    expect(isSourceBuildVersion("0.0.0")).toBe(true);
    expect(isSourceBuildVersion("2.6.4")).toBe(false);
  });
});

describe("version cache I/O", () => {
  const base: VersionCache = {
    latest_version: "2.7.0",
    last_checked_at: new Date().toISOString(),
    tag: "latest",
  };

  test("round-trips through the config dir", () => {
    writeVersionCache(base);
    expect(readVersionCache("latest")).toMatchObject({ latest_version: "2.7.0", tag: "latest" });
  });

  test("returns null when the cached channel differs (stale-channel invalidation)", () => {
    writeVersionCache(base);
    expect(readVersionCache("preview")).toBeNull();
  });

  test("missing cache reads as null", () => {
    expect(readVersionCache("latest")).toBeNull();
  });
});

describe("getUpgradeVersionForPopup", () => {
  const cache: VersionCache = {
    latest_version: "2.7.0",
    last_checked_at: new Date().toISOString(),
    tag: "latest",
  };

  test("surfaces a newer version", () => {
    expect(getUpgradeVersionForPopup(cache, "2.6.4", "latest")).toBe("2.7.0");
  });
  test("no popup when not newer", () => {
    expect(getUpgradeVersionForPopup(cache, "2.7.0", "latest")).toBeNull();
  });
  test("dismissed version is suppressed", () => {
    expect(getUpgradeVersionForPopup({ ...cache, dismissed_version: "2.7.0" }, "2.6.4", "latest")).toBeNull();
  });
  test("a strictly newer release re-surfaces after a dismissal", () => {
    const dismissed: VersionCache = { ...cache, latest_version: "2.7.1", dismissed_version: "2.7.0" };
    expect(getUpgradeVersionForPopup(dismissed, "2.6.4", "latest")).toBe("2.7.1");
  });
  test("null cache means no popup", () => {
    expect(getUpgradeVersionForPopup(null, "2.6.4", "latest")).toBeNull();
  });
});

describe("cli wiring", () => {
  const root = new URL("../", import.meta.url);
  const readText = (p: string) => Bun.file(new URL(p, root)).text();

  test("update prompt runs before the server binds a port", async () => {
    const cli = await readText("src/cli/index.ts");
    const promptIndex = cli.indexOf("await maybeShowUpdatePrompt()");
    const portIndex = cli.indexOf("let port = await chooseListenPort");
    const serverIndex = cli.indexOf("startServer(port)");
    expect(promptIndex).toBeGreaterThan(-1);
    expect(portIndex).toBeGreaterThan(-1);
    expect(promptIndex).toBeLessThan(portIndex);
    expect(promptIndex).toBeLessThan(serverIndex);
  });

  test("hidden __refresh-version subcommand is wired", async () => {
    const cli = await readText("src/cli/index.ts");
    expect(cli).toContain("case \"__refresh-version\"");
    expect(cli).toContain("refreshVersionCache");
  });
});
