import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import { createDesktopAutoUpdater } from "../electron/auto-updater.mjs";

/**
 * LEAK-01: createDesktopAutoUpdater() registers six `updater.on(...)` listeners
 * on the caller-supplied Electron `autoUpdater` singleton every time it is
 * constructed (electron/auto-updater.mjs:156-181), but stop() only clears the
 * polling interval (electron/auto-updater.mjs:219-223) — it never removes any
 * of those listeners. electron/main.mjs relies on stop() as the full teardown
 * for the engine it builds in startDesktopUpdater() ("app.on('before-quit', ...
 * desktopUpdater?.stop())"), so anything that rebuilds the engine against the
 * same long-lived Electron `autoUpdater` object (a retry path, a settings
 * change that re-runs startDesktopUpdater(), or simply a second test/fixture
 * reusing one fake updater) leaves the previous construction's six listeners
 * behind. Each stray listener still runs its closure over a now-abandoned
 * `state`/`onState`, so every subsequent Squirrel event fires once per
 * still-attached generation: duplicate "desktop-update:state" IPC broadcasts,
 * multiplying request counters, and eventually Node's MaxListenersExceeded
 * warning on the shared EventEmitter.
 *
 * This is a real, narrow "event listeners added and never removed" leak in
 * the leaks lens: the listener count on the shared updater should return to
 * zero once every constructed engine has been stopped, and today it does not.
 */
describe("hunt-leak LEAK-01: desktop auto-updater listeners survive stop()", () => {
  const FEED_URL = "https://github.com/Ding-Ding-Projects/opencodex/releases/download/v1.0.0/";
  const SQUIRREL_EVENTS = [
    "checking-for-update",
    "update-available",
    "download-progress",
    "update-not-available",
    "update-downloaded",
    "error",
  ] as const;

  /** Fake Electron autoUpdater: a real EventEmitter plus the four methods createDesktopAutoUpdater calls. */
  class FakeElectronAutoUpdater extends EventEmitter {
    feedUrl: string | null = null;
    setFeedURL(options: { url: string }) { this.feedUrl = options.url; }
    checkForUpdates() { /* no-op: never contacts the network in this test */ }
    stopDownload() { /* no-op */ }
    quitAndInstall() { /* no-op */ }
  }

  function totalListeners(updater: EventEmitter): number {
    return SQUIRREL_EVENTS.reduce((sum, event) => sum + updater.listenerCount(event), 0);
  }

  /** Never lets createDesktopAutoUpdater schedule a real OS timer. */
  function fakeScheduler() {
    let nextId = 0;
    return {
      setIntervalFn: () => { nextId += 1; return nextId; },
      clearIntervalFn: () => {},
    };
  }

  test("stop() removes every listener a construction registered, so two construct/stop cycles leave zero behind", async () => {
    const sharedUpdater = new FakeElectronAutoUpdater();
    expect(totalListeners(sharedUpdater)).toBe(0);

    const engineA = createDesktopAutoUpdater({
      updater: sharedUpdater,
      feedUrl: FEED_URL,
      packaged: true,
      ...fakeScheduler(),
    });
    await engineA.start();
    // Construction plus start() registered the six Squirrel listeners.
    expect(totalListeners(sharedUpdater)).toBe(SQUIRREL_EVENTS.length);

    engineA.stop();
    // A fully torn-down engine must leave the shared singleton exactly as it
    // found it -- electron/main.mjs trusts stop() to undo everything the
    // engine registered (it is the ONLY teardown call on the before-quit path).
    // Currently red: auto-updater.mjs's stop() never calls removeListener, so
    // this stays at 6 instead of dropping to 0.
    expect(totalListeners(sharedUpdater)).toBe(0);

    const engineB = createDesktopAutoUpdater({
      updater: sharedUpdater,
      feedUrl: FEED_URL,
      packaged: true,
      ...fakeScheduler(),
    });
    await engineB.start();
    engineB.stop();

    // Two independent construct -> start -> stop cycles against the same
    // singleton updater must not leave any accumulated listeners behind.
    // Currently red: this observes 12 (6 from engineA + 6 from engineB) rather
    // than 0, proving the leak compounds with every reconstruction.
    expect(totalListeners(sharedUpdater)).toBe(0);
  });

  test("a stray listener from a stopped engine still fires and publishes stale state", async () => {
    const sharedUpdater = new FakeElectronAutoUpdater();
    const statesA: string[] = [];
    const statesB: string[] = [];

    const engineA = createDesktopAutoUpdater({
      updater: sharedUpdater,
      feedUrl: FEED_URL,
      packaged: true,
      onState: state => statesA.push(state.status),
      ...fakeScheduler(),
    });
    await engineA.start();
    engineA.stop();
    statesA.length = 0; // ignore the startup "checking" publish; test only what happens after stop()

    const engineB = createDesktopAutoUpdater({
      updater: sharedUpdater,
      feedUrl: FEED_URL,
      packaged: true,
      onState: state => statesB.push(state.status),
      ...fakeScheduler(),
    });
    await engineB.start();
    statesB.length = 0;

    // Only engineB is live; a Squirrel event from here on should be observed
    // by engineB's onState alone.
    sharedUpdater.emit("update-available", { version: "9.9.9" });

    expect(statesB).toEqual(["available"]);
    // Currently red: engineA's stopped-but-never-detached listener still fires
    // and publishes into its own abandoned onState callback too.
    expect(statesA).toEqual([]);
  });
});
