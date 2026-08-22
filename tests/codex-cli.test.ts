import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { cmdCodex, codexNotFoundHint, ensureProxyForCodex, type CodexCliDeps } from "../src/cli/codex";

function fakeChild(onSpawn?: () => void): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.unref = () => child;
  queueMicrotask(() => {
    onSpawn?.();
    child.emit("exit", 0, null);
  });
  return child;
}

describe("ocx codex", () => {
  test("starts the proxy on the configured port when needed", async () => {
    let probes = 0;
    let spawned: { file: string; args: readonly string[]; options: Record<string, unknown> } | null = null;
    const port = await ensureProxyForCodex({
      findLiveProxy: async () => (++probes === 1 ? null : { port: 43141 }) as never,
      execPath: "bun-runtime",
      cliPath: "cli-entry.ts",
      sleep: async () => {},
      spawn: ((file: string, args: readonly string[], options: Record<string, unknown>) => {
        spawned = { file, args, options };
        return fakeChild();
      }) as never,
    });

    expect(port).toBe(43141);
    expect(spawned).toMatchObject({
      file: "bun-runtime",
      args: ["cli-entry.ts", "start"],
      options: { detached: true, stdio: "ignore", windowsHide: true },
    });
  });

  test("waits beyond the old eight-second limit for a delayed healthy start", async () => {
    let now = 0;
    const child = new EventEmitter() as ChildProcess;
    child.unref = () => child;
    const port = await ensureProxyForCodex({
      findLiveProxy: async () => now >= 9_000 ? ({ port: 43143 } as never) : null,
      now: () => now,
      sleep: async ms => { now += ms; },
      startupTimeoutMs: 10_000,
      spawn: (() => child) as never,
    });

    expect(port).toBe(43143);
  });

  test("returns promptly when the proxy child emits a spawn error", async () => {
    let probes = 0;
    const child = new EventEmitter() as ChildProcess;
    child.unref = () => child;

    const port = await ensureProxyForCodex({
      findLiveProxy: async () => { probes += 1; return null; },
      sleep: async () => {},
      spawn: (() => {
        queueMicrotask(() => child.emit("error", Object.assign(new Error("spawn failed"), { code: "ENOENT" })));
        return child;
      }) as never,
    });

    expect(port).toBeNull();
    expect(probes).toBeLessThan(3);
  });

  test("returns promptly when the proxy child exits before becoming healthy", async () => {
    let probes = 0;
    const child = new EventEmitter() as ChildProcess;
    child.unref = () => child;

    const port = await ensureProxyForCodex({
      findLiveProxy: async () => { probes += 1; return null; },
      sleep: async () => {},
      spawn: (() => {
        queueMicrotask(() => child.emit("exit", 1, null));
        return child;
      }) as never,
    });

    expect(port).toBeNull();
    expect(probes).toBeLessThan(3);
  });

  test("kills its own startup child at timeout so it cannot start late", async () => {
    let now = 0;
    let killed = false;
    const child = new EventEmitter() as ChildProcess;
    child.unref = () => child;
    child.kill = () => { killed = true; return true; };

    const port = await ensureProxyForCodex({
      findLiveProxy: async () => null,
      now: () => now,
      sleep: async ms => { now += ms; },
      startupTimeoutMs: 500,
      spawn: (() => child) as never,
    });

    expect(port).toBeNull();
    expect(killed).toBeTrue();
  });

  test("syncs the live port and forwards every Codex argument", async () => {
    const calls: Array<{ file: string; args: readonly string[]; stdio: unknown }> = [];
    const deps: CodexCliDeps = {
      platform: "linux",
      findLiveProxy: async () => ({ port: 43142 }) as never,
      syncModelsToCodex: (async port => {
        expect(port).toBe(43142);
        return { ok: true } as never;
      }) as never,
      resolveRuntime: (() => ({
        runtime: { command: "/opt/codex", version: "1.2.3", source: "configured" },
        failures: [],
      })) as never,
      spawn: ((file: string, args: readonly string[], options: { stdio?: unknown }) => {
        calls.push({ file, args, stdio: options.stdio });
        return fakeChild();
      }) as never,
    };

    const result = await cmdCodex(["exec", "hello world", "--help", "help"], deps);

    expect(result).toBe(0);
    expect(calls).toEqual([{
      file: "/opt/codex",
      args: ["exec", "hello world", "--help", "help"],
      stdio: "inherit",
    }]);
  });

  test("reports Windows command-not-found without masking signal exits", () => {
    expect(codexNotFoundHint(9009, null, "win32")).toContain("Codex CLI not found");
    expect(codexNotFoundHint(9009, "SIGTERM", "win32")).toBeNull();
    expect(codexNotFoundHint(9009, null, "linux")).toBeNull();
  });
});
