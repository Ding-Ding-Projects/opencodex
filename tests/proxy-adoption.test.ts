/**
 * Which opencodex the desktop shell is allowed to attach to.
 *
 * This is the logic behind a bug report that reads as three separate
 * complaints — "the app is not showing updated page after downloading new
 * update", "version number is always the same" — and is one mechanism.
 *
 * The desktop shell does not serve the dashboard; the proxy does, out of its own
 * install directory. `ensureProxy` adopted anything answering `/healthz` with
 * `service: "opencodex"`, which is indistinguishable from the *previous version
 * of the app itself* still resident in the tray. Launch the updated app, attach
 * to the old proxy, get the old `gui/dist` — and because `package.json` moves
 * only on an npm release, the version banner reads identically either way. The
 * update genuinely installed and there was nothing on screen that could show it.
 *
 * So these tests are mostly about the *negative* cases. A guard that adopts too
 * eagerly is exactly what shipped, and it looked completely fine.
 */

import { describe, expect, test } from "bun:test";
import { readBuildStamp, sameBuild } from "../electron/build-stamp.mjs";
import { describeConflict, planProxyAdoption } from "../electron/proxy-adoption.mjs";

const RELEASE = { version: "2.7.42", build: "116", commit: "1e4ba4ea6e90d99e73f1fa6f8cf415cb1ea440f3" };
const NEXT = { version: "2.7.42", build: "117", commit: "aaaabbbbccccddddeeeeffff0000111122223333" };

/** A `/healthz` body for a proxy running `stamp`. */
function healthz(stamp: Partial<typeof RELEASE> & { service?: string; pid?: number } = {}) {
  return {
    status: "ok",
    service: "opencodex",
    version: "2.7.42",
    uptime: 12,
    pid: 4242,
    port: 10100,
    ...stamp,
  };
}

describe("reading this install's stamp", () => {
  const tree = (files: Record<string, string>) => (path: string) => {
    const key = Object.keys(files).find(name => path.endsWith(name));
    if (!key) throw new Error(`ENOENT ${path}`);
    return files[key];
  };

  test("takes the run number and commit from build-info.json", () => {
    const stamp = readBuildStamp("/app", tree({
      "package.json": JSON.stringify({ version: "2.7.42" }),
      "build-info.json": JSON.stringify({ build: "116", commit: RELEASE.commit }),
    }));
    expect(stamp).toEqual(RELEASE);
  });

  test("says dev rather than inventing one when CI never wrote the file", () => {
    // The important half. A fabricated build id would be compared as a real
    // identity below, so "I do not know" has to survive as a distinct answer.
    const stamp = readBuildStamp("/checkout", tree({
      "package.json": JSON.stringify({ version: "2.7.42" }),
    }));
    expect(stamp).toEqual({ version: "2.7.42", build: "dev", commit: "" });
  });

  test("an unreadable package.json does not stop the app knowing anything", () => {
    const stamp = readBuildStamp("/broken", () => { throw new Error("EACCES"); });
    expect(stamp).toEqual({ version: "0.0.0", build: "dev", commit: "" });
  });

  test("a build-info.json with the wrong shape is ignored, not trusted", () => {
    const stamp = readBuildStamp("/odd", tree({
      "package.json": JSON.stringify({ version: "2.7.42" }),
      "build-info.json": JSON.stringify({ build: 116, commit: null }),
    }));
    expect(stamp).toEqual({ version: "2.7.42", build: "dev", commit: "" });
  });
});

describe("comparing two builds", () => {
  test("the same commit is the same build", () => {
    expect(sameBuild(RELEASE, { ...RELEASE, build: "116" })).toBe(true);
  });

  test("a different commit is a different build even at the same version", () => {
    // The whole point: both of these call themselves v2.7.42.
    expect(NEXT.version).toBe(RELEASE.version);
    expect(sameBuild(RELEASE, NEXT)).toBe(false);
  });

  test("a stamped build and an unstamped one are not the same", () => {
    // The upgrade case as it actually happened: the older install predates the
    // stamp entirely, so it reports no commit at all.
    expect(sameBuild(RELEASE, { version: "2.7.42", build: "dev", commit: "" })).toBe(false);
  });

  test("two unstamped local builds are assumed to be the same", () => {
    // A developer running the app against their own `ocx start` is doing it on
    // purpose, and there is nothing here that could tell them apart anyway.
    const dev = { version: "2.7.42", build: "dev", commit: "" };
    expect(sameBuild(dev, dev)).toBe(true);
  });
});

describe("planning what to do with the port", () => {
  test("nothing listening means spawn our own", () => {
    expect(planProxyAdoption(null, RELEASE)).toEqual({ action: "spawn" });
  });

  test("a foreign service on the port is not an opencodex", () => {
    expect(planProxyAdoption({ status: "ok", service: "grafana" }, RELEASE)).toEqual({ action: "spawn" });
  });

  test("our own build is adopted, exactly as before", () => {
    expect(planProxyAdoption(healthz(RELEASE), RELEASE)).toEqual({ action: "adopt", pid: 4242 });
  });

  test("the previous version of the app is a conflict, not an adoption", () => {
    const plan = planProxyAdoption(healthz(RELEASE), NEXT);
    expect(plan.action).toBe("conflict");
    expect(plan.pid).toBe(4242);
    expect(plan.theirs).toEqual(RELEASE);
  });

  test("a proxy from before the stamp existed is a conflict", () => {
    // No `build` and no `commit` in the body at all — an older install answering
    // the same route. This is the exact shape that used to be adopted silently.
    const plan = planProxyAdoption(healthz(), RELEASE);
    expect(plan.action).toBe("conflict");
    expect(plan.theirs).toEqual({ version: "2.7.42", build: "dev", commit: "" });
  });

  test("a missing pid does not turn a conflict into an adoption", () => {
    const plan = planProxyAdoption({ ...healthz(), pid: undefined }, NEXT);
    expect(plan.action).toBe("conflict");
    expect(plan.pid).toBeNull();
  });
});

describe("what the user is told", () => {
  test("both builds are named, because that is what could not be found out before", () => {
    const text = describeConflict(NEXT, RELEASE, 10100);
    expect(text).toContain("port 10100");
    // Two builds of the same version have to be distinguishable in the copy, or
    // the dialog reproduces the complaint it exists to answer.
    expect(text).toContain("build 116");
    expect(text).toContain("build 117");
    expect(text).toContain("1e4ba4ea6");
  });

  test("an unstamped build is called a local build rather than given a number", () => {
    const text = describeConflict(RELEASE, { version: "2.7.42", build: "dev", commit: "" }, 10100);
    expect(text).toContain("local build");
    expect(text).not.toContain("build dev");
  });
});
