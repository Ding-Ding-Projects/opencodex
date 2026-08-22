import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cliPath = resolve(import.meta.dir, "../src/cli/index.ts");
const cliSource = readFileSync(cliPath, "utf8");
const roots: string[] = [];
const children: Array<ReturnType<typeof Bun.spawn>> = [];

type Fixture = {
  root: string;
  codexHome: string;
  ocxHome: string;
  configPath: string;
  journalPath: string;
  pidPath: string;
  runtimePath: string;
  env: Record<string, string>;
};

function fixture(port = 0): Fixture {
  const root = mkdtempSync(join(tmpdir(), "ocx-start-owner-"));
  roots.push(root);
  const codexHome = join(root, "codex");
  const ocxHome = join(root, "ocx");
  const home = join(root, "home");
  const runtime = join(root, "runtime");
  for (const path of [codexHome, ocxHome, home, runtime]) mkdirSync(path, { recursive: true });
  const configPath = join(codexHome, "config.toml");
  const journalPath = join(codexHome, "opencodex-journal.json");
  const pidPath = join(ocxHome, "ocx.pid");
  const runtimePath = join(ocxHome, "runtime-port.json");
  writeFileSync(join(ocxHome, "config.json"), JSON.stringify({
    port,
    hostname: "127.0.0.1",
    codexAutoStart: false,
    syncResumeHistory: false,
    clientIntegrations: { codex: false, grok: false, "claude-desktop": false },
    claudeCode: { systemEnv: false },
    providers: {},
    defaultProvider: "openai",
  }));
  return {
    root,
    codexHome,
    ocxHome,
    configPath,
    journalPath,
    pidPath,
    runtimePath,
    env: {
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: codexHome,
      OPENCODEX_HOME: ocxHome,
      XDG_RUNTIME_DIR: runtime,
      NO_PROXY: "127.0.0.1,localhost",
    },
  };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unable to reserve a test port");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function arrangeRecoverableJournal(fx: Fixture): { original: string; injected: string } {
  const original = '# original\nmodel_provider = "openai"\n';
  const injected = '# injected\nmodel_provider = "opencodex"\n';
  writeFileSync(fx.configPath, injected);
  writeFileSync(fx.journalPath, JSON.stringify({
    version: 1,
    originalConfig: Buffer.from(original).toString("base64"),
    originalProfile: null,
    pid: 999_999,
    timestamp: new Date().toISOString(),
  }));
  return { original, injected };
}

async function runCli(fx: Fixture, argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, cliPath, ...argv], {
    cwd: fx.root,
    env: fx.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(child);
  const completed = await Promise.race([
    Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`CLI watchdog: ocx ${argv.join(" ")}`)), 10_000)),
  ]);
  return { exitCode: completed[0], stdout: completed[1], stderr: completed[2] };
}

async function waitFor<T>(read: () => T | null | Promise<T | null>, label: string): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function startOwner(fx: Fixture): Promise<ReturnType<typeof Bun.spawn>> {
  const child = Bun.spawn([process.execPath, cliPath, "start"], {
    cwd: fx.root,
    env: fx.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(child);
  const runtime = await waitFor(() => {
    if (!existsSync(fx.runtimePath)) return null;
    try {
      const value = JSON.parse(readFileSync(fx.runtimePath, "utf8")) as { pid?: number; port?: number };
      return value.pid === child.pid && typeof value.port === "number" && value.port > 0 ? value : null;
    } catch {
      return null;
    }
  }, "owner runtime record");
  await waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${runtime.port}/healthz`, { signal: AbortSignal.timeout(500) });
      const body = await response.json() as { pid?: number };
      return response.ok && body.pid === child.pid ? true : null;
    } catch {
      return null;
    }
  }, "owner health");
  return child;
}

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
  while (children.length) {
    const child = children.pop()!;
    if (child.exitCode === null) await child.exited;
  }
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("start and ensure journal ownership (#1230)", () => {
  test("stale ownership cleanup compares both preflight snapshots before journal recovery", () => {
    const helperStart = cliSource.indexOf("async function findProxyOwnerBeforeJournalRecovery(");
    const helperEnd = cliSource.indexOf("async function handleStart(", helperStart);
    expect(helperStart).toBeGreaterThanOrEqual(0);
    expect(helperEnd).toBeGreaterThan(helperStart);
    const helper = cliSource.slice(helperStart, helperEnd);
    expect(helper).toContain("const pidSnapshot = readPidFileValue();");
    expect(helper).toContain("const runtimeSnapshot = readRuntimePort();");
    expect(helper).toContain("const pidPurged = removePidIfValueIs(pidSnapshot);");
    expect(helper).toContain("const runtimePurged = removeRuntimePortIfValueIs(runtimeSnapshot);");
    expect(helper).toContain("!pidPurged || !runtimePurged || readPidFileValue() !== null || readRuntimePort() !== null");
    expect(helper.indexOf("const runtimePurged = removeRuntimePortIfValueIs(runtimeSnapshot);")).toBeLessThan(helper.indexOf("await reconcileJournalAsync();"));
  });

  test("a healthy proxy owner preserves the journal for both start and ensure", async () => {
    const fx = fixture();
    const owner = await startOwner(fx);
    try {
      const { injected } = arrangeRecoverableJournal(fx);

      const start = await runCli(fx, ["start"]);
      expect(start.exitCode).toBe(1);
      expect(start.stderr).toContain("Proxy already running");
      expect(readFileSync(fx.configPath, "utf8")).toBe(injected);
      expect(existsSync(fx.journalPath)).toBe(true);

      const ensure = await runCli(fx, ["ensure"]);
      expect(ensure.exitCode).toBe(0);
      expect(ensure.stdout).toContain("Codex autostart is disabled");
      expect(readFileSync(fx.configPath, "utf8")).toBe(injected);
      expect(existsSync(fx.journalPath)).toBe(true);
      expect(readFileSync(fx.pidPath, "utf8")).toBe(String(owner.pid));
    } finally {
      owner.kill("SIGTERM");
      await owner.exited;
    }
  }, 30_000);

  test("the configured listener preserves a live owner's journal when both ownership files are missing", async () => {
    const fx = fixture(await freePort());
    const owner = await startOwner(fx);
    try {
      rmSync(fx.pidPath, { force: true });
      rmSync(fx.runtimePath, { force: true });
      const { injected } = arrangeRecoverableJournal(fx);

      const start = await runCli(fx, ["start"]);
      expect(start.exitCode).toBe(1);
      expect(start.stderr).toContain("Proxy already running");
      expect(readFileSync(fx.configPath, "utf8")).toBe(injected);
      expect(existsSync(fx.journalPath)).toBe(true);

      const ensure = await runCli(fx, ["ensure"]);
      expect(ensure.exitCode).toBe(0);
      expect(ensure.stdout).toContain("Codex autostart is disabled");
      expect(readFileSync(fx.configPath, "utf8")).toBe(injected);
      expect(existsSync(fx.journalPath)).toBe(true);
      expect(owner.exitCode).toBeNull();
    } finally {
      owner.kill("SIGTERM");
      await owner.exited;
    }
  }, 30_000);

  test("a dead owner is recovered and its stale PID is removed for both start and ensure", async () => {
    for (const command of ["start", "ensure"] as const) {
      const fx = fixture();
      const { original } = arrangeRecoverableJournal(fx);
      writeFileSync(fx.pidPath, "999999");

      if (command === "ensure") {
        const result = await runCli(fx, [command]);
        expect(result.exitCode).toBe(0);
      } else {
        const child = Bun.spawn([process.execPath, cliPath, command], {
          cwd: fx.root,
          env: fx.env,
          stdout: "pipe",
          stderr: "pipe",
        });
        children.push(child);
        try {
          await waitFor(
            () => !existsSync(fx.journalPath) && existsSync(fx.configPath) && readFileSync(fx.configPath, "utf8") === original ? true : null,
            "dead-owner journal recovery",
          );
        } finally {
          child.kill("SIGTERM");
          await child.exited;
        }
      }

      expect(readFileSync(fx.configPath, "utf8")).toBe(original);
      expect(existsSync(fx.journalPath)).toBe(false);
      expect(existsSync(fx.pidPath)).toBe(false);
    }
  }, 30_000);
});
