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

function emitSoon(value: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
  queueMicrotask(() => value.emit("exit", code, signal));
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
  const registered: string[] = [];
  return {
    process: {
      on: ((event: string, listener: (...args: unknown[]) => void) => {
        registered.push(event);
        events.on(event, listener);
        return events;
      }) as typeof events.on,
      removeListener: events.removeListener.bind(events),
      kill: (pid: number, signal: NodeJS.Signals) => {
        killed.push({ pid, signal });
        return true;
      },
      exitCode: undefined,
    } as unknown as CodexLaunchDeps["process"],
    events,
    killed,
    registered,
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

  test("starts a detached proxy, uses exact-child readiness, then syncs and launches in order", async () => {
    const order: string[] = [];
    const proxy = child(701);
    const native = child(702);
    const fake = fakeProcess();
    const launched: { file: string; args: string[]; options: Record<string, unknown> }[] = [];
    const deps: CodexLaunchDeps = {
      findLiveProxy: async () => {
        order.push("find");
        return null;
      },
      waitForProxyIdentity: async options => {
        order.push(options.expectedPid === proxy.pid ? "ready:child" : "ready:adopt");
        return { pid: proxy.pid, port: 4567, source: "runtime" };
      },
      spawn: ((file, args, options) => {
        if (args.includes("start")) {
          order.push("spawn:proxy");
          return proxy;
        }
        order.push("spawn:codex");
        launched.push({ file, args, options: options as Record<string, unknown> });
        emitSoon(native, 0, null);
        return native;
      }) as typeof import("node:child_process").spawn,
      syncModelsToCodex: async port => {
        order.push(`sync:${port}`);
        return syncResult();
      },
      resolveCodexRuntime: () => {
        order.push("resolve");
        return runtime();
      },
      codexExecInvocation: (command, args) => ({ file: command, args: [...args], options: {} }),
      platform: "linux",
      process: fake.process,
    };

    await expect(cmdCodex(["--version"], deps)).resolves.toBe(0);
    expect(order).toEqual(["find", "spawn:proxy", "ready:child", "sync:4567", "resolve", "spawn:codex"]);
    expect(launched[0]?.args).toEqual(["--version"]);
  });

  test("adopts a racing proxy after exact-child readiness expires", async () => {
    const order: string[] = [];
    const proxy = child(711);
    const native = child(712);
    const fake = fakeProcess();
    let readinessCalls = 0;
    const deps: CodexLaunchDeps = {
      findLiveProxy: async () => {
        order.push("find");
        return null;
      },
      waitForProxyIdentity: async options => {
        readinessCalls += 1;
        order.push(options.expectedPid === proxy.pid ? "ready:child" : "ready:adopt");
        return options.expectedPid === proxy.pid
          ? null
          : { pid: 799, port: 4568, source: "runtime" };
      },
      spawn: ((file, args) => {
        if (args.includes("start")) {
          order.push("spawn:proxy");
          return proxy;
        }
        order.push("spawn:codex");
        emitSoon(native, 0, null);
        return native;
      }) as typeof import("node:child_process").spawn,
      syncModelsToCodex: async port => {
        order.push(`sync:${port}`);
        return syncResult();
      },
      resolveCodexRuntime: () => {
        order.push("resolve");
        return runtime();
      },
      codexExecInvocation: (command, args) => ({ file: command, args: [...args], options: {} }),
      platform: "linux",
      process: fake.process,
    };

    await expect(cmdCodex([], deps)).resolves.toBe(0);
    expect(readinessCalls).toBe(2);
    expect(order).toEqual(["find", "spawn:proxy", "ready:child", "ready:adopt", "sync:4568", "resolve", "spawn:codex"]);
  });

  test("forwards parent SIGINT before the native child exits and mirrors SIGTERM", async () => {
    const fake = fakeProcess();
    const native = child(902);
    const childSignals: NodeJS.Signals[] = [];
    native.kill = signal => {
      childSignals.push(signal as NodeJS.Signals);
      return true;
    };
    const deps: CodexLaunchDeps = {
      findLiveProxy: async () => ({ pid: 901, port: 4123, source: "runtime" }),
      syncModelsToCodex: async () => syncResult(),
      resolveCodexRuntime: () => runtime(),
      codexExecInvocation: (command, args) => ({ file: command, args: [...args], options: {} }),
      platform: "linux",
      spawn: (() => {
        return native;
      }) as typeof import("node:child_process").spawn,
      process: fake.process,
    };

    const pending = cmdCodex([], deps);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    fake.events.emit("SIGINT");
    expect(childSignals).toEqual(["SIGINT"]);
    fake.events.emit("SIGTERM");
    expect(childSignals).toEqual(["SIGINT", "SIGTERM"]);
    native.emit("exit", null, "SIGTERM");
    await expect(pending).resolves.toBe(143);
    expect(fake.killed).toHaveLength(1);
    expect(fake.killed[0]?.signal).toBe("SIGTERM");
    expect(fake.registered).toEqual(["SIGINT", "SIGTERM", "SIGHUP"]);
  });

  test("refuses fallback and non-spawnable runtimes before native spawn", async () => {
    for (const selected of [
      { runtime: { command: "codex", version: null, source: "fallback" as const }, failures: [] },
      { runtime: { command: "C:\\Tools\\codex", version: "0.145.0", source: "configured" as const }, failures: [] },
    ]) {
      let launches = 0;
      const deps: CodexLaunchDeps = {
        findLiveProxy: async () => ({ pid: 901, port: 4123, source: "runtime" }),
        syncModelsToCodex: async () => syncResult(),
        resolveCodexRuntime: () => selected,
        spawn: (() => {
          launches += 1;
          return child(902);
        }) as typeof import("node:child_process").spawn,
        platform: "win32",
      };
      await expect(cmdCodex(["--version"], deps)).resolves.toBe(1);
      expect(launches).toBe(0);
    }
  });

  test("native ENOENT and ordinary spawn errors resolve once with diagnostics", async () => {
    for (const error of [
      Object.assign(new Error("missing"), { code: "ENOENT" }),
      Object.assign(new Error("permission denied"), { code: "EACCES" }),
    ]) {
      const fake = fakeProcess();
      const native = child(902);
      let resolves = 0;
      const originalError = console.error;
      const errors: string[] = [];
      console.error = (...parts: unknown[]) => errors.push(parts.map(String).join(" "));
      try {
        const deps: CodexLaunchDeps = {
          findLiveProxy: async () => ({ pid: 901, port: 4123, source: "runtime" }),
          syncModelsToCodex: async () => syncResult(),
          resolveCodexRuntime: () => runtime(),
          spawn: (() => native) as typeof import("node:child_process").spawn,
          platform: "linux",
          process: fake.process,
        };
        const pending = cmdCodex([], deps).then(value => {
          resolves += 1;
          return value;
        });
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        native.emit("error", error);
        native.emit("exit", 99, null);
        await expect(pending).resolves.toBe(1);
        expect(resolves).toBe(1);
        expect(errors.join("\n")).toContain(error.code === "ENOENT" ? "@openai/codex" : "permission denied");
      } finally {
        console.error = originalError;
      }
    }
  });

  test("uses Windows cmd invocation options and emits the 9009 install hint", async () => {
    for (const command of ["C:\\Tools\\codex.cmd", "C:\\Tools\\codex.bat"]) {
      const fake = fakeProcess();
      const native = child(902);
      let launched: { file: string; args: string[]; options: Record<string, unknown> } | undefined;
      const errors: string[] = [];
      const originalError = console.error;
      console.error = (...parts: unknown[]) => errors.push(parts.map(String).join(" "));
      try {
        const deps: CodexLaunchDeps = {
          findLiveProxy: async () => ({ pid: 901, port: 4123, source: "runtime" }),
          syncModelsToCodex: async () => syncResult(),
          resolveCodexRuntime: () => runtime(command),
          spawn: ((file, args, options) => {
            launched = { file, args, options: options as Record<string, unknown> };
            emitSoon(native, 9009, null);
            return native;
          }) as typeof import("node:child_process").spawn,
          platform: "win32",
          process: fake.process,
        };
        await expect(cmdCodex(["--version"], deps)).resolves.toBe(9009);
      } finally {
        console.error = originalError;
      }
      expect(launched?.file.toLowerCase()).toContain("cmd");
      expect(launched?.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
      expect(launched?.options.windowsVerbatimArguments).toBe(true);
      expect(errors.join("\n")).toContain("@openai/codex");
      expect(fake.registered).toEqual(["SIGINT", "SIGTERM"]);
    }
  });
});

describe("codex not-found diagnostics", () => {
  test("only treats Windows cmd.exe's 9009 as installation failure", () => {
    expect(codexNotFoundHint(9009, null, "win32")).toContain("@openai/codex");
    expect(codexNotFoundHint(9009, "SIGTERM", "win32")).toBeNull();
    expect(codexNotFoundHint(9009, null, "linux")).toBeNull();
  });
});
