import { describe, expect, test } from "bun:test";
import { directProxyEnv, proxyStartArgv, servicePinnedPort, serviceStartArgv } from "../src/lib/proxy-launch";
import { defaultProxyReadinessStabilityMs, waitForProxyIdentity } from "../src/cli/proxy-readiness";
import type { LiveProxy } from "../src/server/proxy-liveness";

describe("proxy launch policy", () => {
  test("automatic starts are soft while explicit starts remain hard-pinned", () => {
    expect(proxyStartArgv("cli.ts")).toEqual(["cli.ts", "start"]);
    expect(proxyStartArgv("cli.ts", 13337)).toEqual(["cli.ts", "start", "--port", "13337"]);
  });

  test("direct children remove an inherited service marker without mutating the parent env", () => {
    const parent = { OCX_SERVICE: "1", OPENCODEX_HOME: "C:\\ocx" };
    const child = directProxyEnv(parent);

    expect(child.OCX_SERVICE).toBeUndefined();
    expect(child.OPENCODEX_HOME).toBe("C:\\ocx");
    expect(parent.OCX_SERVICE).toBe("1");
  });

  test("detached update helpers use a background marker instead of claiming service ownership", async () => {
    const [notify, job, update] = await Promise.all([
      Bun.file(new URL("../src/update/notify.ts", import.meta.url)).text(),
      Bun.file(new URL("../src/update/job.ts", import.meta.url)).text(),
      Bun.file(new URL("../src/update/index.ts", import.meta.url)).text(),
    ]);
    expect(notify).toContain('OCX_BACKGROUND: "1"');
    expect(job).toContain('OCX_BACKGROUND: "1"');
    expect(notify).not.toContain('OCX_SERVICE: "1"');
    expect(job).not.toContain('OCX_SERVICE: "1"');
    expect(update).toContain('process.env.OCX_BACKGROUND === "1"');
  });

  test("normal service assets are soft and OCX_BAKE_PORT remains an update-only pin", () => {
    expect(servicePinnedPort({ env: {} })).toBeUndefined();
    expect(serviceStartArgv("cli.ts", { env: {} })).toEqual(["cli.ts", "start"]);
    expect(serviceStartArgv("cli.ts", { env: { OCX_BAKE_PORT: "14444" } })).toEqual([
      "cli.ts", "start", "--port", "14444",
    ]);
    expect(serviceStartArgv("cli.ts", {
      env: { OCX_BAKE_PORT: "14444" },
      pinnedPort: null,
    })).toEqual(["cli.ts", "start"]);
  });
});

describe("proxy launch readiness", () => {
  test("a direct launch ignores a racing proxy and accepts only its child PID", async () => {
    let now = 0;
    const seen: Array<LiveProxy | null> = [
      { pid: 111, port: 10100, hostname: "127.0.0.1", source: "runtime" },
      { pid: 222, port: 49152, hostname: "127.0.0.1", source: "runtime" },
      { pid: 222, port: 49152, hostname: "127.0.0.1", source: "runtime" },
      { pid: 222, port: 49152, hostname: "127.0.0.1", source: "runtime" },
    ];

    const live = await waitForProxyIdentity({
      expectedPid: 222,
      timeoutMs: 100,
      intervalMs: 10,
      stabilityMs: 20,
      now: () => now,
      sleep: async ms => { now += ms; },
      findLive: async () => seen.shift() ?? null,
    });

    expect(live).toMatchObject({ pid: 222, port: 49152 });
  });

  test("one healthy sample is not enough and the stability window scales within bounds", async () => {
    expect(defaultProxyReadinessStabilityMs(8_000, 150)).toBe(400);
    expect(defaultProxyReadinessStabilityMs(35_000, 200)).toBe(1_500);

    let now = 0;
    const stable = { pid: 222, port: 49152, hostname: "127.0.0.1", source: "runtime" } as const;
    const seen: Array<LiveProxy | null> = [stable, null, stable, stable, stable];
    const live = await waitForProxyIdentity({
      expectedPid: 222,
      timeoutMs: 100,
      intervalMs: 10,
      stabilityMs: 20,
      now: () => now,
      sleep: async ms => { now += ms; },
      findLive: async () => seen.shift() ?? null,
    });
    expect(live).toMatchObject({ pid: 222, port: 49152 });
    expect(now).toBe(40);
  });

  test("returns null when identity health never appears", async () => {
    let now = 0;
    expect(await waitForProxyIdentity({
      timeoutMs: 30,
      intervalMs: 10,
      now: () => now,
      sleep: async ms => { now += ms; },
      findLive: async () => null,
    })).toBeNull();
  });
});
