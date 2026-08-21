import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  classifyDesktopHealth,
  normalizeDesktopProbeHostname,
  parseDesktopPort,
  planDesktopStartup,
  readDesktopPortState,
  runFixedNativeRestore,
} from "../electron/startup-recovery.mjs";

const BUILD = { version: "2.7.42", build: "230", commit: "dc9401145e99c1dc6a5e981e257575749a38f882" };
const OTHER = { version: "2.7.42", build: "229", commit: "oldoldoldoldoldoldoldoldoldoldoldoldoldoldoldold" };

describe("desktop startup recovery", () => {
  test("accepts only integer ports in the inclusive TCP range", () => {
    expect(parseDesktopPort("10100")).toBe(10100);
    expect(parseDesktopPort(" 10100 ")).toBe(10100);
    expect(parseDesktopPort(1)).toBe(1);
    expect(parseDesktopPort(65535)).toBe(65535);
    for (const value of ["0", "65536", "10100.5", "1e3", "", null, undefined, 10100.5, NaN, Infinity]) {
      expect(parseDesktopPort(value)).toBeUndefined();
    }
  });

  test("reads runtime-port and configured candidates without trusting malformed state", () => {
    const files = new Map([
      ["C:\\state\\runtime-port.json", JSON.stringify({ pid: 4242, port: 4123, hostname: "127.0.0.1" })],
      ["C:\\state\\config.json", JSON.stringify({ port: 10100, hostname: "127.0.0.1" })],
    ]);
    const state = readDesktopPortState({
      env: { OPENCODEX_HOME: "C:\\state", OPENCODEX_PORT: "10100.5" },
      home: "C:\\Users\\tester",
      readFile: path => files.get(path) ?? (() => { throw new Error("ENOENT"); })(),
    });
    expect(state.candidates).toEqual([4123, 10100]);
    expect(state.hardPin).toBeUndefined();
    expect(state.runtime).toEqual({ pid: 4242, port: 4123, hostname: "127.0.0.1" });
  });

  test("puts a valid hard pin first and keeps the soft candidates behind it", () => {
    const state = readDesktopPortState({
      env: { OPENCODEX_HOME: "C:\\state", OPENCODEX_PORT: "4555" },
      home: "C:\\Users\\tester",
      readFile: path => path.endsWith("runtime-port.json")
        ? JSON.stringify({ pid: 4242, port: 4123 })
        : JSON.stringify({ port: 10100 }),
    });
    expect(state.hardPin).toBe(4555);
    expect(state.candidates).toEqual([4555, 4123, 10100]);
  });

  test("only local and bind-any hostnames are eligible for desktop probes", () => {
    expect(normalizeDesktopProbeHostname(undefined)).toBe("127.0.0.1");
    expect(normalizeDesktopProbeHostname("0.0.0.0")).toBe("127.0.0.1");
    expect(normalizeDesktopProbeHostname("::")).toBe("127.0.0.1");
    expect(normalizeDesktopProbeHostname("localhost")).toBe("127.0.0.1");
    expect(normalizeDesktopProbeHostname("192.168.1.50")).toBeUndefined();
    expect(normalizeDesktopProbeHostname("example.test")).toBeUndefined();
  });

  test("configured LAN hostnames are not promoted into desktop fetch targets", () => {
    const state = readDesktopPortState({
      env: { OPENCODEX_HOME: "C:\\state" },
      home: "C:\\Users\\tester",
      readFile: path => path.endsWith("config.json")
        ? JSON.stringify({ port: 10100, hostname: "192.168.1.50" })
        : (() => { throw new Error("ENOENT"); })(),
    });
    expect(state.configuredPort).toBe(10100);
    expect(state.configuredHostname).toBeUndefined();
  });

  test("adopts only a healthy same-build owner and never plans a stop", () => {
    const plan = planDesktopStartup({
      candidates: [4123, 10100],
      hardPin: undefined,
      healthByPort: new Map([[4123, { service: "opencodex", ...BUILD, pid: 4242 }]]),
      stamp: BUILD,
    });
    expect(plan).toEqual({ action: "adopt", port: 4123, pid: 4242, needsRestore: false });
    expect(JSON.stringify(plan)).not.toContain("kill");
    expect(JSON.stringify(plan)).not.toContain("stop");
  });

  test("keeps an old or foreign listener untouched and uses unpinned recovery", () => {
    const plan = planDesktopStartup({
      candidates: [10100],
      hardPin: undefined,
      healthByPort: new Map([[10100, { service: "opencodex", ...OTHER, pid: 5151 }]]),
      stamp: BUILD,
    });
    expect(plan).toEqual({ action: "restore-and-spawn", pinnedPort: undefined, occupiedPort: 10100, needsRestore: true });
    expect(JSON.stringify(plan)).not.toContain("kill");
    expect(JSON.stringify(plan)).not.toContain("stop");
  });

  test("a free hard pin remains pinned after restore, while no pin stays soft", () => {
    expect(planDesktopStartup({
      candidates: [4555, 10100],
      hardPin: 4555,
      healthByPort: new Map(),
      stamp: BUILD,
    })).toEqual({ action: "restore-and-spawn", pinnedPort: 4555, occupiedPort: undefined, needsRestore: true });
    expect(planDesktopStartup({
      candidates: [10100],
      hardPin: undefined,
      healthByPort: new Map(),
      stamp: BUILD,
    })).toEqual({ action: "restore-and-spawn", pinnedPort: undefined, occupiedPort: undefined, needsRestore: true });
  });

  test("reports uncertain ownership instead of taking a hard-pinned port", () => {
    const plan = planDesktopStartup({
      candidates: [10100],
      hardPin: 10100,
      healthByPort: new Map([[10100, { status: "ok", version: "2.7.42", uptime: 12 }]]),
      stamp: BUILD,
    });
    expect(plan.action).toBe("blocked");
    expect(plan.reason).toContain("ownership");
    expect(plan.reason).toContain("10100");
  });

  test("treats an unreachable candidate as restore-before-unpinned-spawn", () => {
    expect(classifyDesktopHealth(null, BUILD)).toEqual({ action: "spawn" });
    expect(planDesktopStartup({
      candidates: [10100],
      hardPin: undefined,
      healthByPort: new Map(),
      stamp: BUILD,
    })).toEqual({ action: "restore-and-spawn", pinnedPort: undefined, occupiedPort: undefined, needsRestore: true });
  });

  test("runs only the fixed argument-free native restore operation", async () => {
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    const result = await runFixedNativeRestore({
      execPath: "electron.exe",
      launcherPath: "bin/ocx.mjs",
      spawnFn: (execPath, argv, options) => {
        expect(execPath).toBe("electron.exe");
        expect(argv).toEqual(["bin/ocx.mjs", "restore"]);
        expect(options.env.ELECTRON_RUN_AS_NODE).toBe("1");
        queueMicrotask(() => child.emit("close", 0, null));
        return child;
      },
      timeoutMs: 100,
    });
    expect(result.ok).toBe(true);
  });

  test("maps restore child output and paths to bounded safe diagnostics", async () => {
    const child = new EventEmitter() as EventEmitter & { kill: () => void };
    child.kill = () => {};
    const result = await runFixedNativeRestore({
      execPath: "electron.exe",
      launcherPath: "bin/ocx.mjs",
      spawnFn: () => {
        queueMicrotask(() => child.emit("close", 7, null));
        return child;
      },
      timeoutMs: 100,
    });
    expect(result).toEqual({ ok: false, error: "Native Codex restore failed with exit code 7." });
    expect(JSON.stringify(result)).not.toContain("C:\\Users");
    expect(JSON.stringify(result)).not.toContain("stderr");
  });

  test("the Electron startup path restores before spawning and never kills a candidate pid", () => {
    const main = readFileSync(join(import.meta.dir, "..", "electron", "main.mjs"), "utf8");
    const restore = main.indexOf("const restore = await runFixedNativeRestore");
    const spawn = main.indexOf("proxy = spawnProxy(plan.pinnedPort)");
    expect(restore).toBeGreaterThanOrEqual(0);
    expect(spawn).toBeGreaterThan(restore);
    expect(main).not.toContain("process.kill(plan.pid");
  });
});
