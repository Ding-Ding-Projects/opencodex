import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, test } from "bun:test";
import { cmdCodex, codexNotFoundHint, type CodexLaunchDeps } from "../src/cli/codex";

function child(pid: number): ChildProcess {
  const value = new EventEmitter() as ChildProcess;
  value.pid = pid;
  value.unref = () => value;
  value.kill = () => true;
  return value;
}

function syncResult(ok = true) {
  return {
    ok,
    added: 0,
    catalogPath: null,
    catalogExists: false,
    catalogWritten: false,
    cacheSynced: false,
    message: ok ? "synced" : "sync rejected",
  };
}

function runtime(command = "/trusted/codex") {
  return {
    runtime: { command, version: "0.145.0", source: "environment" as const },
    failures: [],
  };
}

function fakeProcess() {
  const events = new EventEmitter();
  const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  return {
    process: {
      on: events.on.bind(events),
      removeListener: events.removeListener.bind(events),
      kill: (pid: number, signal: NodeJS.Signals) => {
        killed.push({ pid, signal });
        return true;
      },
      exitCode: undefined,
    } as unknown as CodexLaunchDeps["process"],
    killed,
  };
}

describe("ocx codex launcher", () => {
  test("adopts the healthy proxy, syncs its actual port, and forwards tail argv unchanged", async () => {
    const launched: { file: string; args: string[]; options: Record<string, unknown> }[] = [];
    const fake = fakeProcess();
    const native = child(902);
    const deps: CodexLaunchDeps = {
      findLiveProxy: async () => ({ pid: 901, port: 4123, hostname: "127.0.0.1", source: "runtime" }),
      syncModelsToCodex: async port => {
        expect(port).toBe(4123);
        return syncResult();
      },
      resolveCodexRuntime: () => runtime(),
      codexExecInvocation: (command, args) => ({ file: command, args: [...args], options: {} }),
      platform: "linux",
      spawn: ((file, args, options) => {
        launched.push({ file, args, options: options as Record<string, unknown> });
        queueMicrotask(() => native.emit("exit", 23, null));
        return native;
      }) as typeof import("node:child_process").spawn,
      process: fake.process,
    };

    const tail = ["--help", "exec", "hello world", "--", "-h"];
    await expect(cmdCodex(tail, deps)).resolves.toBe(23);
    expect(launched).toEqual([{
      file: "/trusted/codex",
      args: tail,
      options: { stdio: "inherit" },
    }]);
  });

  test("does not launch native Codex when live-port sync fails", async () => {
    let launches = 0;
    const deps: CodexLaunchDeps = {
      findLiveProxy: async () => ({ pid: 901, port: 4123, source: "runtime" }),
      syncModelsToCodex: async () => syncResult(false),
      resolveCodexRuntime: () => runtime(),
      spawn: (() => {
        launches += 1;
        return child(902);
      }) as typeof import("node:child_process").spawn,
    };

    await expect(cmdCodex(["--version"], deps)).resolves.toBe(1);
    expect(launches).toBe(0);
  });

  test("does not launch native Codex when proxy startup never becomes healthy", async () => {
    let launches = 0;
    const proxyChild = child(901);
    const deps: CodexLaunchDeps = {
      findLiveProxy: async () => null,
      waitForProxyIdentity: async () => null,
      spawn: (() => {
        launches += 1;
        return proxyChild;
      }) as typeof import("node:child_process").spawn,
    };

    await expect(cmdCodex(["--version"], deps)).resolves.toBe(1);
    // One launch is the detached proxy attempt; Codex itself was never spawned.
    expect(launches).toBe(1);
  });

  test("forwards termination and mirrors the child signal exit", async () => {
    const fake = fakeProcess();
    const native = child(902);
    const deps: CodexLaunchDeps = {
      findLiveProxy: async () => ({ pid: 901, port: 4123, source: "runtime" }),
      syncModelsToCodex: async () => syncResult(),
      resolveCodexRuntime: () => runtime(),
      codexExecInvocation: (command, args) => ({ file: command, args: [...args], options: {} }),
      platform: "linux",
      spawn: (() => {
        queueMicrotask(() => native.emit("exit", null, "SIGTERM"));
        return native;
      }) as typeof import("node:child_process").spawn,
      process: fake.process,
    };

    await expect(cmdCodex([], deps)).resolves.toBe(143);
    expect(fake.killed).toHaveLength(1);
    expect(fake.killed[0]?.signal).toBe("SIGTERM");
  });
});

describe("codex not-found diagnostics", () => {
  test("only treats Windows cmd.exe's 9009 as installation failure", () => {
    expect(codexNotFoundHint(9009, null, "win32")).toContain("@openai/codex");
    expect(codexNotFoundHint(9009, "SIGTERM", "win32")).toBeNull();
    expect(codexNotFoundHint(9009, null, "linux")).toBeNull();
  });
});
